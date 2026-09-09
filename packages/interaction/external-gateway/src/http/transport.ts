/** 统一 HTTP 认证、请求取消、正文读取和响应发送；Controller 不接触 Node 请求对象。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { GatewayClientId, GatewayPeerIdentity } from '../types.ts'
import type { ExternalGatewayHttpOptions } from './types.ts'
import type { GatewayJsonResponse, QueryResponse } from '../protocol/types.ts'
import { GatewayHttpAccess } from './access.ts'
import { HttpInputError } from './errors.ts'
import { method, jsonContentType, readBody, requestAbortSignal } from './request.ts'
import { jsonResponse, replyError, sendQueryResult } from './response.ts'

/** HTTP 解析阶段提供的身份、查询参数和取消信号。 */
export interface HttpRequestContext {
  readonly clientId: GatewayClientId
  readonly url: URL
  readonly signal: AbortSignal
}
/** 成功响应保留每个接口的 DTO 或二进制结果，不增加统一 JSON 外壳。 */
export type HttpResult =
  | { readonly kind: 'dto'; readonly status: number; readonly body: GatewayJsonResponse }
  | { readonly kind: 'query'; readonly result: QueryResponse }
  | { readonly kind: 'empty' }

/**
 * 包装已定型的响应 DTO。
 * @param status - HTTP 状态码。
 * @param body - 协议 DTO。
 * @returns 待发送结果。
 */
export function dtoResult(status: number, body: GatewayJsonResponse): HttpResult {
  return { kind: 'dto', status, body }
}

/** 各路由复用的传输处理，不承担业务调度或数据库事务。 */
export class GatewayHttpTransport {
  private readonly access: GatewayHttpAccess
  /**
   * @param options - 认证及请求大小配置。
   */
  constructor(private readonly options: Pick<ExternalGatewayHttpOptions, 'config' | 'token'>) {
    this.access = new GatewayHttpAccess(options.token, options.config)
  }

  /**
   * 认证并执行一个接口适配器，统一释放请求监听器和编码失败。
   * @param req - Node 请求。
   * @param res - Node 响应。
   * @param expectedMethod - 固定方法；动态上传子路径在适配器中检查方法。
   * @param run - 解析 DTO、调用 Controller 并提供响应结果。
   * @returns 请求处理完成。
   */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    expectedMethod: string | undefined,
    run: (context: HttpRequestContext) => Promise<HttpResult>,
  ): Promise<void> {
    if (expectedMethod !== undefined && !method(req, res, expectedMethod)) return
    const clientId = this.access.authenticate(req, res)
    if (clientId === undefined) return
    const request = requestAbortSignal(req)
    try {
      // Node 提供相对请求路径；localhost 仅用于 URL 解析，不发起网络请求。
      const url = new URL(req.url ?? '/', 'http://localhost')
      const result = await run({ clientId, url, signal: request.signal })
      if (result.kind === 'dto') jsonResponse(res, result.status, result.body)
      else if (result.kind === 'query') sendQueryResult(res, result.result)
    } catch (error) {
      replyError(res, error)
    } finally {
      request.dispose()
    }
  }

  /**
   * 读取 JSON，保留上传完成可空正文规则。
   * @param req - Node 请求。
   * @param optional - 是否允许空正文。
   * @returns 未校验 JSON。
   */
  async body(req: IncomingMessage, optional: boolean = false): Promise<unknown> {
    const requiresJson = !optional || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
    if (requiresJson && !jsonContentType(req)) {
      throw new HttpInputError(415, 'unsupported_media_type', 'Content-Type must be application/json')
    }
    return readBody(req, this.options.config.maxBodyBytes, optional)
  }

  /**
   * 验证已解析地址的白名单。
   * @param peer - 账号与 peer。
   */
  allow(peer: Pick<GatewayPeerIdentity, 'accountId' | 'peerId'>): void {
    this.access.assertAllowedAddress(peer.accountId, peer.peerId)
  }
}
