/** 将外部正文、查询参数和资源路径解析为 DTO；不执行存储或 Agent 操作。 */
import type { GatewayDraft } from '../construction-types.ts'
import type { URLSearchParams } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { GatewayUploadId } from '../brand.ts'
import { HttpInputError } from '../http/errors.ts'
import {
  gatewayDeliverySchema, gatewayAckSchema, gatewayUploadInitSchema, gatewayUploadCompleteSchema,
} from '../schema.ts'
import type { ExternalGatewayConfig, GatewayClientId } from '../types.ts'
import type {
  DeliveryRequest, EventsRequest, AckRequest, SessionQueryRequest, ArtifactRequest,
  UploadCreateRequest, UploadRequest, UploadCompleteRequest, AuthenticatedPeer,
} from './types.ts'

/**
 * 将外部 JSON 校验失败转换为协议错误。
 * @param schema - 协议解析器。
 * @param body - 未校验的 JSON。
 * @returns 已校验的数据。
 */
export function parseWithSchema<T>(schema: { parse(value: unknown): T }, body: unknown): T {
  try {
    return schema.parse(body)
  } catch (error) {
    throw new HttpInputError(400, 'invalid_request', error instanceof Error ? error.message : 'request does not match the protocol')
  }
}

/**
 * 限制请求中每个字符串的 UTF-8 字节数。
 * @param value - 请求数据。
 * @param maxBytes - 单个字符串的字节上限。
 */
export function assertTextBudget(value: unknown, maxBytes: number): void {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      throw new HttpInputError(413, 'text_too_large', 'request text exceeds the configured limit')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertTextBudget(item, maxBytes)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) assertTextBudget(item, maxBytes)
  }
}

/**
 * 解析有上限的非负整数查询参数。
 * @param value - 原始参数。
 * @param name - 错误信息中的参数名。
 * @param fallback - 参数缺省值。
 * @param max - 最大允许值。
 * @returns 已校验的整数。
 */
export function queryInteger(value: string | null, name: string, fallback: number, max: number): number {
  if (value === null || value === '') return fallback
  if (!/^\d+$/u.test(value)) throw new HttpInputError(400, 'invalid_query', `${name} must be a non-negative integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new HttpInputError(400, 'invalid_query', `${name} is outside the configured limit`)
  }
  return parsed
}

/**
 * 拆分并解码资源路径。
 * @param pathname - 请求路径。
 * @param prefix - 接口路径前缀。
 * @returns 解码后的子路径。
 */
export function pathParts(pathname: string, prefix: string): string[] {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return []
  return pathname.slice(prefix.length).split('/').filter(Boolean).map((value) => {
    try {
      return decodeURIComponent(value)
    } catch {
      throw new HttpInputError(400, 'invalid_path', 'path contains an invalid escape')
    }
  })
}

/**
 * 绑定查询地址与认证身份。
 * @param params - 外部查询参数。
 * @param clientId - 认证客户端。
 * @returns 已绑定客户端的 peer 地址。
 */
export function peerRequest(params: URLSearchParams, clientId: GatewayClientId): AuthenticatedPeer {
  const accountId = params.get('accountId')
  const peerId = params.get('peerId')
  if (accountId === null || peerId === null || accountId.length === 0 || peerId.length === 0) {
    throw new HttpInputError(400, 'missing_address', 'accountId and peerId query parameters are required')
  }
  return { clientId, accountId, peerId }
}

/**
 * 解析可靠投递正文。
 * @param body - 外部 JSON。
 * @param clientId - 认证客户端。
 * @param config - 已校验限制。
 * @returns 投递 DTO。
 */
export function deliveryRequest(body: unknown, clientId: GatewayClientId, config: ExternalGatewayConfig): DeliveryRequest {
  const delivery = parseWithSchema(gatewayDeliverySchema, body)
  assertTextBudget(delivery, config.maxTextBytes)
  return { clientId, delivery }
}

/**
 * 解析长轮询参数。
 * @param params - 外部查询参数。
 * @param clientId - 认证客户端。
 * @param config - 默认值与上限。
 * @returns 长轮询 DTO。
 */
export function eventsRequest(params: URLSearchParams, clientId: GatewayClientId, config: ExternalGatewayConfig): EventsRequest {
  return {
    clientId,
    after: queryInteger(params.get('after'), 'after', 0, Number.MAX_SAFE_INTEGER),
    limit: queryInteger(params.get('limit'), 'limit', config.maxEvents, config.maxEvents),
    waitMs: queryInteger(params.get('waitMs'), 'waitMs', config.maxPollMs, config.maxPollMs),
  }
}

/**
 * 解析连续确认正文。
 * @param body - 外部 JSON。
 * @param clientId - 认证客户端。
 * @returns 确认 DTO。
 */
export function ackRequest(body: unknown, clientId: GatewayClientId): AckRequest {
  const acknowledgement = parseWithSchema(gatewayAckSchema, body)
  return { clientId, upToSequence: acknowledgement.upToSequence }
}

/**
 * 解析上传元数据。
 * @param body - 外部 JSON。
 * @param clientId - 认证客户端。
 * @param config - 字符串限制。
 * @returns 上传创建 DTO。
 */
export function uploadCreateRequest(body: unknown, clientId: GatewayClientId, config: ExternalGatewayConfig): UploadCreateRequest {
  const upload = parseWithSchema(gatewayUploadInitSchema, body)
  assertTextBudget(upload, config.maxTextBytes)
  return { clientId, upload }
}

/**
 * 解析单个上传资源地址。
 * @param parts - 已解码子路径。
 * @param peer - 已认证地址。
 * @returns 上传资源 DTO。
 */
export function uploadRequest(parts: readonly string[], peer: AuthenticatedPeer): UploadRequest {
  if (parts.length === 0) throw new HttpInputError(404, 'not_found', 'resource was not found')
  return { peer, uploadId: GatewayUploadId(parts[0] as string) }
}

/**
 * 解析上传完成正文。
 * @param body - 外部 JSON。
 * @param request - 已认证上传。
 * @returns 完成 DTO。
 */
export function uploadCompleteRequest(body: unknown, request: UploadRequest): UploadCompleteRequest {
  return {
    peer: request.peer,
    uploadId: request.uploadId,
    completion: parseWithSchema(gatewayUploadCompleteSchema, body),
  }
}

/**
 * 解析分块编号。
 * @param value - 路径中的分块编号。
 * @returns 非负安全整数。
 */
export function uploadPartNumber(value: string): number {
  if (!/^\d+$/u.test(value)) throw new HttpInputError(400, 'invalid_path', 'part number is invalid')
  const part = Number(value)
  if (!Number.isSafeInteger(part)) throw new HttpInputError(400, 'invalid_path', 'part number is invalid')
  return part
}

/**
 * 解析 Session 查询。
 * @param parts - 已解码子路径。
 * @param params - 分页参数。
 * @param peer - 已认证地址。
 * @param config - 分页上限。
 * @returns Session 查询 DTO。
 */
export function sessionRequest(
  parts: readonly string[],
  params: URLSearchParams,
  peer: AuthenticatedPeer,
  config: ExternalGatewayConfig,
): SessionQueryRequest {
  const limit = queryInteger(params.get('limit'), 'limit', config.maxEvents, config.maxEvents)
  let operation: SessionQueryRequest['operation']
  let sessionId: string | undefined
  if (parts.length === 0) operation = 'sessions'
  else if (parts.length === 1) { operation = 'session'; sessionId = parts[0] }
  else if (parts.length === 2 && ['history', 'models', 'skills', 'subagents'].includes(parts[1] as string)) {
    operation = parts[1] as 'history' | 'models' | 'skills' | 'subagents'
    sessionId = parts[0]
  } else throw new HttpInputError(404, 'not_found', 'resource was not found')
  const rawCursor = params.get('cursor')
  const request: GatewayDraft<SessionQueryRequest> = {
    clientId: peer.clientId,
    accountId: peer.accountId,
    peerId: peer.peerId,
    operation,
  }
  if (sessionId !== undefined) {
    request.sessionId = SessionId(sessionId)
  }
  if (rawCursor !== null) {
    request.cursor = String(queryInteger(rawCursor, 'cursor', 0, Number.MAX_SAFE_INTEGER))
  }
  if (operation === 'sessions' || operation === 'history') {
    request.limit = limit
  }
  return request
}

/**
 * 解析产物路径。
 * @param parts - 已解码子路径。
 * @param peer - 已认证地址。
 * @returns 产物查询 DTO。
 */
export function artifactRequest(parts: readonly string[], peer: AuthenticatedPeer): ArtifactRequest {
  if (parts.length !== 1) throw new HttpInputError(404, 'not_found', 'resource was not found')
  return { ...peer, operation: 'artifact', artifactId: parts[0] as string }
}
