/** /v1 请求与响应 DTO；持久化记录不作为控制器返回类型。 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  GatewayClientId, GatewayPeerIdentity, GatewayDelivery, GatewayDeliveryReceipt,
  GatewayEvent, GatewayUploadId, GatewayUploadInitRequest, GatewayUploadCompleteRequest,
  GatewayUploadReceipt, ExternalGatewayQueryRequest, ExternalGatewayQueryResult,
} from '../types.ts'

export type { GatewayDeliveryReceipt, GatewayUploadReceipt, ExternalGatewayQueryResult } from '../types.ts'

/** Token 认证后绑定的 peer 地址，保留客户端 ID 的品牌类型。 */
export interface AuthenticatedPeer extends GatewayPeerIdentity {
  readonly clientId: GatewayClientId
}

/** 已认证的可靠投递请求；clientId 来自 Token。 */
export interface DeliveryRequest {
  readonly clientId: GatewayClientId
  readonly delivery: GatewayDelivery
}
/** 客户端主动长轮询的已校验参数。 */
export interface EventsRequest {
  readonly clientId: GatewayClientId
  readonly after: number
  readonly limit: number
  readonly waitMs: number
}
/** 客户端已完成处理的连续事件确认。 */
export interface AckRequest {
  readonly clientId: GatewayClientId
  readonly upToSequence: number
}
/** 事件正文及下一轮排他游标。 */
export interface EventsResponse {
  readonly events: readonly GatewayEvent[]
  readonly nextSequence: number
}
/** 已持久化的事件确认结果。 */
export interface AckResponse {
  readonly upToSequence: number
  readonly removed: number
}
/** 上传集合查询的已认证地址。 */
export type UploadListRequest = AuthenticatedPeer
/** 创建上传任务的已校验元数据。 */
export interface UploadCreateRequest {
  readonly clientId: GatewayClientId
  readonly upload: GatewayUploadInitRequest
}
/** 单个上传资源的已认证地址与标识。 */
export interface UploadRequest {
  readonly peer: AuthenticatedPeer
  readonly uploadId: GatewayUploadId
}
/** 上传完成请求；只校验已有分块，不提交 Agent。 */
export interface UploadCompleteRequest extends UploadRequest {
  readonly completion: GatewayUploadCompleteRequest
}
/** 有界二进制上传分块，不经过 JSON 编码。 */
export interface UploadPartRequest extends UploadRequest {
  readonly partNumber: number
  readonly bytes: Uint8Array
}
/** 上传集合的公开回执。 */
export interface UploadListResponse {
  readonly uploads: readonly GatewayUploadReceipt[]
}
/** 上传创建结果；duplicate 仅供适配层选择 HTTP 状态码。 */
export interface UploadCreateResult {
  readonly upload: GatewayUploadReceipt
  readonly duplicate: boolean
}
/** 分块确认不包含存储路径。 */
export interface UploadPartResponse {
  readonly upload: GatewayUploadReceipt
  readonly part: { readonly partNumber: number; readonly bytes: number; readonly digest: string }
  readonly duplicate?: boolean
}
/** Session 查询沿用运行时的投影协议，不包含宿主管理操作。 */
export type SessionQueryRequest = ExternalGatewayQueryRequest & {
  readonly operation: 'sessions' | 'session' | 'history' | 'models' | 'skills' | 'subagents'
  readonly sessionId?: SessionId
}
/** 产物读取请求，由运行时校验产物归属。 */
export type ArtifactRequest = ExternalGatewayQueryRequest & { readonly operation: 'artifact'; readonly artifactId: string }
/** Session 和产物响应复用现有运行时明确的 JSON/二进制判别类型。 */
export type QueryResponse = ExternalGatewayQueryResult
/** 网关所有 JSON 接口的响应 DTO；查询投影由运行时定义。 */
export type GatewayJsonResponse = GatewayDeliveryReceipt | EventsResponse | AckResponse
  | GatewayUploadReceipt | UploadListResponse | UploadPartResponse
