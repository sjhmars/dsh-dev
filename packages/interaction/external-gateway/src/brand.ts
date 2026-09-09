/** External Gateway 不透明标识符的运行时构造函数。 */

import type {
  GatewayClientId,
  GatewayDeliveryId,
  GatewayEventId,
  GatewayInteractionId,
  GatewayUploadId,
} from './types.ts'

/** 协议校验后为客户端标识符附加类型品牌。 */
export function GatewayClientId(value: string): GatewayClientId {
  return value as GatewayClientId
}

/** 协议校验后为投递标识符附加类型品牌。 */
export function GatewayDeliveryId(value: string): GatewayDeliveryId {
  return value as GatewayDeliveryId
}

/** 协议校验后为交互标识符附加类型品牌。 */
export function GatewayInteractionId(value: string): GatewayInteractionId {
  return value as GatewayInteractionId
}

/** 协议校验后为事件标识符附加类型品牌。 */
export function GatewayEventId(value: string): GatewayEventId {
  return value as GatewayEventId
}

/** 协议校验后为可恢复上传标识符附加类型品牌。 */
export function GatewayUploadId(value: string): GatewayUploadId {
  return value as GatewayUploadId
}
