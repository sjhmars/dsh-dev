/** Runtime constructors for External Gateway opaque identifiers. */

import type {
  GatewayClientId,
  GatewayDeliveryId,
  GatewayEventId,
  GatewayInteractionId,
  GatewayUploadId,
} from './types.ts'

/** Brand one client identifier after protocol validation. */
export function GatewayClientId(value: string): GatewayClientId {
  return value as GatewayClientId
}

/** Brand one delivery identifier after protocol validation. */
export function GatewayDeliveryId(value: string): GatewayDeliveryId {
  return value as GatewayDeliveryId
}

/** Brand one interaction identifier after protocol validation. */
export function GatewayInteractionId(value: string): GatewayInteractionId {
  return value as GatewayInteractionId
}

/** Brand one event identifier after protocol validation. */
export function GatewayEventId(value: string): GatewayEventId {
  return value as GatewayEventId
}

/** Brand one resumable upload identifier after protocol validation. */
export function GatewayUploadId(value: string): GatewayUploadId {
  return value as GatewayUploadId
}
