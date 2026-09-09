/**
 * External Gateway 的至少一次投递 inbox worker。
 *
 * worker 将同一客户端、账号和 peer 对话的投递串行化，
 * 同时允许不同对话独立推进。调度前始终
 * 从存储重新加载 pending 记录，使启动恢复和
 * 重复入队调用保持幂等。
 * @module @deepseek-ai/dsh-external-gateway/worker
 */

import type { GatewayDraft } from './construction-types.ts'
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

/** 运行时依赖和 worker 策略。 */
export interface ExternalGatewayWorkerOptions {
  /** 持久化网关存储。 */
  readonly store: ExternalGatewayStore
  /** 现有 DSH Session 封装层适配器。 */
  readonly runtime: ExternalGatewayRuntime
  /** 每次调度请求携带的固定 cwd。 */
  readonly startupCwd: string
  /** 可选的诊断接收端，绝不能接收 Bearer Token。 */
  readonly onError?: (error: unknown) => void
}

/** 供测试和健康检查集成使用的 worker 生命周期快照。 */
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
    case 'model-select': {
      const model: Record<string, JsonValue> = {
        provider: payload.selection.provider,
        model: payload.selection.model,
      }
      if (payload.selection.reasoningEffort !== undefined) {
        model.reasoningEffort = payload.selection.reasoningEffort
      }
      return { type: 'session-updated', sessionId, changes: jsonObject({ model: jsonObject(model) }) }
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
      if (typeof result !== 'object' || result === null || Array.isArray(result)) return undefined
      if (typeof result.artifactId !== 'string') return undefined
      return { type: 'artifact-ready', sessionId, artifactId: result.artifactId }
    }
    default: return undefined
  }
}

/**
 * 将 inbox 记录持续交给 Session 运行时处理的持久化 worker。
 *
 * @param options - 存储、运行时和固定 cwd。
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
   * @param options - 持久化存储和运行时适配器。
   */
  constructor(options: ExternalGatewayWorkerOptions) {
    this.store = options.store
    this.runtime = options.runtime
    this.startupCwd = options.startupCwd
    this.onError = options.onError ?? (() => {})
  }

  /** 当前 worker 生命周期和待处理记录数量。 */
  get state(): ExternalGatewayWorkerState {
    return {
      started: this.started,
      stopping: this.stopping,
      pending: this.store.listPendingDeliveries().length,
    }
  }

  /** 订阅运行时事件，并将全部持久化 pending 记录加入队列。 */
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

  /** outbox 确认释放空间后，重新扫描待处理 inbox 和运行时事件。 */
  async resumePending(): Promise<void> {
    if (this.stopping) return
    for (const record of this.store.listPendingDeliveries()) this.enqueue(record)
    for (const event of [...this.pendingRuntimeEvents]) {
      const run = this.runtimeEventTail.then(() => this.persistRuntimeEvent(event))
      this.runtimeEventTail = run.then(() => undefined, () => undefined)
      void run.catch(error => this.report(error))
    }
  }

  /** 停止准入，取消活动运行时调用，并等待已调度工作结束。 */
  async close(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.unsubscribeRuntime?.()
    this.unsubscribeRuntime = undefined
    this.abortController.abort()
    await Promise.all([...this.activeRuns])
    await this.runtimeEventTail
  }

  /** 调度一条待处理投递，同时保持对话顺序。 */
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
      // inbox 标记为已完成前，所有事件均已持久化。这些写入
      // 之间发生崩溃可能导致重启后事件重复，但不会
      // 确认一个完成事件已丢失的投递。
      const completed: GatewayDraft<Extract<GatewayEventPayload, { type: 'delivery-completed' }>> = {
        type: 'delivery-completed',
        deliveryId,
      }
      if (result.result !== undefined) {
        completed.result = result.result
      }
      await this.appendDeliveryEvent(prepared.record, completed, result.sessionId)
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
    const options: {
      sessionId?: NonNullable<ExternalGatewayDispatchResult['sessionId']>
      causedByDeliveryId: GatewayDeliveryRecord['deliveryId']
    } = {
      causedByDeliveryId: record.deliveryId,
    }
    if (sessionId !== undefined) {
      options.sessionId = sessionId
    }
    await this.store.appendEvent(record.clientId, record, payload, options)
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
    if (lastError instanceof Error) {
      throw lastError
    }
    throw new Error(String(lastError))
  }

  private report(error: unknown): void {
    try {
      this.onError(error)
    } catch {
      // 诊断处理不能导致 worker 出现未处理的 Promise 拒绝。
    }
  }
}
