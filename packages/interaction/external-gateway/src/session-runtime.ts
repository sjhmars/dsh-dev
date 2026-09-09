/**
 * External Gateway 协议中按 peer 隔离的 Session 操作。
 *
 * 本模块仅封装现有宿主服务，
 * 不拥有 Agent 循环或持久化实现。网关存储提供
 * peer 归属及交互记录，本封装层则在
 * 每项操作中落实固定工作目录和 Session 未分组策略。
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

/** 网关凭据确定的调用方身份。 */
export interface GatewayPeer {
  /** 由凭据推导的客户端身份。 */
  readonly clientId: string
  /** 外部账号身份，例如一个 iLink 账号。 */
  readonly accountId: string
  /** 外部 peer 身份，例如一个微信用户。 */
  readonly peerId: string
}

/** 归单个外部 peer 所有的 Session 地址。 */
export interface GatewaySessionAddress {
  readonly peer: GatewayPeer
  readonly sessionId: SessionId
}

/** 在单元测试适配器中可同步返回、在存储适配器中可异步返回的值。 */
export type MaybePromise<Value> = Value | Promise<Value>

/**
 * 持久化网关存储提供的归属回调。
 *
 * `claimSession` 在创建前原子预留标识符。当此 peer 新获得
 * 一个无主标识符的归属时返回 `true`，当标识符
 * 已属于此 peer 时返回 `false`。必须拒绝认领属于其他
 * peer 的标识符。即使宿主 Session 创建失败，成功的归属认领仍会持久保留：
 * 重启后使用同一个显式 Session ID 重试，而不是创建
 * 第二段对话。因此，存储不能仅因
 * 首次宿主创建尝试失败就释放归属。
 */
export interface GatewaySessionOwnership {
  /** 此 peer 是否拥有该 Session 标识符。 */
  readonly ownsSession: (peer: GatewayPeer, sessionId: SessionId) => MaybePromise<boolean>
  /** 为此 peer 原子预留或认领一个无主 Session 标识符。 */
  readonly claimSession: (peer: GatewayPeer, sessionId: SessionId) => MaybePromise<boolean>
  /** 读取此 peer 已选择的活动 Session（若有）。 */
  readonly activeSession: (peer: GatewayPeer) => MaybePromise<SessionId | undefined>
  /** 持久化此 peer 的活动 Session 选择。 */
  readonly setActiveSession: (peer: GatewayPeer, sessionId: SessionId | undefined) => MaybePromise<void>
  /**
   * 可选的位置不变量。默认要求未分组，因为本封装层
   * 绝不向 Session Controller 发送工作区 ID。
   */
  readonly isUngrouped?: (peer: GatewayPeer, sessionId: SessionId) => MaybePromise<boolean>
  /** 子代理是否属于此 peer 的父 Session。 */
  readonly ownsSubagent?: (
    peer: GatewayPeer,
    parentSessionId: SessionId,
    childSessionId: SessionId,
  ) => MaybePromise<boolean>
  /** 交互 ID 是否仍归此 peer 和 Session 所有。 */
  readonly ownsInteraction?: (
    peer: GatewayPeer,
    sessionId: SessionId,
    interactionId: string,
    kind: GatewayInteractionKind,
  ) => MaybePromise<boolean>
}

/** 封装层使用的现有宿主方法。 */
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
  /** 宿主 Agent 注册表提供的可选根 Agent 判定函数。 */
  readonly isRootAgent?: (agent: Agent) => MaybePromise<boolean>
}

type ResolvedGatewayAgent = Awaited<ReturnType<SessionController['resolveAgent']>>

/** 应用 peer 活动 Session 回退规则前，变更请求中的 Session 标识符。 */
export interface GatewaySessionTarget {
  readonly sessionId?: SessionId
}

/** 网关安全的 Session 创建请求，明确不含位置字段。 */
export interface GatewaySessionCreateRequest {
  readonly sessionId?: SessionId
  readonly agentPreset?: string
}

/** 网关安全的 Session 选择请求。 */
export interface GatewaySessionSelectRequest {
  readonly sessionId: SessionId
}

/** 网关安全的 Session 重命名请求。 */
export interface GatewaySessionRenameRequest {
  readonly sessionId: SessionId
  readonly title: string
}

/** 网关安全的 Session 分叉请求。 */
export interface GatewaySessionForkRequest {
  readonly sessionId: SessionId
  readonly atSeq?: number
}

/** 网关安全的模型选择请求。 */
export interface GatewaySessionModelRequest {
  readonly sessionId: SessionId
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** 网关安全的权限预设请求。 */
export interface GatewaySessionPermissionRequest {
  readonly sessionId: SessionId
  readonly preset: string
}

/** 网关安全的提示输入请求。 */
export interface GatewaySessionMessageRequest extends GatewaySessionTarget {
  /** 客户端生成的持久化提示输入关联 ID。 */
  readonly requestId: SessionRequestId
  readonly mode?: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
  readonly clientTimeZone?: string
}

/** 网关安全的用户命令请求。 */
export interface GatewaySessionCommandRequest extends GatewaySessionTarget {
  readonly line: string
  readonly images?: readonly EncodedImageAttachment[]
}

/** 网关安全的可继续子代理跟进请求。 */
export interface GatewaySubagentFollowupRequest {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
  readonly requestId: SessionRequestId
  readonly content: readonly ContentBlock[]
  readonly clientTimeZone?: string
}

/** 网关安全的可继续子代理中断请求。 */
export interface GatewaySubagentInterruptRequest {
  readonly parentSessionId: SessionId
  readonly childSessionId: SessionId
}

/** 允许外部回答的两类交互。 */
export type GatewayInteractionKind = 'question' | 'approval'

/** 与网关交互 ID 配对的问题回答。 */
export interface GatewayQuestionAnswerRequest {
  readonly sessionId: SessionId
  readonly interactionId: string
  readonly answer: AskUserQuestionAnswer
}

/** 与网关交互 ID 配对的审批回答。 */
export interface GatewayApprovalAnswerRequest {
  readonly sessionId: SessionId
  readonly interactionId: ApprovalRequestId | string
  readonly outcome: Extract<ApprovalOutcome, 'allowed-once' | 'rejected'>
}

/** 选择 peer 所属 Session 的结果。 */
export interface GatewaySessionSelectValue {
  readonly sessionId: SessionId
  readonly active: true
}

/** 更改 Session 权限预设的结果。 */
export interface GatewaySessionPermissionValue {
  readonly sessionId: SessionId
  readonly preset: string
}

/** 由 HTTP 协议层映射的运行时错误。 */
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

/** Session 封装层在宿主变更前抛出的稳定错误。 */
export class GatewaySessionRuntimeError extends Error {
  /** 机器可读的错误类别。 */
  readonly code: GatewaySessionErrorCode
  /** 可安全放入协议错误封装的结构化详情。 */
  readonly details: Readonly<Record<string, unknown>>

  /**
   * @param code - 稳定的错误类别。
   * @param message - 面向调用方的诊断信息。
   * @param details - 不含秘密信息的结构化错误事实。
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

/** 宿主管理操作的默认命令拒绝列表。 */
export const DEFAULT_GATEWAY_DENIED_COMMANDS: readonly string[] = Object.freeze([
  'credentials',
  'settings',
  'workspace',
  'plugin',
  'cordis',
  'agent-preset',
])

/** {@link GatewaySessionRuntime} 的构造选项。 */
export interface GatewaySessionRuntimeOptions {
  /** 现有宿主能力服务。 */
  readonly services: GatewaySessionServices
  /** 持久化 peer 归属和活动 Session 回调。 */
  readonly ownership: GatewaySessionOwnership
  /** 每个网关 Session 固定使用的绝对目录。 */
  readonly fixedCwd: string
  /** 外部协议绝不能执行的宿主命令名称。 */
  readonly deniedCommands?: readonly string[]
}

/**
 * 按 peer 归属隔离的封装层，复用现有 Session、命令、权限、技能和
 * 子代理服务。
 */
export class GatewaySessionRuntime {
  private readonly services: GatewaySessionServices
  private readonly ownership: GatewaySessionOwnership
  private readonly fixedCwd: string
  private readonly deniedCommands: ReadonlySet<string>

  /**
   * @param options - 宿主服务适配器、归属存储和固定 cwd。
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

  /** 每个新建或分叉的网关 Session 使用的绝对 cwd。 */
  get cwd(): string {
    return this.fixedCwd
  }

  /**
   * 创建或接管一个属于当前 peer 的未分组 Session，并将其设为活动 Session。
   *
   * 请求会再次作为未知的传输数据进行校验，防止调用方
   * 绕过 TypeScript 对 `cwd` 或 `workspaceId` 的字段排除。
   *
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - 网关安全的创建请求。
   * @returns 现有 Session Controller 的创建回执。
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
   * 将一个已存在且属于当前 peer 的 Session 设为活动 Session。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - 待选择的 Session。
   * @returns 活动 Session 选择回执。
   */
  async select(peer: GatewayPeer, request: GatewaySessionSelectRequest): Promise<GatewaySessionSelectValue> {
    await this.assertOwnedLocation(peer, request.sessionId)
    await this.ownership.setActiveSession(peer, request.sessionId)
    return { sessionId: request.sessionId, active: true }
  }

  /**
   * 重命名一个属于当前 peer 的 Session。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - Session 和标题。
   * @returns 宿主重命名回执。
   */
  async rename(peer: GatewayPeer, request: GatewaySessionRenameRequest): Promise<SessionRenameValue> {
    await this.assertOwnedLocation(peer, request.sessionId)
    return this.services.sessionController.rename(request)
  }

  /**
   * 分叉一个属于当前 peer 的 Session，同时保留固定 cwd 和未分组的
   * 位置状态。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - 来源 Session 及可选的已完成轮次锚点。
   * @returns 新认领的子 Session 标识符。
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
   * 取消当前 peer 所属 Session 的活动轮次。
   * @param peer - 由凭据推导的 peer 身份。
   * @param sessionId - 待取消的 Session。
   * @returns 宿主取消回执。
   */
  async cancel(peer: GatewayPeer, sessionId: SessionId): Promise<SessionCancelValue> {
    await this.assertOwnedLocation(peer, sessionId)
    return this.services.sessionController.cancel({ sessionId })
  }

  /**
   * 为当前 peer 所属 Session 选择模型。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - Session 和模型路由。
   * @returns 规范化的宿主模型选择结果。
   */
  async selectModel(peer: GatewayPeer, request: GatewaySessionModelRequest): Promise<SessionSelectModelValue> {
    await this.assertOwnedLocation(peer, request.sessionId)
    return this.services.sessionController.selectModel(request)
  }

  /**
   * 通过正式权限服务设置 Session 局部的
   * 沙箱和审批预设。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - Session 和预设名称。
   * @returns 已接受的预设。
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
   * 向已选择或显式指定的 Session 投递一条
   * 普通消息；不存在活动 Session 时，在固定 cwd 下创建。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - 提示输入标识符、内容及可选 Session。
   * @param signal - 提示输入准入前的调用方取消信号。
   * @returns 宿主提示输入回执。
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
   * 执行一个已注册的 Session 命令，不开启模型轮次。
   * 命令注册表执行前拒绝宿主管理命令名称。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - 可选的活动 Session、命令行和图片输入。
   * @param signal - 命令准入及处理器生命周期信号。
   * @returns 规范化的命令执行结果；未知命令返回 undefined。
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
   * 列出当前 peer 所属 Session 中用户可调用的技能。
   * @param peer - 由凭据推导的 peer 身份。
   * @param sessionId - 其预设和 cwd 决定技能目录的 Session。
   * @param signal - 目录读取取消信号。
   * @returns 现有 Session 技能目录值。
   */
  async listSkills(peer: GatewayPeer, sessionId: SessionId, signal: AbortSignal): Promise<SkillListValue> {
    await this.assertOwnedLocation(peer, sessionId)
    return this.services.skills.list({ sessionId }, signal)
  }

  /**
   * 列出当前 peer 所属根 Session 的直接子代理。
   * @param peer - 由凭据推导的 peer 身份。
   * @param parentSessionId - 当前 peer 拥有的根 Session。
   * @param signal - 目录读取取消信号。
   * @returns 现有子代理目录。
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
   * 向当前 peer 所属的可继续子代理投递跟进消息。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - 父子地址和用户内容。
   * @param signal - inbox 接收前的调用方取消信号。
   * @returns 现有子代理提示输入回执。
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
   * 中断当前 peer 所属的可继续子代理。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - 父子地址。
   * @returns 现有中断回执。
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
   * 检查外部提供的问题回答是否指向仍有效的、
   * 归此 peer 和 Session 所有的交互。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - Session 和交互标识符。
   */
  async assertQuestionScope(peer: GatewayPeer, request: GatewayQuestionAnswerRequest): Promise<void> {
    await this.assertInteractionScope(peer, request.sessionId, request.interactionId, 'question')
  }

  /**
   * 检查外部提供的审批回答是否指向仍有效的、
   * 归此 peer 和 Session 所有的交互。
   * @param peer - 由凭据推导的 peer 身份。
   * @param request - Session 和交互标识符。
   */
  async assertApprovalScope(peer: GatewayPeer, request: GatewayApprovalAnswerRequest): Promise<void> {
    await this.assertInteractionScope(peer, request.sessionId, String(request.interactionId), 'approval')
  }

  /**
   * 返回 Agent 能否作为此网关的根交互
   * 回答方；子代理 Agent 绝不能成为问题或审批的有效所有者。
   * @param peer - 由凭据推导的 peer 身份。
   * @param sessionId - 当前 peer 拥有的根 Session。
   * @param agent - 事件监听器观测到的确切活动 Agent。
   * @returns 仅当 Agent 正是当前 peer 拥有的根 Agent 时返回 true。
   */
  async ownsRootInteractionAgent(peer: GatewayPeer, sessionId: SessionId, agent: Agent): Promise<boolean> {
    if (!(await this.ownership.ownsSession(peer, sessionId))) return false
    if (agent.session.id !== sessionId) return false
    if (this.services.isRootAgent !== undefined) return this.services.isRootAgent(agent)
    return agent.session.header.origin !== 'subagent'
  }

  /** 解析 peer 的活动 Session，或为普通消息创建 Session。 */
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

  /** 拒绝已经关联宿主 Session 的显式标识符。 */
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

  /** 将已拥有的普通 Session 解析为其活动 Agent。 */
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

  /** 校验 peer 归属和固定位置不变量。 */
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

  /** 校验 cwd 及可选的未分组归属元数据。 */
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

  /** 协议接受回答前校验交互记录。 */
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

  /** 校验子 Session 与 peer 所属父 Session 的关系。 */
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

  /** 即使通过无类型适配器调用，也拒绝禁止的位置字段。 */
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
