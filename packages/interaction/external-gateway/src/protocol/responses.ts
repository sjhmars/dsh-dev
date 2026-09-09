/** 显式选择对外响应字段，避免泄露数据库状态和文件路径。 */
import type { GatewayDraft } from '../construction-types.ts'
import type { GatewayDeliveryRecord, GatewayEvent, GatewayUploadRecord } from '../types.ts'
import type { GatewayUploadPartResult } from '../storage.ts'
import type {
  GatewayDeliveryReceipt, EventsResponse, AckResponse, GatewayUploadReceipt,
  UploadListResponse, UploadPartResponse, UploadCreateResult,
} from './types.ts'

/**
 * 生成可靠投递回执。
 * @param record - 已接收记录。
 * @param duplicate - 是否重复。
 * @returns 对外投递回执。
 */
export function deliveryResponse(record: GatewayDeliveryRecord, duplicate: boolean): GatewayDeliveryReceipt {
  const response: GatewayDraft<GatewayDeliveryReceipt> = { deliveryId: record.deliveryId, status: record.status }
  if (duplicate) {
    response.duplicate = true
  }
  return response
}

/**
 * 投影事件字段，不传播 outbox 内部状态。
 * @param page - 存储查询页。
 * @returns 事件响应 DTO。
 */
export function eventsResponse(page: { readonly events: readonly GatewayEvent[]; readonly nextSequence: number }): EventsResponse {
  const events: GatewayEvent[] = []
  for (const event of page.events) {
    const response: GatewayDraft<GatewayEvent> = {
      clientId: event.clientId,
      sequence: event.sequence,
      eventId: event.eventId,
      accountId: event.accountId,
      peerId: event.peerId,
      payload: event.payload,
      createdAt: event.createdAt,
    }
    if (event.sessionId !== undefined) {
      response.sessionId = event.sessionId
    }
    if (event.causedByDeliveryId !== undefined) {
      response.causedByDeliveryId = event.causedByDeliveryId
    }
    events.push(response)
  }
  return { events, nextSequence: page.nextSequence }
}

/**
 * 投影连续确认结果。
 * @param result - 存储确认结果。
 * @returns 确认响应 DTO。
 */
export function ackResponse(result: AckResponse): AckResponse {
  return { upToSequence: result.upToSequence, removed: result.removed }
}

/**
 * 投影上传公开字段，不包含本地路径。
 * @param record - 上传记录。
 * @returns 上传回执。
 */
export function uploadResponse(record: GatewayUploadRecord): GatewayUploadReceipt {
  const response: GatewayDraft<GatewayUploadReceipt> = {
    uploadId: record.uploadId, status: record.status, kind: record.kind,
    filename: record.filename, contentType: record.contentType, size: record.size,
    chunkSize: record.chunkSize, totalParts: record.totalParts,
    receivedParts: record.parts.map(part => part.partNumber),
    content: { type: 'upload', uploadId: record.uploadId },
  }
  if (record.sha256 !== undefined) {
    response.sha256 = record.sha256
  }
  return response
}

/**
 * 生成上传列表。
 * @param records - 当前 peer 的上传记录。
 * @returns 上传列表 DTO。
 */
export function uploadListResponse(records: readonly GatewayUploadRecord[]): UploadListResponse {
  return { uploads: records.map(uploadResponse) }
}

/**
 * 生成上传创建结果。
 * @param result - 存储接收结果。
 * @returns 回执及状态码选择信息。
 */
export function uploadCreateResponse(result: { readonly record: GatewayUploadRecord; readonly duplicate: boolean }): UploadCreateResult {
  return { upload: uploadResponse(result.record), duplicate: result.duplicate }
}

/**
 * 生成分块回执。
 * @param result - 存储分块结果。
 * @returns 不含文件路径的分块确认。
 */
export function uploadPartResponse(result: GatewayUploadPartResult): UploadPartResponse {
  const response: GatewayDraft<UploadPartResponse> = {
    upload: uploadResponse(result.record),
    part: { partNumber: result.part.partNumber, bytes: result.part.bytes, digest: result.part.digest },
  }
  if (result.duplicate) {
    response.duplicate = true
  }
  return response
}
