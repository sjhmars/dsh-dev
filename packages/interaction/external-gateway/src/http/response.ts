/**
 * HTTP JSON、文件响应与统一错误输出。
 */
import type { ServerResponse, OutgoingHttpHeaders } from 'node:http'
import type { ExternalGatewayQueryResult, JsonValue } from '../types.ts'
import type { GatewayJsonResponse } from '../protocol/types.ts'
import { errorStatus } from './errors.ts'

/**
 * 发送禁止缓存的 JSON 响应。
 * @param res - 响应。
 * @param status - HTTP 状态码。
 * @param value - JSON 数据。
 */
export function jsonResponse(res: ServerResponse, status: number, value: JsonValue | GatewayJsonResponse): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 发送无正文的响应。
 * @param res - 响应。
 * @param status - HTTP 状态码。
 */
export function emptyResponse(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}

/**
 * 发送统一协议错误。
 * @param res - 响应。
 * @param status - HTTP 状态码。
 * @param error - 稳定错误码。
 * @param message - 安全错误信息。
 * @param details - 可选错误详情。
 */
export function fail(res: ServerResponse, status: number, error: string, message: string, details?: JsonValue): void {
  const response: { error: string; message: string; details?: JsonValue } = { error, message }
  if (details !== undefined) {
    response.details = details
  }
  jsonResponse(res, status, response)
}

/**
 * 发送运行时的 JSON 或文件查询结果。
 * @param res - 响应。
 * @param result - 运行时查询结果。
 */
export function sendQueryResult(res: ServerResponse, result: ExternalGatewayQueryResult): void {
  if (result.kind === 'json') {
    jsonResponse(res, 200, result.value)
    return
  }
  const headers: OutgoingHttpHeaders = {
    'content-type': result.contentType,
    'content-length': result.body.byteLength,
    'cache-control': 'no-store',
  }
  if (result.filename !== undefined) {
    const filename = result.filename.replace(/["\r\n]/gu, '')
    headers['content-disposition'] = `attachment; filename="${filename}"`
  }
  res.writeHead(200, headers)
  res.end(result.body)
}

/**
 * 将内部失败映射为对外错误响应。
 * @param res - 响应。
 * @param error - 捕获的失败。
 */
export function replyError(res: ServerResponse, error: unknown): void {
  const status = errorStatus(error)
  fail(res, status.status, status.code, status.message)
}
