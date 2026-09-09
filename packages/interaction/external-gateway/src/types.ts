/** External Gateway 的传输、存储和 Session 适配器类型。 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AskUserQuestionIntent } from '@deepseek-ai/dsh-user-questions/types'

/** HTTP 和存储边界接受的无损 JSON 值。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** 外部协议客户端生成或提供的不透明标识符。 */
export type GatewayClientId = Branded<'ExternalGatewayClientId'>
/** 分配给外部投递的不透明标识符。 */
export type GatewayDeliveryId = Branded<'ExternalGatewayDeliveryId'>
/** 客户端可见交互的不透明标识符。 */
export type GatewayInteractionId = Branded<'ExternalGatewayInteractionId'>
/** outbox 事件的不透明标识符。 */
export type GatewayEventId = Branded<'ExternalGatewayEventId'>
/** 分配给可恢复二进制上传的不透明标识符。 */
export type GatewayUploadId = Branded<'ExternalGatewayUploadId'>

/** 通过网关提交的消息中的文本块。 */
export interface GatewayTextContent {
  readonly type: 'text'
  readonly text: string
}

/** 通过现有 Session Controller 接收的编码图片。 */
export interface GatewayImageContent {
  readonly type: 'image'
  /** 内嵌图片时提供；`uploadId` 指向已完成上传时省略。 */
  readonly mediaType?: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** 内嵌形式使用的规范 base64 图片字节。 */
  readonly data?: string
  /** 提示输入准入前由宿主解析的已完成图片上传。 */
  readonly uploadId?: GatewayUploadId
  readonly name?: string
}

/** 由宿主解析为图片或安全文件路径提示的已完成上传。 */
export interface GatewayUploadContent {
  readonly type: 'upload'
  readonly uploadId: GatewayUploadId
}

/** 消息内容块接受的显式文件上传形式。 */
export interface GatewayFileContent {
  readonly type: 'file'
  readonly uploadId: GatewayUploadId
}

/** 外部客户端选择的具名技能引用。 */
export interface GatewaySkillContent {
  readonly type: 'skill'
  readonly name: string
}

/** 普通 Session 消息接受的内容。 */
export type GatewayMessageContent =
  | GatewayTextContent
  | GatewayImageContent
  | GatewayUploadContent
  | GatewayFileContent
  | GatewaySkillContent

/** 各投递载荷变体携带的公共字段。 */
export interface GatewaySessionAddress {
  readonly accountId: string
  readonly peerId: string
}

/** 存储和 Session 适配器使用的、由凭据推导的身份。 */
export interface GatewayPeerIdentity extends GatewaySessionAddress {
  readonly clientId: string
}

/** 创建一个归网关所有的未分组 Session。 */
export interface GatewaySessionCreatePayload {
  readonly type: 'session-create'
  readonly title?: string
  readonly model?: GatewayModelSelection
  readonly permissionPreset?: string
}

/** 将一个归网关所有的 Session 设为活动 Session。 */
export interface GatewaySessionSelectPayload {
  readonly type: 'session-select'
  readonly sessionId: SessionId
}

/** 重命名一个归网关所有的 Session。 */
export interface GatewaySessionRenamePayload {
  readonly type: 'session-rename'
  readonly sessionId: SessionId
  readonly title: string
}

/** 分叉一个归网关所有的 Session。 */
export interface GatewaySessionForkPayload {
  readonly type: 'session-fork'
  readonly sessionId: SessionId
  readonly eventSeq?: number
}

/** 取消一个活动 Session 轮次。 */
export interface GatewaySessionCancelPayload {
  readonly type: 'session-cancel'
  readonly sessionId?: SessionId
}

/** 为单个 Session 选择的提供方与模型路由。 */
export interface GatewayModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** 为一个归网关所有的 Session 选择模型。 */
export interface GatewayModelSelectPayload {
  readonly type: 'model-select'
  readonly sessionId: SessionId
  readonly selection: GatewayModelSelection
}

/** 为 Session 选择一个现有的沙箱和审批预设。 */
export interface GatewayPermissionSelectPayload {
  readonly type: 'permission-select'
  readonly sessionId: SessionId
  readonly preset: string
}

/** 向活动或显式指定的 Session 提交消息。 */
export interface GatewayMessagePayload {
  readonly type: 'message'
  /** 消息使用活动 Session 时由网关预留的目标。 */
  readonly sessionId?: SessionId
  readonly content: readonly GatewayMessageContent[]
  readonly mode?: 'queue' | 'steer'
}

/** 执行一个会话级斜杠命令，不将其发送给模型。 */
export interface GatewayCommandPayload {
  readonly type: 'command'
  readonly sessionId?: SessionId
  readonly command: string
}

/** 回答一个待决问题交互。 */
export interface GatewayQuestionAnswerPayload {
  readonly type: 'question-answer'
  readonly interactionId: GatewayInteractionId
  readonly answers: readonly GatewayQuestionAnswer[]
}

/** 问题的单个结构化回答项。 */
export interface GatewayQuestionAnswer {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** 回答一个待决审批交互。 */
export interface GatewayApprovalAnswerPayload {
  readonly type: 'approval-answer'
  readonly interactionId: GatewayInteractionId
  readonly outcome: 'allowed-once' | 'rejected'
}

/** 继续一个归网关所有的子代理。 */
export interface GatewaySubagentFollowupPayload {
  readonly type: 'subagent-followup'
  readonly sessionId: SessionId
  readonly agentId: string
  readonly content: readonly GatewayMessageContent[]
}

/** 中断一个归网关所有的子代理。 */
export interface GatewaySubagentInterruptPayload {
  readonly type: 'subagent-interrupt'
  readonly sessionId: SessionId
  readonly agentId: string
}

/** 请求单个 Session 的持久化导出产物。 */
export interface GatewaySessionExportPayload {
  readonly type: 'session-export'
  readonly sessionId: SessionId
}

/** `/v1/deliveries` 接受的所有变更操作。 */
export type GatewayPayload =
  | GatewaySessionCreatePayload
  | GatewaySessionSelectPayload
  | GatewaySessionRenamePayload
  | GatewaySessionForkPayload
  | GatewaySessionCancelPayload
  | GatewayModelSelectPayload
  | GatewayPermissionSelectPayload
  | GatewayMessagePayload
  | GatewayCommandPayload
  | GatewayQuestionAnswerPayload
  | GatewayApprovalAnswerPayload
  | GatewaySubagentFollowupPayload
  | GatewaySubagentInterruptPayload
  | GatewaySessionExportPayload

/** 已接受但尚未写入持久化 inbox 的单次变更。 */
export interface GatewayDelivery extends GatewaySessionAddress {
  readonly deliveryId: GatewayDeliveryId
  readonly payload: GatewayPayload
}

/** 网关持久化的投递生命周期。 */
export type GatewayDeliveryStatus = 'pending' | 'completed' | 'failed'

/** 单条持久化 inbox 记录。 */
export interface GatewayDeliveryRecord extends GatewayDelivery {
  readonly clientId: GatewayClientId
  readonly digest: string
  readonly status: GatewayDeliveryStatus
  /** 调度自动创建操作前预留的 Session ID。 */
  readonly reservedSessionId?: SessionId
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly result?: JsonValue
}

/** 通过 `/v1/events` 发出的事件名称。 */
export type GatewayEventType =
  | 'delivery-completed'
  | 'delivery-failed'
  | 'session-created'
  | 'session-selected'
  | 'session-updated'
  | 'session-event'
  | 'assistant-final'
  | 'question'
  | 'approval'
  | 'interaction-expired'
  | 'subagent-started'
  | 'subagent-finished'
  | 'artifact-ready'
  | 'turn-failed'

/** 向外部客户端提供的结构化问题。 */
export interface GatewayQuestion {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
  /** 从宿主用户问题请求复制的展示意图。 */
  readonly intent?: AskUserQuestionIntent
}

/** 可恢复上传协议接受的数据类型。 */
export type GatewayUploadKind = 'image' | 'file'
/** 单次网关上传的生命周期。 */
export type GatewayUploadStatus = 'pending' | 'completed'

/** 单个已持久化的二进制上传分块。 */
export interface GatewayUploadPartRecord {
  readonly partNumber: number
  readonly bytes: number
  readonly digest: string
  /** 所有者私有的临时路径；绝不从传输请求中接受。 */
  readonly path: string
}

/** 单次上传按所有者隔离的持久化元数据和已接收分块状态。 */
export interface GatewayUploadRecord extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly uploadId: GatewayUploadId
  readonly kind: GatewayUploadKind
  readonly filename: string
  readonly contentType: string
  readonly size: number
  readonly sha256?: string
  readonly chunkSize: number
  readonly totalParts: number
  readonly parts: readonly GatewayUploadPartRecord[]
  /** 固定网关 cwd 下所有者私有的已完成文件路径。 */
  readonly path: string
  readonly status: GatewayUploadStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
}

/** 用于创建或恢复上传的客户端元数据。 */
export interface GatewayUploadInitRequest extends GatewaySessionAddress {
  /** 客户端可选指定的 ID，用于初始化重试的幂等处理。 */
  readonly uploadId?: GatewayUploadId
  readonly kind: GatewayUploadKind
  readonly filename: string
  readonly contentType: string
  readonly size: number
  readonly sha256?: string
}

/** 提交上传时提供的可选校验和。 */
export interface GatewayUploadCompleteRequest {
  readonly sha256?: string
}

/** 上传接口返回的公开元数据。 */
export interface GatewayUploadReceipt {
  readonly uploadId: GatewayUploadId
  readonly status: GatewayUploadStatus
  readonly kind: GatewayUploadKind
  readonly filename: string
  readonly contentType: string
  readonly size: number
  readonly chunkSize: number
  readonly totalParts: number
  readonly receivedParts: readonly number[]
  readonly sha256?: string
  /** 可嵌入后续 `message` 投递的内容块。 */
  readonly content: GatewayUploadContent
}

/** 存储在持久化 outbox 中的事件载荷。 */
export type GatewayEventPayload =
  | { readonly type: 'delivery-completed'; readonly deliveryId: GatewayDeliveryId; readonly result?: JsonValue }
  | { readonly type: 'delivery-failed'; readonly deliveryId: GatewayDeliveryId; readonly code: string; readonly message: string }
  | { readonly type: 'session-created'; readonly sessionId: SessionId }
  | { readonly type: 'session-selected'; readonly sessionId: SessionId }
  | { readonly type: 'session-updated'; readonly sessionId: SessionId; readonly changes: JsonValue }
  | { readonly type: 'session-event'; readonly sessionId: SessionId; readonly event: JsonValue }
  | { readonly type: 'assistant-final'; readonly sessionId: SessionId; readonly text: string }
  | { readonly type: 'question'; readonly sessionId: SessionId; readonly interactionId: GatewayInteractionId; readonly expiresAt: number; readonly questions: readonly GatewayQuestion[] }
  | { readonly type: 'approval'; readonly sessionId: SessionId; readonly interactionId: GatewayInteractionId; readonly expiresAt: number; readonly toolName: string; readonly reason?: string }
  | { readonly type: 'interaction-expired'; readonly sessionId: SessionId; readonly interactionId: GatewayInteractionId; readonly kind: 'question' | 'approval' }
  | { readonly type: 'subagent-started'; readonly sessionId: SessionId; readonly agentId: string }
  | { readonly type: 'subagent-finished'; readonly sessionId: SessionId; readonly agentId: string; readonly result?: JsonValue }
  | { readonly type: 'artifact-ready'; readonly sessionId: SessionId; readonly artifactId: string }
  | { readonly type: 'turn-failed'; readonly sessionId: SessionId; readonly message: string }

/** 返回给客户端的单个 outbox 事件。 */
export interface GatewayEvent {
  readonly clientId: GatewayClientId
  readonly sequence: number
  readonly eventId: GatewayEventId
  readonly accountId: string
  readonly peerId: string
  readonly sessionId?: SessionId
  readonly causedByDeliveryId?: GatewayDeliveryId
  readonly payload: GatewayEventPayload
  readonly createdAt: number
}

/** 持久化 outbox 记录。 */
export interface GatewayOutboxRecord extends GatewayEvent {
  readonly acknowledged?: boolean
}

/** 单个已认证客户端的序号状态。 */
export interface GatewayClientStateRecord {
  readonly clientId: GatewayClientId
  readonly nextSequence: number
  readonly acknowledgedSequence: number
}

/** 网关持久化的 Session 归属。 */
export interface GatewaySessionOwnershipRecord {
  readonly clientId: GatewayClientId
  readonly accountId: string
  readonly peerId: string
  readonly sessionId: SessionId
  readonly cwd: string
  readonly createdAt: number
  readonly status: 'pending' | 'ready'
  readonly active: boolean
}

/** 单个客户端、账号和 peer 对话的活动 Session 映射。 */
export interface GatewayConversationRecord extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly sessionId?: SessionId
  readonly updatedAt: number
}

/** 问题或审批交互的持久化归属和有效期。 */
export interface GatewayInteractionRecord extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly sessionId: SessionId
  readonly interactionId: GatewayInteractionId
  readonly kind: 'question' | 'approval'
  readonly expiresAt: number
  readonly status: 'pending' | 'answered' | 'expired'
}

/** 最后一个已持久化复制到网关 outbox 的 Session 事件。 */
export interface GatewayProjectionCursorRecord {
  readonly sessionId: SessionId
  readonly sequence: number
}

/** 归 peer 所有的可下载产物的持久化元数据。 */
export interface GatewayArtifactRecord extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly artifactId: string
  readonly sessionId: SessionId
  readonly path: string
  readonly filename: string
  readonly contentType: string
  readonly createdAt: number
}

/** 网关接受的单个客户端声明。 */
export interface GatewayClientConfig {
  readonly clientId: string
  readonly tokenFile: string
  readonly accountIds?: readonly string[]
  readonly peerIds?: readonly string[]
}

/** Cordis 插件加载的运行时策略。 */
export interface ExternalGatewayConfig {
  readonly tokenFile: string
  readonly artifactDirectory: string
  readonly clientId: string
  readonly accountIds: string[]
  readonly peerIds: string[]
  readonly maxBodyBytes: number
  readonly maxTextBytes: number
  readonly maxEvents: number
  readonly maxPollMs: number
  readonly completedRetentionMs: number
  readonly maxOutbox: number
  readonly interactionTimeoutMs: number
  readonly maxUploadBytes: number
  readonly maxImageBytes: number
  readonly startupCwd?: string
}

/** 交给 Session 适配器的运行时地址和载荷。 */
export interface ExternalGatewayDispatchRequest extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly deliveryId: GatewayDeliveryId
  readonly payload: GatewayPayload
  /** 创建或消息自动创建操作使用的预留 ID。 */
  readonly reservedSessionId?: SessionId
  readonly cwd: string
}

/** 单次适配器变更的结果。 */
export interface ExternalGatewayDispatchResult {
  readonly sessionId?: SessionId
  readonly result?: JsonValue
}

/** 统一外部协议暴露的查询操作。 */
export type ExternalGatewayQueryOperation =
  | 'sessions'
  | 'session'
  | 'history'
  | 'models'
  | 'skills'
  | 'subagents'
  | 'artifact'

/** 交给 Session 适配器的只读操作。 */
export interface ExternalGatewayQueryRequest extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly operation: ExternalGatewayQueryOperation
  readonly sessionId?: SessionId
  readonly artifactId?: string
  readonly cursor?: string
  readonly limit?: number
}

/** 查询操作的 JSON 响应。 */
export interface ExternalGatewayJsonQueryResult {
  readonly kind: 'json'
  readonly value: JsonValue
}

/** 产物操作的二进制响应。 */
export interface ExternalGatewayBytesQueryResult {
  readonly kind: 'bytes'
  readonly contentType: string
  readonly body: Uint8Array
  readonly filename?: string
}

/** 只读操作的结果。 */
export type ExternalGatewayQueryResult = ExternalGatewayJsonQueryResult | ExternalGatewayBytesQueryResult

/** Session 适配器观测到网关所属 Session 后发出的运行时事件。 */
export interface ExternalGatewayRuntimeEvent extends GatewaySessionAddress {
  readonly clientId: GatewayClientId
  readonly sessionId: SessionId
  readonly payload: GatewayEventPayload
  /** 用于崩溃安全重放和去重的持久化 Session 事件序号。 */
  readonly sourceSequence?: number
  readonly interaction?: Omit<GatewayInteractionRecord, 'status'>
}

/** 由 Session 运行时包实现的适配器。 */
export interface ExternalGatewayRuntime {
  /** 每个新建的网关所属 Session 使用的固定 cwd。 */
  readonly startupCwd: string
  /** 对网关所属 Session 执行一次持久化变更。 */
  dispatch(request: ExternalGatewayDispatchRequest, signal: AbortSignal): Promise<ExternalGatewayDispatchResult>
  /** 读取一个网关所属投影或产物。 */
  query(request: ExternalGatewayQueryRequest, signal: AbortSignal): Promise<ExternalGatewayQueryResult>
  /** 订阅最终回复、问题、审批及 Session 事件。 */
  subscribe(listener: (event: ExternalGatewayRuntimeEvent) => Promise<void>): () => void
  /** 重放尚未到达网关 outbox 的持久化 Session 事件。 */
  replay(): Promise<void>
}

/** HTTP 传输层使用的路由注册接口。 */
export interface GatewayHttpCarrier {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
  registerUpgrade?(route: {
    readonly path: string
    readonly handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  }): () => void
}

/** API 接受的已存储投递的公开投影。 */
export interface GatewayDeliveryReceipt {
  readonly deliveryId: GatewayDeliveryId
  readonly status: GatewayDeliveryStatus
  readonly duplicate?: boolean
}
