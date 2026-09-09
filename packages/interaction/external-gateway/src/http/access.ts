/**
 * 控制器共用的机器认证和账号、peer 白名单检查。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GatewayClientId } from '../brand.ts'
import type { ExternalGatewayConfig, GatewayClientId as GatewayClientIdValue } from '../types.ts'
import { hasValidBearerToken } from '../token.ts'
import { HttpInputError } from './errors.ts'
import { fail } from './response.ts'

/**
 * 仅校验入口身份；Session 归属仍由存储及运行时检查。
 */
export class GatewayHttpAccess {
  /**
   * @param token - 已加载的机器凭据。
   * @param config - 已校验的客户端和白名单配置。
   */
  constructor(private readonly token: string, private readonly config: ExternalGatewayConfig) {}

  /**
   * 认证请求；失败时发送 401。
   * @param req - 入站请求。
   * @param res - 响应。
   * @returns 认证客户端 ID，失败时为 undefined。
   */
  authenticate(req: IncomingMessage, res: ServerResponse): GatewayClientIdValue | undefined {
    if (!hasValidBearerToken(req, this.token)) {
      fail(res, 401, 'unauthorized', 'valid bearer authentication is required')
      return undefined
    }
    return GatewayClientId(this.config.clientId)
  }

  /**
   * 拒绝白名单外的账号和 peer。
   * @param accountId - 账号。
   * @param peerId - 对话用户。
   */
  assertAllowedAddress(accountId: string, peerId: string): void {
    if (this.config.accountIds.length > 0 && !this.config.accountIds.includes(accountId)) {
      throw new HttpInputError(403, 'forbidden', 'account is not allowed')
    }
    if (this.config.peerIds.length > 0 && !this.config.peerIds.includes(peerId)) {
      throw new HttpInputError(403, 'forbidden', 'peer is not allowed')
    }
  }
}
