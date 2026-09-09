/** 上传业务只接受 DTO；HTTP 分块读取和响应编码由适配层负责。 */
import { ExternalGatewayStoreError, type ExternalGatewayStore } from '../storage.ts'
import type { ExternalGatewayBytesQueryResult } from '../types.ts'
import type {
  UploadListRequest, UploadCreateRequest, UploadRequest, UploadCompleteRequest, UploadPartRequest,
  UploadListResponse, UploadCreateResult, UploadPartResponse, GatewayUploadReceipt,
} from '../protocol/types.ts'
import { uploadResponse, uploadListResponse, uploadCreateResponse, uploadPartResponse } from '../protocol/responses.ts'

/** 管理当前 peer 的上传，不直接触发 Agent。 */
export class UploadController {
  /**
   * @param store - 校验上传归属并保存分块的存储。
   */
  constructor(private readonly store: ExternalGatewayStore) {}

  /**
   * 列出当前 peer 的上传。
   * @param request - 已认证地址。
   * @returns 上传公开回执列表。
   */
  list(request: UploadListRequest): UploadListResponse {
    return uploadListResponse(this.store.listUploads(request))
  }

  /**
   * 创建上传任务。
   * @param request - 已校验的上传元数据。
   * @returns 上传回执及是否重复。
   */
  async create(request: UploadCreateRequest): Promise<UploadCreateResult> {
    return uploadCreateResponse(await this.store.createUpload(request.clientId, request.upload))
  }

  /**
   * 查询单个上传状态。
   * @param request - 已认证的上传资源地址。
   * @returns 不含本地路径的回执。
   */
  get(request: UploadRequest): GatewayUploadReceipt {
    const record = this.store.getUpload(request.peer, request.uploadId)
    if (record === undefined) throw new ExternalGatewayStoreError('upload-not-found', 'resource was not found')
    return uploadResponse(record)
  }

  /**
   * 下载完成的上传内容。
   * @param request - 已认证的上传资源地址。
   * @returns 文件字节及下载元数据。
   */
  async content(request: UploadRequest): Promise<ExternalGatewayBytesQueryResult> {
    const content = await this.store.readUpload(request.peer, request.uploadId)
    return { kind: 'bytes', contentType: content.record.contentType, filename: content.record.filename, body: content.bytes }
  }

  /**
   * 校验已有分块并完成上传。
   * @param request - 上传标识及完成校验字段。
   * @returns 完成后的上传回执。
   */
  async complete(request: UploadCompleteRequest): Promise<GatewayUploadReceipt> {
    const completed = await this.store.completeUpload(request.peer, request.uploadId, request.completion)
    return uploadResponse(completed.record)
  }

  /**
   * 幂等写入一个分块。
   * @param request - 上传地址、分块编号和有界字节。
   * @returns 分块确认及上传进度。
   */
  async part(request: UploadPartRequest): Promise<UploadPartResponse> {
    return uploadPartResponse(await this.store.putUploadPart(request.peer, request.uploadId, request.partNumber, request.bytes))
  }
}
