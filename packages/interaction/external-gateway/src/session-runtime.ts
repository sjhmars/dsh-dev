/**
 * Peer-scoped Session operations for the External Gateway protocol.
 *
 * This module is deliberately a facade over the existing Host services. It
 * owns neither an Agent loop nor persistence. The gateway store supplies the
 * peer ownership and interaction records, while this facade supplies the
 * fixed working-directory and ungrouped-Session policy at every operation.
 *
 * @module @deepseek-ai/dsh-external-gateway/session-runtime
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment/types'
import type {
  CommandExecution,
  CommandRuntime,
} from '@deepseek-ai/dsh-commands'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  PermissionPresetService,
} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import type {
  SessionController,
  SessionSkillCatalog,
  SessionCreateValue,
  SessionForkValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameValue,
  SessionSelectModelValue,
  SessionCancelValue,
  SkillListValue,
} from '@deepseek-ai/dsh-api-session-controller'
import { ApiSessionNotFound } from '@deepseek-ai/dsh-api-session-controller'
import type {
  ApprovalOutcome,
  ApprovalRequestId,
} from '@deepseek-ai/dsh-user-approval/types'
import type {
  AskUserQuestionAnswer,
} from '@deepseek-ai/dsh-user-questions'
import type {
  SubagentCatalog,
  SubagentInterruptReceipt,
  SubagentPromptRequest,
  SubagentPromptReceipt,
  SubagentRuntime,
} from '@deepseek-ai/dsh-subagent'
import type { SessionRequestId, PromptContentPart } from '@deepseek-ai/dsh-api-session-controller/types'

/** The caller identity selected by the gateway credential. */
export interface GatewayPeer {
  /** Credential-derived client identity. */
  readonly clientId: string
  /** External account identity, for example one iLink account. */
  readonly accountId: string
  /** External peer identity, for example one WeChat user. */
  readonly peerId: string
}

/** A Session address owned by one external peer. */
export interface GatewaySessionAddress {
  readonly peer: GatewayPeer
  readonly sessionId: SessionId
}

/** A value that may be synchronous in a unit-test adapter or asynchronous in a store adapter. */
export type MaybePromise<Value> = Value | Promise<Value>

/**
 * Ownership callbacks supplied by the durable gateway store.
 *
 * `claimSession` is an atomic pre-creation reservation. It returns `true` when
 * this peer newly owns an unowned identity and `false` when the identity was
 * already owned by this peer. It must reject a claim belonging to another
 * peer. A successful claim is durable even when Host Session creation fails:
 * the same explicit Session ID is retried after restart instead of creating a
 * second conversation. The store therefore must not release a claim merely
 * because the first Host creation attempt failed.
 */
export interface GatewaySessionOwnership {
  /** Whether this peer owns the Session identity. */
  readonly ownsSession: (peer: GatewayPeer, sessionId: SessionId) => MaybePromise<boolean>
  /** Atomically reserve or adopt an unowned Session identity for this peer. */
  readonly claimSession: (peer: GatewayPeer, sessionId: SessionId) => MaybePromise<boolean>
  /** Read this peer's active Session, if one has been selected. */
  readonly activeSession: (peer: GatewayPeer) => MaybePromise<SessionId | undefined>
  /** Persist this peer's active Session selection. */
  readonly setActiveSession: (peer: GatewayPeer, sessionId: SessionId | undefined) => MaybePromise<void>
  /**
   * Optional location invariant. The default is ungrouped because this facade
   * never sends a workspace id to the Session Controller.
   */
  readonly isUngrouped?: (peer: GatewayPeer, sessionId: SessionId) => MaybePromise<boolean>
  /** Whether a subagent child belongs to the peer's parent Session. */
  readonly ownsSubagent?: (
    peer: GatewayPeer,
    parentSessionId: SessionId,
    childSessionId: SessionId,
  ) => MaybePromise<boolean>
  /** Whether an interaction id is still owned by this peer and Session. */
  readonly ownsInteraction?: (
    peer: GatewayPeer,
    sessionId: SessionId,
    interactionId: string,
    kind: GatewayInteractionKind,
  ) => MaybePromise<boolean>
}

/** Existing Host methods consumed by the facade. */
export interface GatewaySessionServices {
  readonly sessionController: Pick<
    SessionController,
    'create' | 'inspect' | 'selectModel' | 'rename' | 'fork' | 'prompt' | 'cancel' | 'resolveAgent'
  >
  readonly commands: Pick<CommandRuntime, 'execute'>
  readonly permissionPresets: Pick<PermissionPresetService, 'set'>
  readonly skills: Pick<SessionSkillCatalog, 'list'>
  readonly subagents: Pick<
    SubagentRuntime,
    'remoteExportList' | 'prompt' | 'interruptByParent'
  >
  /** Optional Agent-root predicate supplied by the Host's Agent registry. */
  readonly isRootAgent?: (agent: Agent) => MaybePromise<boolean>
}

type ResolvedGatewayAgent = Awaited<ReturnType<SessionController['resolveAgent']>>

/** A mutation's Session identity, before the active-peer fallback is applied. */
export interface GatewaySessionTarget {
  readonly sessionId?: SessionId
}

/** Gateway-safe Session creation request. Location fields are deliberately absent. */
export interface GatewaySessionCreateRequest {
  readonly sessionId?: SessionId
  readonly agentPreset?: string
}

/** Gateway-safe Session selection request. */
export interface GatewaySessionSelectRequest {
  readonly sessionId: SessionId
}

/** Gateway-safe Session rename request. */
export interface GatewaySessionRenameRequest {
  readonly sessionId: SessionId
  readonly title: string
}

/** Gateway-safe Session fork request. */
export interface GatewaySessionForkRequest {
  readonly sessionId: SessionId
  readonly atSeq?: number
}

/** Gateway-safe model-selection request. */
export interface GatewaySessionModelRequest {
  readonly sessionId: SessionId
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Gateway-safe permission-preset request. */
export interface GatewaySessionPermissionRequest {
  readonly sessionId: SessionId
  readonly preset: string
}

/** Gateway-safe prompt request. */
export interface GatewaySessionMessageRequest extends GatewaySessionTarget {
  /** Client-minted durable prompt correlation id. */
  readonly requestId: SessionRequestId
  readonly mode?: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}

/** Gateway-safe human-command request. */
export interface GatewaySessionCommandRequest extends GatewaySessionTarget {
  readonly line: string
  readonly images?: readonly EncodedImageAttachment[]
}

/** Gateway-safe continuable-subagent follow-up request. */
export interface GatewaySubagentFollowupRequest {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  readonly requestId: SessionRequestId
  readonly content: readonly ContentBlock[]
  readonly clientTimeZone?: string
}

/** Gateway-safe continuable-subagent interrupt request. */
export interface GatewaySubagentInterruptRequest {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
}

/** The two externally answerable interaction families. */
export type GatewayInteractionKind = 'question' | 'approval'

/** A question answer paired with its gateway interaction id. */
export interface GatewayQuestionAnswerRequest {
  readonly sessionId: SessionId
  readonly interactionId: string
  readonly answer: AskUserQuestionAnswer
}

/** An approval answer paired with its gateway interaction id. */
export interface GatewayApprovalAnswerRequest {
  readonly sessionId: SessionId
  readonly interactionId: ApprovalRequestId | string
  readonly outcome: Extract<ApprovalOutcome, 'allowed-once' | 'rejected'>
}

/** The result of selecting one peer-owned Session. */
export interface GatewaySessionSelectValue {
  readonly sessionId: SessionId
  readonly active: true
}

/** The result of changing a Session permission preset. */
export interface GatewaySessionPermissionValue {
  readonly sessionId: SessionId
  readonly preset: string
}

/** Runtime failures mapped by the HTTP protocol layer. */
export type GatewaySessionErrorCode =
  | 'session-not-owned'
  | 'session-location-invalid'
  | 'session-reservation-failed'
  | 'subagent-not-owned'
  | 'interaction-not-owned'
  | 'interaction-scope-unavailable'
  | 'root-agent-required'
  | 'command-not-allowed'
  | 'invalid-location'

/** Stable failure raised by the Session facade before a Host mutation. */
export class GatewaySessionRuntimeError extends Error {
  /** Machine-readable failure category. */
  readonly code: GatewaySessionErrorCode
  /** Structured details safe for the protocol's error envelope. */
  readonly details: Readonly<Record<string, unknown>>

  /**
   * @param code - stable failure category.
   * @param message - caller-facing diagnostic.
   * @param details - structured, non-secret failure facts.
   */
  constructor(
    code: GatewaySessionErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'GatewaySessionRuntimeError'
    this.code = code
    this.details = details
  }
}

/** Default command denylist for host-management surfaces. */
export const DEFAULT_GATEWAY_DENIED_COMMANDS: readonly string[] = Object.freeze([
  'credentials',
  'settings',
  'workspace',
  'plugin',
  'cordis',
  'agent-preset',
])

/** Constructor options for {@link GatewaySessionRuntime}. */
export interface GatewaySessionRuntimeOptions {
  /** Existing Host capability services. */
  readonly services: GatewaySessionServices
  /** Durable peer ownership and active-Session callbacks. */
  readonly ownership: GatewaySessionOwnership
  /** Absolute directory fixed into every gateway Session. */
  readonly fixedCwd: string
  /** Host command names that the external protocol must never execute. */
  readonly deniedCommands?: readonly string[]
}

/**
 * Peer-owned facade over the existing Session, command, permission, skill and
 * subagent services.
 */
export class GatewaySessionRuntime {
  private readonly services: GatewaySessionServices
  private readonly ownership: GatewaySessionOwnership
  private readonly fixedCwd: string
  private readonly deniedCommands: ReadonlySet<string>

  /**
   * @param options - Host service adapters, ownership store, and fixed cwd.
   */
  constructor(options: GatewaySessionRuntimeOptions) {
    if (options.fixedCwd.trim().length === 0) {
      throw new TypeError('external gateway fixedCwd must not be empty')
    }
    this.services = options.services
    this.ownership = options.ownership
    this.fixedCwd = resolve(options.fixedCwd)
    this.deniedCommands = new Set(options.deniedCommands ?? DEFAULT_GATEWAY_DENIED_COMMANDS)
  }

  /** The absolute cwd applied to every created or forked gateway Session. */
  get cwd(): string {
    return this.fixedCwd
  }

  /**
   * Create or adopt one peer-owned, ungrouped Session and make it active.
   *
   * The request is checked again as an unknown wire value so a caller cannot
   * bypass the TypeScript omission of `cwd` or `workspaceId`.
   *
   * @param peer - credential-derived peer identity.
   * @param request - gateway-safe creation request.
   * @returns the existing Session Controller creation receipt.
   */
  async create(peer: GatewayPeer, request: GatewaySessionCreateRequest): Promise<SessionCreateValue> {
    this.assertNoLocationFields(request)
    const sessionId = request.sessionId ?? brandSessionId(`session-${randomUUID()}`)
    const alreadyOwned = await this.ownership.ownsSession(peer, sessionId)
    if (!alreadyOwned) {
      await this.assertUnbackedSession(sessionId)
      const claimed = await this.ownership.claimSession(peer, sessionId)
      if (!claimed && !(await this.ownership.ownsSession(peer, sessionId))) {
        throw new GatewaySessionRuntimeError(
          'session-reservation-failed',
          `session "${sessionId}" is already owned by another peer`,
          { sessionId },
        )
      }
    }
    const result = await this.services.sessionController.create({
      sessionId,
      cwd: this.fixedCwd,
      ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
    })
    await this.assertLocation(peer, sessionId)
    await this.ownership.setActiveSession(peer, sessionId)
    return result
  }

  /**
   * Select one existing peer-owned Session as active.
   * @param peer - credential-derived peer identity.
   * @param request - Session to select.
   * @returns the active selection receipt.
   */
  async select(peer: GatewayPeer, request: GatewaySessionSelectRequest): Promise<GatewaySessionSelectValue> {
    await this.assertOwnedLocation(peer, request.sessionId)
    await this.ownership.setActiveSession(peer, request.sessionId)
    return { sessionId: request.sessionId, active: true }
  }

  /**
   * Rename one peer-owned Session.
   * @param peer - credential-derived peer identity.
   * @param request - Session and title.
   * @returns the Host rename receipt.
   */
  async rename(peer: GatewayPeer, request: GatewaySessionRenameRequest): Promise<SessionRenameValue> {
    await this.assertOwnedLocation(peer, request.sessionId)
    return this.services.sessionController.rename(request)
  }

  /**
   * Fork one peer-owned Session while preserving the fixed cwd and ungrouped
   * location.
   * @param peer - credential-derived peer identity.
   * @param request - source Session and optional completed-turn anchor.
   * @returns the newly claimed child Session identity.
   */
  async fork(peer: GatewayPeer, request: GatewaySessionForkRequest): Promise<SessionForkValue> {
    await this.assertOwnedLocation(peer, request.sessionId)
    const result = await this.services.sessionController.fork(request)
    const claimed = await this.ownership.claimSession(peer, result.sessionId)
    if (!claimed && !(await this.ownership.ownsSession(peer, result.sessionId))) {
      throw new GatewaySessionRuntimeError(
        'session-reservation-failed',
        `forked session "${result.sessionId}" is already owned by another peer`,
        { sessionId: result.sessionId },
      )
    }
    await this.assertLocation(peer, result.sessionId)
    await this.ownership.setActiveSession(peer, result.sessionId)
    return result
  }

  /**
   * Cancel one peer-owned Session's active turn.
   * @param peer - credential-derived peer identity.
   * @param sessionId - Session to cancel.
   * @returns the Host cancellation receipt.
   */
  async cancel(peer: GatewayPeer, sessionId: SessionId): Promise<SessionCancelValue> {
    await this.assertOwnedLocation(peer, sessionId)
    return this.services.sessionController.cancel({ sessionId })
  }

  /**
   * Select a model for one peer-owned Session.
   * @param peer - credential-derived peer identity.
   * @param request - Session and model route.
   * @returns the normalized Host model selection.
   */
  async selectModel(peer: GatewayPeer, request: GatewaySessionModelRequest): Promise<SessionSelectModelValue> {
    await this.assertOwnedLocation(peer, request.sessionId)
    return this.services.sessionController.selectModel(request)
  }

  /**
   * Set the Session-local sandbox and approval preset through its canonical
   * permission service.
   * @param peer - credential-derived peer identity.
   * @param request - Session and preset name.
   * @returns the accepted preset.
   */
  async setPermission(
    peer: GatewayPeer,
    request: GatewaySessionPermissionRequest,
  ): Promise<GatewaySessionPermissionValue> {
    const agent = await this.resolveOwnedAgent(peer, request.sessionId)
    this.services.permissionPresets.set(agent.session, request.preset)
    return { sessionId: request.sessionId, preset: request.preset }
  }

  /**
   * Deliver one ordinary message to a selected or explicitly addressed
   * Session. When no active Session exists, one is created at the fixed cwd.
   * @param peer - credential-derived peer identity.
   * @param request - prompt identity, content, and optional Session.
   * @param signal - caller cancellation before prompt admission.
   * @returns the Host prompt receipt.
   */
  async message(
    peer: GatewayPeer,
    request: GatewaySessionMessageRequest,
    signal: AbortSignal,
  ): Promise<SessionPromptValue> {
    const sessionId = await this.targetSession(peer, request.sessionId)
    const prompt: SessionPromptRequest = {
      requestId: request.requestId,
      sessionId,
      mode: request.mode ?? 'queue',
      content: [...request.content],
      ...(request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone }),
    }
    return this.services.sessionController.prompt(prompt, signal)
  }

  /**
   * Execute one registered Session command without opening a model turn.
   * Host-management command names are denied before the command registry runs.
   * @param peer - credential-derived peer identity.
   * @param request - optional active Session, command line and image inputs.
   * @param signal - command admission and handler lifetime.
   * @returns the normalized command execution, or undefined for an unknown command.
   */
  async command(
    peer: GatewayPeer,
    request: GatewaySessionCommandRequest,
    signal: AbortSignal,
  ): Promise<CommandExecution | undefined> {
    const sessionId = request.sessionId ?? await this.ownership.activeSession(peer)
    if (sessionId === undefined) {
      throw new GatewaySessionRuntimeError(
        'session-not-owned',
        'peer has no active Session for command execution',
      )
    }
    await this.assertOwnedLocation(peer, sessionId)
    const agent = await this.resolveOwnedAgent(peer, sessionId)
    const parsed = parseCommand(request.line)
    if (parsed !== undefined && this.deniedCommands.has(parsed.name)) {
      throw new GatewaySessionRuntimeError(
        'command-not-allowed',
        `command /${parsed.name} is not available through the external gateway`,
        { command: parsed.name },
      )
    }
    return this.services.commands.execute(agent, request.line, request.images ?? [], signal)
  }

  /**
   * List user-invocable skills for one peer-owned Session.
   * @param peer - credential-derived peer identity.
   * @param sessionId - Session whose preset and cwd determine the catalog.
   * @param signal - catalog read cancellation.
   * @returns the existing Session skill catalog value.
   */
  async listSkills(peer: GatewayPeer, sessionId: SessionId, signal: AbortSignal): Promise<SkillListValue> {
    await this.assertOwnedLocation(peer, sessionId)
    return this.services.skills.list({ sessionId }, signal)
  }

  /**
   * List direct subagents belonging to one peer-owned root Session.
   * @param peer - credential-derived peer identity.
   * @param parentSessionId - owned root Session.
   * @param signal - catalog read cancellation.
   * @returns the existing subagent catalog.
   */
  async listSubagents(
    peer: GatewayPeer,
    parentSessionId: SessionId,
    signal: AbortSignal,
  ): Promise<SubagentCatalog> {
    await this.assertOwnedLocation(peer, parentSessionId)
    return this.services.subagents.remoteExportList(parentSessionId, signal)
  }

  /**
   * Deliver a follow-up to one peer-owned continuable subagent.
   * @param peer - credential-derived peer identity.
   * @param request - parent/child address and user content.
   * @param signal - caller cancellation before inbox acceptance.
   * @returns the existing subagent prompt receipt.
   */
  async followupSubagent(
    peer: GatewayPeer,
    request: GatewaySubagentFollowupRequest,
    signal: AbortSignal,
  ): Promise<SubagentPromptReceipt> {
    await this.assertOwnedLocation(peer, request.parentSessionId)
    await this.assertOwnedSubagent(peer, request.parentSessionId, request.childSessionId)
    const childRequest: SubagentPromptRequest = {
      requestId: request.requestId,
      parentSessionId: request.parentSessionId,
      childSessionId: request.childSessionId,
      mode: 'continuable',
      content: [...request.content],
      ...(request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone }),
    }
    return this.services.subagents.prompt(childRequest, signal)
  }

  /**
   * Interrupt one peer-owned continuable subagent.
   * @param peer - credential-derived peer identity.
   * @param request - parent/child address.
   * @returns the existing interrupt receipt.
   */
  async interruptSubagent(
    peer: GatewayPeer,
    request: GatewaySubagentInterruptRequest,
  ): Promise<SubagentInterruptReceipt> {
    await this.assertOwnedLocation(peer, request.parentSessionId)
    await this.assertOwnedSubagent(peer, request.parentSessionId, request.childSessionId)
    return this.services.subagents.interruptByParent(
      request.childSessionId,
      request.parentSessionId,
      'continuable',
    )
  }

  /**
   * Check that an externally supplied question answer addresses a live
   * interaction owned by this peer and Session.
   * @param peer - credential-derived peer identity.
   * @param request - Session and interaction identity.
   */
  async assertQuestionScope(peer: GatewayPeer, request: GatewayQuestionAnswerRequest): Promise<void> {
    await this.assertInteractionScope(peer, request.sessionId, request.interactionId, 'question')
  }

  /**
   * Check that an externally supplied approval answer addresses a live
   * interaction owned by this peer and Session.
   * @param peer - credential-derived peer identity.
   * @param request - Session and interaction identity.
   */
  async assertApprovalScope(peer: GatewayPeer, request: GatewayApprovalAnswerRequest): Promise<void> {
    await this.assertInteractionScope(peer, request.sessionId, String(request.interactionId), 'approval')
  }

  /**
   * Return whether an Agent may be used for this gateway's root interaction
   * answerer. Subagent Agents are never valid question/approval owners.
   * @param peer - credential-derived peer identity.
   * @param sessionId - peer-owned root Session.
   * @param agent - exact live Agent observed by the event listener.
   * @returns true only for the exact owned root Agent.
   */
  async ownsRootInteractionAgent(peer: GatewayPeer, sessionId: SessionId, agent: Agent): Promise<boolean> {
    if (!(await this.ownership.ownsSession(peer, sessionId))) return false
    if (agent.session.id !== sessionId) return false
    if (this.services.isRootAgent !== undefined) return this.services.isRootAgent(agent)
    return agent.session.header.origin !== 'subagent'
  }

  /** Resolve a peer's active Session or create one for an ordinary message. */
  private async targetSession(peer: GatewayPeer, requested?: SessionId): Promise<SessionId> {
    if (requested !== undefined) {
      await this.assertOwnedLocation(peer, requested)
      return requested
    }
    const active = await this.ownership.activeSession(peer)
    if (active !== undefined) {
      await this.assertOwnedLocation(peer, active)
      return active
    }
    const created = await this.create(peer, {})
    return created.sessionId
  }

  /** Reject an explicit identity that already has a Host Session behind it. */
  private async assertUnbackedSession(sessionId: SessionId): Promise<void> {
    try {
      await this.services.sessionController.inspect(sessionId)
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) return
      throw error
    }
    throw new GatewaySessionRuntimeError(
      'session-reservation-failed',
      `session "${sessionId}" already exists outside this peer ownership record`,
      { sessionId },
    )
  }

  /** Resolve an owned ordinary Session to its live Agent. */
  private async resolveOwnedAgent(peer: GatewayPeer, sessionId: SessionId): Promise<Agent> {
    await this.assertOwnedLocation(peer, sessionId)
    const found: ResolvedGatewayAgent = await this.services.sessionController.resolveAgent(sessionId)
    if ('error' in found) throw new Error(found.error.message)
    if (found.agent.session.header.origin === 'subagent') {
      throw new GatewaySessionRuntimeError(
        'session-not-owned',
        `session "${sessionId}" is owned by subagent routing`,
        { sessionId },
      )
    }
    return found.agent
  }

  /** Verify peer ownership and the fixed location invariant. */
  private async assertOwnedLocation(peer: GatewayPeer, sessionId: SessionId): Promise<void> {
    if (!(await this.ownership.ownsSession(peer, sessionId))) {
      throw new GatewaySessionRuntimeError(
        'session-not-owned',
        `session "${sessionId}" is not owned by this peer`,
        { sessionId },
      )
    }
    await this.assertLocation(peer, sessionId)
  }

  /** Verify cwd and optional ungrouped ownership metadata. */
  private async assertLocation(peer: GatewayPeer, sessionId: SessionId): Promise<void> {
    const observation = await this.services.sessionController.inspect(sessionId)
    if (observation.meta.cwd !== this.fixedCwd) {
      throw new GatewaySessionRuntimeError(
        'session-location-invalid',
        `session "${sessionId}" is not in the gateway cwd`,
        { sessionId, expectedCwd: this.fixedCwd, actualCwd: observation.meta.cwd },
      )
    }
    if (this.ownership.isUngrouped !== undefined
      && !(await this.ownership.isUngrouped(peer, sessionId))) {
      throw new GatewaySessionRuntimeError(
        'session-location-invalid',
        `session "${sessionId}" is attached to a workspace`,
        { sessionId },
      )
    }
  }

  /** Verify an interaction record before the protocol accepts its answer. */
  private async assertInteractionScope(
    peer: GatewayPeer,
    sessionId: SessionId,
    interactionId: string,
    kind: GatewayInteractionKind,
  ): Promise<void> {
    await this.assertOwnedLocation(peer, sessionId)
    const ownsInteraction = this.ownership.ownsInteraction
    if (ownsInteraction === undefined) {
      throw new GatewaySessionRuntimeError(
        'interaction-scope-unavailable',
        'interaction ownership is unavailable',
        { sessionId, interactionId, kind },
      )
    }
    if (!(await ownsInteraction(peer, sessionId, interactionId, kind))) {
      throw new GatewaySessionRuntimeError(
        'interaction-not-owned',
        `interaction "${interactionId}" is not owned by this peer`,
        { sessionId, interactionId, kind },
      )
    }
  }

  /** Verify a child Session's peer-owned parent relationship. */
  private async assertOwnedSubagent(
    peer: GatewayPeer,
    parentSessionId: SessionId,
    childSessionId: SessionId,
  ): Promise<void> {
    const ownsSubagent = this.ownership.ownsSubagent
    if (ownsSubagent !== undefined) {
      if (await ownsSubagent(peer, parentSessionId, childSessionId)) return
    } else {
      const child = await this.services.sessionController.inspect(childSessionId)
      if (child.meta.parentSession === parentSessionId && child.meta.origin === 'subagent') return
    }
    throw new GatewaySessionRuntimeError(
      'subagent-not-owned',
      `subagent "${childSessionId}" is not owned by parent "${parentSessionId}"`,
      { parentSessionId, childSessionId },
    )
  }

  /** Reject forbidden location fields even when called through an untyped adapter. */
  private assertNoLocationFields(request: object): void {
    const value = request as Record<string, unknown>
    if ('cwd' in value || 'workspaceId' in value) {
      throw new GatewaySessionRuntimeError(
        'invalid-location',
        'external gateway Session creation cannot select cwd or workspace',
        {},
      )
    }
  }
}
