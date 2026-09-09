/** 可靠事件读取与确认业务；不依赖 URL、HTTP 请求或 JSON 编码。 */
import type { ExternalGatewayStore } from '../storage.ts'
import type { ExternalGatewayWorker } from '../worker.ts'
import type { EventsRequest, EventsResponse, AckRequest, AckResponse } from '../protocol/types.ts'
import { eventsResponse, ackResponse } from '../protocol/responses.ts'

/** 当前客户端的 outbox 查询与确认。 */
export class EventController {
  /**
   * @param store - 网关持久化存储。
   * @param worker - 待处理投递调度器。
   */
  constructor(private readonly store: ExternalGatewayStore, private readonly worker: ExternalGatewayWorker) {}

  /**
   * 供 VPS 主动长轮询 after 之后的事件；有事件立即返回，无事件最多等待 waitMs。
   * 读取不确认或删除事件；客户端处理成功后另行调用 ack，再继续下一轮轮询。
   * @param request - 已认证且已校验的游标、批量大小和等待时限。
   * @param signal - 客户端断开连接时取消等待。
   * @returns 事件正文和下一轮使用的排他游标，超时且无新事件时列表为空。
   */
  async events(request: EventsRequest, signal: AbortSignal): Promise<EventsResponse> {
    const page = await this.store.waitForEvents(request.clientId, request.after, request.limit, request.waitMs, signal)
    return eventsResponse(page)
  }

  /**
   * 持久化最高连续确认并删除对应 outbox，释放积压后恢复待处理投递。
   * @param request - 已认证的客户端及确认序号。
   * @returns 实际确认序号及删除数量；重复确认幂等。
   */
  async ack(request: AckRequest): Promise<AckResponse> {
    const result = await this.store.acknowledge(request.clientId, request.upToSequence)
    await this.worker.resumePending()
    return ackResponse(result)
  }
}
