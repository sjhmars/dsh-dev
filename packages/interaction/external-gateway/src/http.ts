/** 网关 HTTP 路由注册生命周期；接口绑定见 http/routes.ts，业务入口见 controllers。 */
import type { ExternalGatewayHttpOptions } from './http/types.ts'
import { gatewayRoutes } from './http/routes.ts'

export type { ExternalGatewayHttpCarrier, ExternalGatewayHttpOptions, GatewayHttpError } from './http/types.ts'
export { HttpInputError } from './http/errors.ts'

/** 将 /v1 接口挂载到隔离 WebServer，不创建 HTTP Server。 */
export class ExternalGatewayHttp {
  private readonly disposers: (() => void)[] = []

  /**
   * @param options - HTTP 承载服务与网关业务依赖。
   */
  constructor(private readonly options: ExternalGatewayHttpOptions) {}

  /**
   * 注册已绑定 DTO 解析器和 Controller 的接口。
   * @returns 移除全部路由的幂等释放函数。
   */
  register(): () => void {
    for (const route of gatewayRoutes(this.options)) this.disposers.push(this.options.carrier.register(route))
    return () => {
      for (const dispose of this.disposers.splice(0)) dispose()
    }
  }
}
