/**
 * HTTP 正文读取与请求取消；协议字段解析位于 protocol/requests.ts。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import getRawBody from 'raw-body'
import { HttpInputError } from './errors.ts'
import { emptyResponse } from './response.ts'

/**
 * 检查 HTTP 方法，不匹配时发送 405。
 * @param req - 入站请求。
 * @param res - 响应。
 * @param expected - 接口接受的方法。
 * @returns 方法是否匹配。
 */
export function method(req: IncomingMessage, res: ServerResponse, expected: string): boolean {
  if (req.method === expected) return true
  res.setHeader('allow', expected)
  emptyResponse(res, 405)
  return false
}

/**
 * 判断请求是否声明 JSON 正文。
 * @param req - 入站请求。
 * @returns 是否为 application/json。
 */
export function jsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type']
  return typeof contentType === 'string' && /^application\/json(?:\s*;|\s*$)/iu.test(contentType)
}

/**
 * 读取有界 JSON 正文，仅显式允许时接受空正文。
 * @param req - 入站请求。
 * @param maxBytes - 正文字节上限。
 * @param allowEmpty - 空正文是否返回空对象。
 * @returns 解析后的未校验 JSON。
 */
export async function readBody(req: IncomingMessage, maxBytes: number, allowEmpty: boolean = false): Promise<unknown> {
  const body = await readRawBody(req, maxBytes, 'json')
  if (allowEmpty && body.length === 0) return {}
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch (error) {
    throw new HttpInputError(400, 'invalid_json', error instanceof Error ? error.message : 'request body is not valid JSON')
  }
}

/**
 * 通过 raw-body 有界读取正文并保留协议超限错误码。
 * @param req - 入站请求。
 * @param maxBytes - 正文字节上限。
 * @param kind - 决定超限错误码的正文类型。
 * @returns 原始正文字节。
 */
export async function readRawBody(req: IncomingMessage, maxBytes: number, kind: 'json' | 'upload'): Promise<Buffer> {
  const tooLarge = (): HttpInputError => {
    if (kind === 'upload') {
      return new HttpInputError(413, 'upload_part_too_large', 'upload part exceeds the 4 MiB limit')
    }
    return new HttpInputError(413, 'body_too_large', 'request body exceeds the configured limit')
  }
  const length = req.headers['content-length']
  try {
    if (length !== undefined && (!Number.isSafeInteger(Number(length)) || Number(length) < 0)) {
      throw tooLarge()
    }
    const options: { limit: number; length?: string } = { limit: maxBytes }
    if (length !== undefined) {
      options.length = length
    }
    return await getRawBody(req, options)
  } catch (error) {
    // raw-body 在读取失败时暂停流；丢弃剩余正文，让 HTTP 响应和连接收尾。
    if (!req.destroyed) req.resume()
    if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') throw tooLarge()
    throw error
  }
}

/**
 * 将请求关闭绑定到取消信号；调用者必须释放监听器。
 * @param req - 入站请求。
 * @returns 信号与监听器释放函数。
 */
export function requestAbortSignal(req: IncomingMessage): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  req.once('aborted', abort)
  req.once('close', abort)
  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', abort)
      req.off('close', abort)
    },
  }
}
