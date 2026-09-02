/** Host-service adapter for the External Gateway protocol. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionRequestId, PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
} from '@deepseek-ai/dsh-session-log-export'
import type {
  ExternalGatewayDispatchRequest,
  ExternalGatewayDispatchResult,
  ExternalGatewayQueryRequest,
  ExternalGatewayQueryResult,
  ExternalGatewayRuntime,
  ExternalGatewayRuntimeEvent,
  GatewayMessageContent,
  JsonValue,
} from './types.ts'
import { ExternalGatewayStore, ExternalGatewayStoreError } from './storage.ts'
import { GatewayClientId, GatewayInteractionId } from './brand.ts'
import { GatewaySessionRuntime, GatewaySessionRuntimeError, type GatewayPeer } from './session-runtime.ts'

/** Stable Host-adapter failure consumed by the delivery worker. */
export class ExternalGatewayHostRuntimeError extends Error {
  /** @param code - protocol-facing failure code. @param message - safe diagnostic. */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ExternalGatewayHostRuntimeError'
  }
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function requestId(value: string): SessionRequestId {
  return value as SessionRequestId
}

function imageMediaType(value: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif':
      return value
    default:
      return undefined
  }
}

async function promptContent(
  store: ExternalGatewayStore,
  peer: GatewayPeer,
  parts: readonly GatewayMessageContent[],
  sessionId?: SessionId,
): Promise<PromptContentPart[]> {
  const result: PromptContentPart[] = []
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        result.push({ type: 'text', text: part.text })
        break
      case 'skill':
        result.push({ type: 'text', text: `/${part.name} ` })
        break
      case 'image':
        if (part.uploadId !== undefined) {
          const upload = await store.readUpload(peer, part.uploadId)
          if (upload.record.kind !== 'image') {
            throw new ExternalGatewayHostRuntimeError('invalid-content', 'image content must reference an image upload')
          }
          const mediaType = imageMediaType(upload.record.contentType)
          if (mediaType === undefined) {
            throw new ExternalGatewayHostRuntimeError('invalid-content', 'uploaded image content type is not supported')
          }
          result.push({
            type: 'image',
            mediaType,
            data: Buffer.from(upload.bytes).toString('base64'),
            ...(part.name === undefined ? { name: upload.record.filename } : { name: part.name }),
          })
          break
        }
        if (part.data === undefined || part.mediaType === undefined) {
          throw new ExternalGatewayHostRuntimeError('invalid-content', 'inline image content is incomplete')
        }
        result.push({
          type: 'image',
          mediaType: part.mediaType,
          data: part.data,
          ...(part.name === undefined ? {} : { name: part.name }),
        })
        break
      case 'upload': {
        const upload = await store.readUpload(peer, part.uploadId)
        if (upload.record.kind === 'image') {
          const mediaType = imageMediaType(upload.record.contentType)
          if (mediaType === undefined) {
            throw new ExternalGatewayHostRuntimeError('invalid-content', 'uploaded image content type is not supported')
          }
          result.push({
            type: 'image',
            mediaType,
            data: Buffer.from(upload.bytes).toString('base64'),
            name: upload.record.filename,
          })
        } else {
          if (sessionId === undefined) {
            throw new ExternalGatewayHostRuntimeError('invalid-content', 'file content needs a root Session')
          }
          result.push({
            type: 'text',
            text: `Uploaded file "${upload.record.filename}" is available at "${await store.materializeUploadFile(peer, part.uploadId, sessionId)}".`,
          })
        }
        break
      }
      case 'file': {
        const upload = await store.readUpload(peer, part.uploadId)
        if (upload.record.kind !== 'file') {
          throw new ExternalGatewayHostRuntimeError('invalid-content', 'file content must reference a file upload')
        }
        if (sessionId === undefined) {
          throw new ExternalGatewayHostRuntimeError('invalid-content', 'file content needs a root Session')
        }
        result.push({
          type: 'text',
          text: `Uploaded file "${upload.record.filename}" is available at "${await store.materializeUploadFile(peer, part.uploadId, sessionId)}".`,
        })
        break
      }
      default:
        throw new ExternalGatewayHostRuntimeError('invalid-content', 'unsupported message content')
    }
  }
  return result
}

async function subagentContent(
  store: ExternalGatewayStore,
  peer: GatewayPeer,
  parts: readonly GatewayMessageContent[],
): Promise<ContentBlock[]> {
  return (await promptContent(store, peer, parts)).map(part => {
    if (part.type !== 'text') {
      throw new ExternalGatewayHostRuntimeError('invalid-content', 'subagent follow-up accepts text and skill references')
    }
    return part
  })
}

const FORWARDED_SESSION_EVENTS = new Set([
  'user/message', 'assistant/message', 'tool/call', 'tool/result',
  'turn/start', 'turn/end', 'permission/preset', 'sandbox/mode',
  'approval/policy', 'approval/asked', 'approval/decided',
])

function finalAssistantText(session: Session, turn: number): string | undefined {
  const message = session.events.findLast(event => event.type === 'assistant/message' && event.data.turn === turn)
  if (message?.type !== 'assistant/message') return undefined
  const text = message.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.length === 0 ? undefined : text
}

/** Real adapter over the Host services already mounted by `dsh-web-app`. */
export class ExternalGatewayHostRuntime implements ExternalGatewayRuntime {
  readonly startupCwd: string
  private readonly sessions: GatewaySessionRuntime
  private readonly listeners = new Set<(event: ExternalGatewayRuntimeEvent) => Promise<void>>()
  private readonly questions = new Map<string, {
    readonly peer: GatewayPeer
    readonly sessionId: SessionId
    readonly resolve: (answer: AskUserQuestionAnswer) => void
    readonly reject: (error: Error) => void
  }>()
  private readonly approvals = new Map<string, {
    readonly peer: GatewayPeer
    readonly sessionId: SessionId
    readonly resolve: (outcome: ApprovalOutcome) => void
  }>()
  private readonly interactionTimeoutMs: number

  /** @param ctx - assembled Host services. @param store - peer ownership store. @param startupCwd - fixed Session cwd. */
  constructor(
    private readonly ctx: Context,
    private readonly store: ExternalGatewayStore,
    startupCwd: string,
    interactionTimeoutMs: number,
  ) {
    this.startupCwd = startupCwd
    this.interactionTimeoutMs = interactionTimeoutMs
    this.sessions = new GatewaySessionRuntime({
      fixedCwd: startupCwd,
      ownership: store.ownership(),
      services: {
        sessionController: ctx.sessionController,
        commands: ctx.commands,
        permissionPresets: ctx.permissionPresets,
        skills: ctx.sessionSkillCatalog,
        subagents: ctx.subagents,
        isRootAgent: agent => ctx.agents.roots().includes(agent),
      },
    })
    ctx.on('session/event', (session, event) => {
      void this.projectSessionEvent(session, event).catch(error => ctx.logger.error(error))
    }, { global: true })
    ctx.on('user-questions/request', (request, next) => this.answerQuestion(request, next), { global: true })
    ctx.on('approval/request', (request, next) => this.answerApproval(request, next), { global: true })
  }

  /** Execute one peer-scoped durable mutation through existing Host services. */
  async dispatch(
    request: ExternalGatewayDispatchRequest,
    signal: AbortSignal,
  ): Promise<ExternalGatewayDispatchResult> {
    const peer = this.peer(request)
    const payload = request.payload
    switch (payload.type) {
      case 'session-create': {
        const sessionId = request.reservedSessionId
        if (sessionId === undefined) throw new ExternalGatewayHostRuntimeError('missing-reservation', 'Session creation has no durable reservation')
        const created = await this.sessions.create(peer, { sessionId })
        if (payload.title !== undefined) await this.sessions.rename(peer, { sessionId, title: payload.title })
        if (payload.model !== undefined) await this.sessions.selectModel(peer, { sessionId, ...payload.model })
        if (payload.permissionPreset !== undefined) {
          await this.sessions.setPermission(peer, { sessionId, preset: payload.permissionPreset })
        }
        return { sessionId: created.sessionId }
      }
      case 'session-select':
        await this.sessions.select(peer, payload)
        return { sessionId: payload.sessionId }
      case 'session-rename':
        return { sessionId: payload.sessionId, result: json(await this.sessions.rename(peer, payload)) }
      case 'session-fork': {
        const forked = await this.sessions.fork(peer, {
          sessionId: payload.sessionId,
          ...(payload.eventSeq === undefined ? {} : { atSeq: payload.eventSeq }),
        })
        return { sessionId: forked.sessionId }
      }
      case 'session-cancel': {
        const sessionId = payload.sessionId ?? this.store.activeSession(peer)
        if (sessionId === undefined) throw new ExternalGatewayHostRuntimeError('session-not-found', 'peer has no active Session')
        return { sessionId, result: json(await this.sessions.cancel(peer, sessionId)) }
      }
      case 'model-select':
        return { sessionId: payload.sessionId, result: json(await this.sessions.selectModel(peer, {
          sessionId: payload.sessionId,
          ...payload.selection,
        })) }
      case 'permission-select':
        return { sessionId: payload.sessionId, result: json(await this.sessions.setPermission(peer, {
          sessionId: payload.sessionId,
          preset: payload.preset,
        })) }
      case 'message': {
        const sessionId = payload.sessionId ?? request.reservedSessionId
        if (sessionId === undefined) {
          throw new ExternalGatewayHostRuntimeError('missing-reservation', 'message has no durable Session reservation')
        }
        const result = await this.sessions.message(peer, {
          sessionId,
          requestId: requestId(request.deliveryId),
          mode: payload.mode ?? 'queue',
          content: await promptContent(this.store, peer, payload.content, sessionId),
        }, signal)
        return { sessionId, result: json(result) }
      }
      case 'command': {
        const sessionId = payload.sessionId ?? request.reservedSessionId
        const result = await this.sessions.command(peer, {
          ...(sessionId === undefined ? {} : { sessionId }),
          line: payload.command,
        }, signal)
        return { ...(sessionId === undefined ? {} : { sessionId }), result: json(result ?? null) }
      }
      case 'subagent-followup':
        return {
          sessionId: payload.sessionId,
          result: json(await this.sessions.followupSubagent(peer, {
            parentSessionId: payload.sessionId,
            childSessionId: SessionId(payload.agentId),
            requestId: requestId(request.deliveryId),
            content: await subagentContent(this.store, peer, payload.content),
          }, signal)),
        }
      case 'subagent-interrupt':
        return {
          sessionId: payload.sessionId,
          result: json(await this.sessions.interruptSubagent(peer, {
            parentSessionId: payload.sessionId,
            childSessionId: SessionId(payload.agentId),
          })),
        }
      case 'question-answer': {
        const pending = this.questions.get(payload.interactionId)
        if (pending === undefined || !this.samePeer(pending.peer, peer)) {
          throw new ExternalGatewayHostRuntimeError('interaction-expired', 'question interaction is not active')
        }
        this.questions.delete(payload.interactionId)
        await this.store.finishInteraction(request.clientId, payload.interactionId, 'answered')
        pending.resolve({ answers: payload.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        })) })
        return { sessionId: pending.sessionId }
      }
      case 'approval-answer': {
        const pending = this.approvals.get(payload.interactionId)
        if (pending === undefined || !this.samePeer(pending.peer, peer)) {
          throw new ExternalGatewayHostRuntimeError('interaction-expired', 'approval interaction is not active')
        }
        this.approvals.delete(payload.interactionId)
        await this.store.finishInteraction(request.clientId, payload.interactionId, 'answered')
        pending.resolve(payload.outcome)
        return { sessionId: pending.sessionId }
      }
      case 'session-export':
        return this.exportSession(peer, payload.sessionId, signal)
      default:
        throw new ExternalGatewayHostRuntimeError('unsupported-operation', 'unsupported delivery operation')
    }
  }

  /** Read one peer-owned Host projection. */
  async query(request: ExternalGatewayQueryRequest, signal: AbortSignal): Promise<ExternalGatewayQueryResult> {
    const peer = this.peer(request)
    if (request.operation === 'sessions') {
      const items = await Promise.all(this.store.listSessions(peer).map(async owned => {
        if (owned.status !== 'ready') return { ownership: owned, observation: null }
        try {
          return {
            ownership: owned,
            observation: await this.ctx.sessionController.inspect(owned.sessionId, signal),
          }
        } catch {
          // A failed create reservation remains observable to its owner but
          // must not make every list request fail.
          return { ownership: owned, observation: null }
        }
      }))
      return { kind: 'json', value: json({ items, activeSessionId: this.store.activeSession(peer) ?? null }) }
    }
    if (request.operation === 'artifact') {
      if (request.artifactId === undefined) throw new ExternalGatewayHostRuntimeError('not-found', 'artifact was not found')
      const artifact = await this.store.readArtifact(peer, request.artifactId)
      if (artifact === undefined) throw new ExternalGatewayHostRuntimeError('not-found', 'artifact was not found')
      return {
        kind: 'bytes',
        contentType: artifact.record.contentType,
        body: artifact.bytes,
        filename: artifact.record.filename,
      }
    }
    const sessionId = request.sessionId
    if (sessionId === undefined || !this.store.ownsSession(peer, sessionId)) {
      throw new ExternalGatewayStoreError('session-not-owned', 'resource was not found')
    }
    switch (request.operation) {
      case 'session':
        return { kind: 'json', value: json(await this.ctx.sessionController.inspect(sessionId, signal)) }
      case 'models':
        return { kind: 'json', value: json(await this.ctx.sessionController.modelCatalog()) }
      case 'skills':
        return { kind: 'json', value: json(await this.sessions.listSkills(peer, sessionId, signal)) }
      case 'subagents':
        return { kind: 'json', value: json(await this.sessions.listSubagents(peer, sessionId, signal)) }
      case 'history': {
        const observed = await this.ctx.sessionController.inspect(sessionId, signal)
        const throughSeq = observed.events.at(-1)?.seq ?? 0
        return { kind: 'json', value: json(await this.ctx.sessionController.page({
          address: { kind: 'session', sessionId },
          throughSeq,
          ...(request.cursor === undefined ? {} : { beforeSeq: Number(request.cursor) }),
          ...(request.limit === undefined ? {} : { maxMessages: request.limit }),
        }, signal)) }
      }
      default:
        throw new ExternalGatewayHostRuntimeError('unsupported-query', 'unsupported query operation')
    }
  }

  /** Subscribe to events projected by the Host integration. */
  subscribe(listener: (event: ExternalGatewayRuntimeEvent) => Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Replay Session-log events not yet copied into the durable gateway outbox. */
  async replay(): Promise<void> {
    for (const owned of this.store.listAllSessions()) {
      if (owned.status !== 'ready') continue
      let observation: Awaited<ReturnType<typeof this.ctx.sessionController.inspect>>
      try {
        observation = await this.ctx.sessionController.inspect(owned.sessionId)
      } catch {
        continue
      }
      const after = this.store.projectedSequence(owned.sessionId)
      for (const event of observation.events) {
        if (event.seq > after) {
          await this.projectSessionEvent(
            Session.fromRestore(observation.meta.id, observation.events, observation.meta),
            event,
          )
        }
      }
    }
  }

  /** Publish one allowlisted Host event to worker subscribers. */
  private async publish(event: ExternalGatewayRuntimeEvent): Promise<void> {
    await Promise.all([...this.listeners].map(listener => listener(event)))
  }

  private async projectSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    const peer = this.store.ownerOfSession(session.id)
    if (peer === undefined) return
    const events: ExternalGatewayRuntimeEvent[] = []
    if (FORWARDED_SESSION_EVENTS.has(event.type)) {
      events.push({
        ...this.eventPeer(peer),
        sessionId: session.id,
        payload: { type: 'session-event', sessionId: session.id, event: json(event) },
      })
    }
    if (event.type === 'turn/end') {
      const text = finalAssistantText(session, event.data.turn)
      if (text !== undefined) {
        events.push({
          ...this.eventPeer(peer),
          sessionId: session.id,
          payload: { type: 'assistant-final', sessionId: session.id, text },
        })
      }
    }
    const last = events.length - 1
    for (const [index, projected] of events.entries()) {
      await this.publish(index === last ? { ...projected, sourceSequence: event.seq } : projected)
    }
  }

  private async answerQuestion(
    request: AskUserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    if (agent === undefined || !this.ctx.agents.roots().includes(agent)) return next()
    const peer = this.store.ownerOfSession(agent.session.id)
    if (peer === undefined) return next()
    const interactionId = GatewayInteractionId(randomUUID())
    const expiresAt = Date.now() + this.interactionTimeoutMs
    const answer = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      this.questions.set(interactionId, { peer, sessionId: agent.session.id, resolve, reject })
    })
    await this.publish({
      ...this.eventPeer(peer),
      sessionId: agent.session.id,
      interaction: {
        ...this.eventPeer(peer),
        sessionId: agent.session.id,
        interactionId,
        kind: 'question',
        expiresAt,
      },
      payload: {
        type: 'question',
        sessionId: agent.session.id,
        interactionId,
        expiresAt,
        questions: request.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...(question.detail === undefined ? {} : { detail: question.detail }),
          ...(question.header === undefined ? {} : { header: question.header }),
          ...(question.options === undefined ? {} : { options: question.options }),
          ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
          ...(question.intent === undefined ? {} : { intent: question.intent }),
        })),
      },
    })
    return this.withQuestionLifetime(interactionId, agent.session.id, peer, answer, request.signal, expiresAt)
  }

  private async answerApproval(
    request: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (!this.ctx.agents.roots().includes(request.agent)) return next()
    const peer = this.store.ownerOfSession(request.agent.session.id)
    if (peer === undefined) return next()
    const interactionId = GatewayInteractionId(randomUUID())
    const expiresAt = Date.now() + this.interactionTimeoutMs
    const answer = new Promise<ApprovalOutcome>(resolve => {
      this.approvals.set(interactionId, { peer, sessionId: request.agent.session.id, resolve })
    })
    await this.publish({
      ...this.eventPeer(peer),
      sessionId: request.agent.session.id,
      interaction: {
        ...this.eventPeer(peer),
        sessionId: request.agent.session.id,
        interactionId,
        kind: 'approval',
        expiresAt,
      },
      payload: {
        type: 'approval',
        sessionId: request.agent.session.id,
        interactionId,
        expiresAt,
        toolName: request.toolName,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      },
    })
    return this.withApprovalLifetime(interactionId, request.agent.session.id, peer, answer, request.signal, expiresAt)
  }

  private async withQuestionLifetime(
    interactionId: string,
    sessionId: SessionId,
    peer: GatewayPeer,
    answer: Promise<AskUserQuestionAnswer>,
    signal: AbortSignal | undefined,
    expiresAt: number,
  ): Promise<AskUserQuestionAnswer> {
    const timeout = Math.max(0, expiresAt - Date.now())
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.questions.delete(interactionId)
        this.expireInteraction(peer, sessionId, interactionId, 'question')
        reject(new ExternalGatewayHostRuntimeError('interaction-expired', 'question interaction expired'))
      }, timeout)
      const abort = (): void => {
        clearTimeout(timer)
        this.questions.delete(interactionId)
        this.expireInteraction(peer, sessionId, interactionId, 'question')
        reject(new ExternalGatewayHostRuntimeError('interaction-expired', 'question interaction was cancelled'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      answer.then(resolve, reject).finally(() => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }).catch(() => {})
    })
  }

  private async exportSession(
    peer: GatewayPeer,
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<ExternalGatewayDispatchResult> {
    if (!this.store.ownsSession(peer, sessionId)) {
      throw new ExternalGatewayHostRuntimeError('not-found', 'resource was not found')
    }
    const observation = await this.ctx.sessionController.inspect(sessionId, signal)
    if (observation.meta.cwd !== this.startupCwd) {
      throw new ExternalGatewayHostRuntimeError('not-found', 'resource was not found')
    }
    const deps = sessionLogExportDeps(this.ctx)
    if (deps.sessionQuery === undefined || deps.sessionPersistence === undefined || deps.attachments === undefined) {
      throw new ExternalGatewayHostRuntimeError('export-unavailable', 'Session export services are not mounted')
    }
    if (!deps.sessionPersistence.supportsRawArtifacts) {
      throw new ExternalGatewayHostRuntimeError('export-unavailable', 'Session persistence does not expose raw artifacts')
    }
    await flushLiveSessionLog(deps, sessionId, signal)
    const root = await deps.sessionPersistence.readRaw(sessionId, signal)
    if (root === undefined) throw new ExternalGatewayHostRuntimeError('not-found', 'resource was not found')
    const stream = streamSessionLogZip(
      { sessionQuery: deps.sessionQuery, sessionPersistence: deps.sessionPersistence, attachments: deps.attachments, sessions: deps.sessions },
      root,
      sessionId,
      true,
      DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
      signal,
    )
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
    const artifact = await this.store.saveArtifact(
      peer,
      sessionId,
      bytes,
      sessionLogZipFilename(sessionId),
      'application/zip',
    )
    return { sessionId, result: { artifactId: artifact.artifactId } }
  }

  private async withApprovalLifetime(
    interactionId: string,
    sessionId: SessionId,
    peer: GatewayPeer,
    answer: Promise<ApprovalOutcome>,
    signal: AbortSignal | undefined,
    expiresAt: number,
  ): Promise<ApprovalOutcome> {
    const timeout = Math.max(0, expiresAt - Date.now())
    return new Promise<ApprovalOutcome>((resolve) => {
      const expire = (): void => {
        this.approvals.delete(interactionId)
        this.expireInteraction(peer, sessionId, interactionId, 'approval')
        resolve('cancelled')
      }
      const timer = setTimeout(expire, timeout)
      signal?.addEventListener('abort', expire, { once: true })
      answer.then(resolve).finally(() => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', expire)
      }).catch(() => {})
    })
  }

  private expireInteraction(peer: GatewayPeer, sessionId: SessionId, interactionId: string, kind: 'question' | 'approval'): void {
    void this.store.finishInteraction(GatewayClientId(peer.clientId), GatewayInteractionId(interactionId), 'expired')
      .then(() => this.publish({
        ...this.eventPeer(peer),
        sessionId,
        payload: { type: 'interaction-expired', sessionId, interactionId: GatewayInteractionId(interactionId), kind },
      }))
      .catch(error => this.ctx.logger.error(error))
  }

  private samePeer(left: GatewayPeer, right: GatewayPeer): boolean {
    return left.clientId === right.clientId && left.accountId === right.accountId && left.peerId === right.peerId
  }

  private eventPeer(peer: GatewayPeer): { readonly clientId: import('./types.ts').GatewayClientId; readonly accountId: string; readonly peerId: string } {
    return { clientId: GatewayClientId(peer.clientId), accountId: peer.accountId, peerId: peer.peerId }
  }

  private peer(value: { readonly clientId: string; readonly accountId: string; readonly peerId: string }): GatewayPeer {
    return { clientId: value.clientId, accountId: value.accountId, peerId: value.peerId }
  }
}

/** Normalize facade failures for HTTP and worker adapters. */
export function isGatewayOwnershipFailure(error: unknown): boolean {
  return error instanceof GatewaySessionRuntimeError && error.code === 'session-not-owned'
}
