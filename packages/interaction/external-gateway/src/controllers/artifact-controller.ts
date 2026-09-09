/** 当前 peer 的产物下载业务，不接触 HTTP 请求或响应对象。 */
import type { ExternalGatewayRuntime } from '../types.ts'
import type { ArtifactRequest, QueryResponse } from '../protocol/types.ts'

/** 将产物归属校验和读取交给 DSH 运行时。 */
export class ArtifactController {
  /**
   * @param runtime - DSH 运行时及产物访问服务。
   */
  constructor(private readonly runtime: ExternalGatewayRuntime) {}

  /**
   * 下载网关产物，例如 Session 导出；运行时拒绝不属于当前 peer 的资源。
   * @param request - 已认证的产物请求。
   * @param signal - 下载查询取消信号。
   * @returns JSON 或带文件元数据的二进制结果。
   */
  async artifact(request: ArtifactRequest, signal: AbortSignal): Promise<QueryResponse> {
    return this.runtime.query(request, signal)
  }
}
