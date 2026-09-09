/** 当前 peer 的只读 Session 业务，不解析 URL 或编码 HTTP 响应。 */
import { ExternalGatewayStoreError, type ExternalGatewayStore } from '../storage.ts'
import type { ExternalGatewayRuntime } from '../types.ts'
import type { SessionQueryRequest, QueryResponse } from '../protocol/types.ts'

/** 查询当前 peer 的 Session，保留运行时的归属校验。 */
export class SessionController {
  /**
   * @param store - 网关归属存储。
   * @param runtime - DSH Session 运行时。
   */
  constructor(private readonly store: ExternalGatewayStore, private readonly runtime: ExternalGatewayRuntime) {}

  /**
   * 查询 Session 列表、状态、历史、模型、技能或 subagent，不修改 Session。
   * @param request - 已认证且已解析的查询 DTO。
   * @param signal - 查询取消信号。
   * @returns 运行时查询投影；外部 Session ID 按资源不存在处理。
   */
  async sessions(request: SessionQueryRequest, signal: AbortSignal): Promise<QueryResponse> {
    if (request.sessionId !== undefined && !this.store.ownsSession(request, request.sessionId)) {
      throw new ExternalGatewayStoreError('session-not-owned', 'resource was not found')
    }
    return this.runtime.query(request, signal)
  }
}
