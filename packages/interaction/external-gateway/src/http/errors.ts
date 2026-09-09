/**
 * 将协议、存储和运行时失败映射为安全的 HTTP 错误。
 */
import { ExternalGatewayStoreError } from '../storage.ts'

/**
 * 包含稳定状态码和错误码的 HTTP 解析错误。
 */
export class HttpInputError extends Error {
  /**
   * HTTP 状态码。
   */
  readonly status: number
  /**
   * 协议错误码。
   */
  readonly errorCode: string

  /**
   * @param status - HTTP 响应状态码。
   * @param errorCode - 稳定错误码。
   * @param message - 安全的诊断信息。
   */
  constructor(status: number, errorCode: string, message: string) {
    super(message)
    this.name = 'HttpInputError'
    this.status = status
    this.errorCode = errorCode
  }
}

/**
 * 返回对外可见的状态码和错误信息。
 * @param error - 协议、存储或运行时错误。
 * @returns 安全的 HTTP 错误字段。
 */
export function errorStatus(error: unknown): { readonly status: number; readonly code: string; readonly message: string } {
  if (error instanceof HttpInputError) return { status: error.status, code: error.errorCode, message: error.message }
  if (error instanceof ExternalGatewayStoreError) {
    switch (error.code) {
      case 'delivery-conflict': return { status: 409, code: 'delivery_conflict', message: error.message }
      case 'delivery-not-found': return { status: 404, code: 'not_found', message: error.message }
      case 'session-not-owned': return { status: 404, code: 'not_found', message: 'resource was not found' }
      case 'session-conflict': return { status: 409, code: 'session_conflict', message: error.message }
      case 'interaction-not-found': return { status: 404, code: 'not_found', message: 'resource was not found' }
      case 'invalid-ack': return { status: 409, code: 'invalid_ack', message: error.message }
      case 'outbox-backpressure': return { status: 503, code: 'outbox_backpressure', message: 'client event backlog is full' }
      case 'poll-in-progress': return { status: 409, code: 'poll_in_progress', message: error.message }
      case 'upload-not-found': return { status: 404, code: 'not_found', message: 'resource was not found' }
      case 'upload-conflict': return { status: 409, code: 'upload_conflict', message: error.message }
      case 'upload-part-conflict': return { status: 409, code: 'upload_part_conflict', message: error.message }
      case 'upload-incomplete': return { status: 409, code: 'upload_incomplete', message: error.message }
      case 'upload-checksum-mismatch': return { status: 409, code: 'upload_checksum_mismatch', message: error.message }
      case 'upload-too-large': return { status: 413, code: 'upload_too_large', message: error.message }
      case 'upload-invalid': return { status: 400, code: 'invalid_upload', message: error.message }
      case 'upload-corrupt': return { status: 500, code: 'gateway_error', message: 'stored upload failed integrity validation' }
      default: return { status: 500, code: 'gateway_error', message: 'gateway storage operation failed' }
    }
  }
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    switch (error.code) {
      case 'session-not-owned':
      case 'session-location-invalid':
      case 'subagent-not-owned':
      case 'interaction-not-owned':
        return { status: 404, code: 'not_found', message: 'resource was not found' }
      case 'command-not-allowed': return { status: 403, code: 'forbidden', message: 'command is not available through the external gateway' }
      case 'invalid-location': return { status: 400, code: 'invalid_request', message: 'Session location is not valid for the external gateway' }
      case 'interaction-scope-unavailable': return { status: 409, code: 'interaction_unavailable', message: 'interaction is no longer available' }
      case 'interaction-expired': return { status: 409, code: 'interaction_expired', message: 'interaction is no longer available' }
      case 'not-found': return { status: 404, code: 'not_found', message: 'resource was not found' }
      case 'export-unavailable': return { status: 501, code: 'export_unavailable', message: 'Session export is unavailable' }
      case 'bad-request':
      case 'model-unavailable':
      case 'agent-preset-conflict':
        return { status: 400, code: 'invalid_request', message: error instanceof Error ? error.message : 'request is invalid' }
      default: break
    }
  }
  return { status: 500, code: 'gateway_error', message: 'gateway operation failed' }
}
