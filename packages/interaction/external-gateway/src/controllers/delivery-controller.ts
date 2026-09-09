/** 可靠投递业务；协议解析与 HTTP 状态码由适配层负责。 */
import type { ExternalGatewayStore } from '../storage.ts'
import type { ExternalGatewayWorker } from '../worker.ts'
import type { DeliveryRequest, GatewayDeliveryReceipt } from '../protocol/types.ts'
import { deliveryResponse } from '../protocol/responses.ts'

/** 将已校验的变更持久化并交给 worker。 */
export class DeliveryController {
  /**
   * @param store - 网关存储。
   * @param worker - 可靠投递调度器。
   */
  constructor(private readonly store: ExternalGatewayStore, private readonly worker: ExternalGatewayWorker) {}

  /**
   * 先保存 inbox 再异步调度；重复投递不会创建第二次调度。
   * 接收成功不代表 Agent 执行完成，执行结果由 events 提供。
   * @param request - 已认证的客户端及已校验的投递。
   * @returns 投递回执；相同 ID 不同内容由存储拒绝。
   */
  async delivery(request: DeliveryRequest): Promise<GatewayDeliveryReceipt> {
    const accepted = await this.store.acceptDelivery(request.clientId, request.delivery)
    if (!accepted.duplicate) this.worker.enqueue(accepted.record)
    return deliveryResponse(accepted.record, accepted.duplicate)
  }
}
