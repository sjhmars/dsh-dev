/**
 * HTTP 路由组装使用的依赖与响应类型。
 */
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { ExternalGatewayStore } from '../storage.ts'
import type { ExternalGatewayWorker } from '../worker.ts'
import type { ExternalGatewayConfig, ExternalGatewayRuntime, JsonValue } from '../types.ts'

/**
 * HTTP 适配器所需的最小路由接口。
 */
export interface ExternalGatewayHttpCarrier {
  /**
   * 注册一条路由并返回释放函数。
   * @param route - 路径匹配方式及处理方法。
   * @returns 路由释放函数。
   */
  register(route: WebRoute): () => void
}

/**
 * 单个 HTTP 协议实例的依赖项。
 */
export interface ExternalGatewayHttpOptions {
  /**
   * 路由承载服务，通常为 `ctx.webServer`。
   */
  readonly carrier: ExternalGatewayHttpCarrier
  /**
   * 持久化 inbox、outbox 和归属存储。
   */
  readonly store: ExternalGatewayStore
  /**
   * 接收新准入投递的 worker。
   */
  readonly worker: ExternalGatewayWorker
  /**
   * 现有 Session 封装层适配器。
   */
  readonly runtime: ExternalGatewayRuntime
  /**
   * 已加载的 Bearer Token。
   */
  readonly token: string
  /**
   * 已校验的 HTTP 和协议限制。
   */
  readonly config: ExternalGatewayConfig
}

/**
 * 受保护路由返回的结构化错误封装。
 */
export interface GatewayHttpError {
  readonly error: string
  readonly message: string
  readonly details?: JsonValue
}
