/**
 * At-least-once inbox worker for the External Gateway.
 *
 * The worker serializes deliveries for one client/account/peer conversation
 * while allowing different conversations to proceed independently. A pending
 * row is always reloaded from storage before dispatch, which makes startup
 * recovery and repeated enqueue calls idempotent.
 * @module @deepseek-ai/dsh-external-gateway/worker
 */

import type {
  ExternalGatewayDispatchResult,
  ExternalGatewayRuntime,
  ExternalGatewayRuntimeEvent,
  GatewayDeliveryRecord,
  GatewayPayload,
  GatewayPeerIdentity,
  JsonValue,
} from './types.ts'
import type { GatewayClientId, GatewayDeliveryId, GatewayEventPayload } from './types.ts'
import { ExternalGatewayStore, dispatchRequestOf } from './storage.ts'

/** Runtime dependency and worker policy. */
export interface ExternalGatewayWorkerOptions {
  /** Durable gateway store. */
  readonly store: ExternalGatewayStore
  /** Existing DSH Session facade adapter. */
  readonly runtime: ExternalGatewayRuntime
  /** Fixed cwd supplied to every dispatch request. */
  readonly startupCwd: string
  /** Optional diagnostic sink; it must not receive bearer tokens. */
  readonly onError?: (error: unknown) => void
}

/** Snapshot of worker lifecycle useful to tests and health integrations. */
export interface ExternalGatewayWorkerState {
  readonly started: boolean
  readonly stopping: boolean
  readonly pending: number
}

function conversationKey(record: Pick<GatewayDeliveryRecord, 'clientId' | 'accountId' | 'peerId'>): string {
  return JSON.stringify([record.clientId, record.accountId, record.peerId])
}

function peerOf(record: GatewayDeliveryRecord): GatewayPeerIdentity {
  return { clientId: record.clientId, accountId: record.accountId, peerId: record.peerId }
}

function errorDetails(error: unknown): { readonly code: string; readonly message: string } {
  if (typeof error === 'object' && error !== null
    && 'code' in error && typeof error.code === 'string'
    && 'message' in error && typeof error.message === 'string') {
    return { code: error.code, message: error.message }
  }
  return { code: 'dispatch-failed', message: error instanceof Error ? error.message : String(error) }
}

function jsonObject(value: Record<string, JsonValue>): JsonValue {
  return value
}

function isAutoTarget(payload: GatewayPayload): boolean {
  return payload.type === 'message' && payload.sessionId === undefined
}

function mutationEvent(
  payload: GatewayPayload,
  sessionId: ExternalGatewayDispatchResult['sessionId'],
  result: ExternalGatewayDispatchResult['result'],
): GatewayEventPayload | undefined {
  if (sessionId === undefined) return undefined
  switch (payload.type) {
    case 'session-create': return { type: 'session-created', sessionId }
    case 'session-select': return { type: 'session-selected', sessionId }
    case 'session-rename': return { type: 'session-updated', sessionId, changes: jsonObject({ title: payload.title }) }
    case 'session-fork': return { type: 'session-created', sessionId }
    case 'model-select': return {
      type: 'session-updated',
      sessionId,
      changes: jsonObject({
        model: jsonObject({
          provider: payload.selection.provider,
          model: payload.selection.model,
          ...(payload.selection.reasoningEffort === undefined ? {} : { reasoningEffort: payload.selection.reasoningEffort }),
        }),
      }),
    }
    case 'permission-select': return { type: 'session-updated', sessionId, changes: jsonObject({ permissionPreset: payload.preset }) }
    case 'session-cancel': return { type: 'session-updated', sessionId, changes: jsonObject({ cancelled: true }) }
    case 'message':
    case 'command':
    case 'question-answer':
    case 'approval-answer':
    case 'subagent-followup':
    case 'subagent-interrupt':
      return undefined
    case 'session-export': {
      const artifactId = typeof result === 'object' && result !== null && !Array.isArray(result)
        && typeof result.artifactId === 'string' ? result.artifactId : undefined
      return artifactId === undefined ? undefined : { type: 'artifact-ready', sessionId, artifactId }
    }
    default: return undefined
  }
}

/**
 * Durable worker that drains inbox rows into a Session runtime.
 *
 * @param options - Store, runtime, and fixed cwd.
 */
export class ExternalGatewayWorker {
  private readonly store: ExternalGatewayStore
  private readonly runtime: ExternalGatewayRuntime
  private readonly startupCwd: string
  private readonly onError: (error: unknown) => void
  private readonly conversationTails = new Map<string, Promise<void>>()
  private readonly activeRuns = new Set<Promise<void>>()
  private runtimeEventTail: Promise<void> = Promise.resolve()
  private readonly pendingRuntimeEvents: ExternalGatewayRuntimeEvent[] = []
  private readonly abortController = new AbortController()
  private unsubscribeRuntime: (() => void) | undefined
  private started = false
  private stopping = false

  /**
   * @param options - Durable store and runtime adapter.
   */
  constructor(options: ExternalGatewayWorkerOptions) {
    this.store = options.store
    this.runtime = options.runtime
    this.startupCwd = options.startupCwd
    this.onError = options.onError ?? (() => {})
  }

  /** Current worker lifecycle and pending row count. */
  get state(): ExternalGatewayWorkerState {
    return {
      started: this.started,
      stopping: this.stopping,
      pending: this.store.listPendingDeliveries().length,
    }
  }

  /** Subscribe to runtime events and enqueue every durable pending row. */
  async start(): Promise<void> {
    if (this.started) return
    if (this.stopping) throw new Error('external gateway worker is stopping')
    this.started = true
    this.unsubscribeRuntime = this.runtime.subscribe(event => {
      const run = this.runtimeEventTail.then(() => this.persistRuntimeEvent(event))
      this.runtimeEventTail = run.then(() => undefined, () => undefined)
      void run.catch(error => this.report(error))
      return run
    })
    await this.runtime.replay()
    for (const record of this.store.listPendingDeliveries()) this.enqueue(record)
  }

  /** Re-scan pending inbox and runtime events after an outbox ack frees space. */
  async resumePending(): Promise<void> {
    if (this.stopping) return
    for (const record of this.store.listPendingDeliveries()) this.enqueue(record)
    for (const event of [...this.pendingRuntimeEvents]) {
      const run = this.runtimeEventTail.then(() => this.persistRuntimeEvent(event))
      this.runtimeEventTail = run.then(() => undefined, () => undefined)
      void run.catch(error => this.report(error))
    }
  }

  /** Stop admission, abort active runtime calls, and drain already scheduled work. */
  async close(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.unsubscribeRuntime?.()
    this.unsubscribeRuntime = undefined
    this.abortController.abort()
    await Promise.all([...this.activeRuns])
    await this.runtimeEventTail
  }

  /** Schedule one pending delivery while preserving conversation order. */
  enqueue(record: GatewayDeliveryRecord): void {
    if (this.stopping || record.status !== 'pending') return
    const key = conversationKey(record)
    const prior = this.conversationTails.get(key) ?? Promise.resolve()
    const run = prior.then(() => this.process(record.clientId, record.deliveryId))
    const settled = run.then(() => undefined, () => undefined)
    this.conversationTails.set(key, settled)
    this.activeRuns.add(settled)
    void run.catch(error => this.report(error))
    void settled.finally(() => {
      this.activeRuns.delete(settled)
      if (this.conversationTails.get(key) === settled) this.conversationTails.delete(key)
    }).catch(error => this.report(error))
  }

  private async process(clientId: GatewayClientId, deliveryId: GatewayDeliveryId): Promise<void> {
    const initial = this.store.getDelivery(clientId, deliveryId)
    if (initial === undefined || initial.status !== 'pending') return
    const prepared = await this.store.reserveSessionForDelivery(clientId, deliveryId)
    const started = await this.store.beginDelivery(clientId, deliveryId)
    if (started.status !== 'pending') return
    const request = dispatchRequestOf(prepared.record, this.startupCwd)
    let result: ExternalGatewayDispatchResult
    try {
      result = await this.runtime.dispatch(request, this.abortController.signal)
    } catch (error) {
      if (this.stopping || this.abortController.signal.aborted) return
      const failure = errorDetails(error)
      await this.appendDeliveryEvent(prepared.record, {
        type: 'delivery-failed',
        deliveryId,
        code: failure.code,
        message: failure.message,
      })
      await this.store.failDelivery(clientId, deliveryId, failure.code, failure.message)
      return
    }

    try {
      const peer = peerOf(prepared.record)
      if (result.sessionId !== undefined) {
        if (!this.store.ownsSession(peer, result.sessionId)) await this.store.claimSession(peer, result.sessionId)
        await this.store.markSessionReady(peer, result.sessionId, this.shouldSelect(prepared.record.payload))
      }
      // All events are durable before the inbox is marked completed. A crash
      // between these writes may duplicate events after restart, but cannot
      // acknowledge a delivery whose completion event was lost.
      await this.appendDeliveryEvent(prepared.record, {
        type: 'delivery-completed',
        deliveryId,
        ...(result.result === undefined ? {} : { result: result.result as JsonValue }),
      }, result.sessionId)
      const changed = mutationEvent(prepared.record.payload, result.sessionId, result.result)
      if (changed !== undefined) await this.appendDeliveryEvent(prepared.record, changed, result.sessionId)
      if (this.stopping || this.abortController.signal.aborted) return
      await this.store.completeDelivery(clientId, deliveryId, result.result)
    } catch (error) {
      if (this.stopping || this.abortController.signal.aborted) return
      const failure = errorDetails(error)
      await this.appendDeliveryEvent(prepared.record, {
        type: 'delivery-failed',
        deliveryId,
        code: failure.code,
        message: failure.message,
      })
      await this.store.failDelivery(clientId, deliveryId, failure.code, failure.message)
    }
  }

  private shouldSelect(payload: GatewayPayload): boolean {
    return payload.type === 'session-create'
      || payload.type === 'session-select'
      || payload.type === 'session-fork'
      || isAutoTarget(payload)
  }

  private async appendDeliveryEvent(
    record: GatewayDeliveryRecord,
    payload: GatewayEventPayload,
    sessionId?: ExternalGatewayDispatchResult['sessionId'],
  ): Promise<void> {
    await this.store.appendEvent(
      record.clientId,
      record,
      payload,
      { ...(sessionId === undefined ? {} : { sessionId }), causedByDeliveryId: record.deliveryId },
    )
  }

  private async persistRuntimeEvent(event: ExternalGatewayRuntimeEvent): Promise<void> {
    if (event.sourceSequence !== undefined
      && event.sourceSequence <= this.store.projectedSequence(event.sessionId)) return
    if (!this.pendingRuntimeEvents.includes(event)) this.pendingRuntimeEvents.push(event)
    let lastError: unknown
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        if (event.interaction !== undefined) {
          await this.store.saveInteraction({ ...event.interaction, status: 'pending' })
        }
        await this.store.appendEvent(event.clientId, event, event.payload, {
          sessionId: event.sessionId,
        })
        if (event.sourceSequence !== undefined) {
          await this.store.markProjected(event.sessionId, event.sourceSequence)
        }
        const index = this.pendingRuntimeEvents.indexOf(event)
        if (index !== -1) this.pendingRuntimeEvents.splice(index, 1)
        return
      } catch (error) {
        lastError = error
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(1000, 25 * 2 ** attempt)))
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private report(error: unknown): void {
    try {
      this.onError(error)
    } catch {
      // Diagnostics must not become an unhandled worker rejection.
    }
  }
}
