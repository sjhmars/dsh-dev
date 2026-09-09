/**
 * External Gateway 的持久化 inbox、outbox 和 peer 归属存储。
 *
 * 存储使用 storage-domain 服务，而非直接使用
 * 数据库客户端。domain 将单次写入串行化；此类额外提供
 * 一个小型操作队列，用于涉及多张表的变更。
 * @module @deepseek-ai/dsh-external-gateway/storage
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  gatewayClientStateSchema,
  gatewayArtifactSchema,
  gatewayConversationSchema,
  gatewayDeliveryRecordSchema,
  gatewayEventSchema,
  gatewayInteractionSchema,
  gatewayProjectionCursorSchema,
  gatewaySessionOwnershipSchema,
  gatewayUploadRecordSchema,
  GATEWAY_UPLOAD_CHUNK_BYTES,
  MAX_GATEWAY_IMAGE_BYTES,
  MAX_GATEWAY_UPLOAD_BYTES,
  MAX_TEXT_LENGTH,
  MAX_UPLOAD_FILENAME_BYTES,
} from './schema.ts'
import { GatewayClientId, GatewayEventId, GatewayUploadId } from './brand.ts'
import type {
  ExternalGatewayDispatchRequest,
  GatewayArtifactRecord,
  GatewayClientId as GatewayClientIdValue,
  GatewayClientStateRecord,
  GatewayConversationRecord,
  GatewayDelivery,
  GatewayDeliveryId as GatewayDeliveryIdValue,
  GatewayDeliveryRecord,
  GatewayEvent,
  GatewayEventPayload,
  GatewayInteractionId as GatewayInteractionIdValue,
  GatewayInteractionRecord,
  GatewayPeerIdentity,
  GatewayProjectionCursorRecord,
  GatewaySessionOwnershipRecord,
  GatewayUploadCompleteRequest,
  GatewayUploadInitRequest,
  GatewayUploadPartRecord,
  GatewayUploadRecord,
  JsonValue,
} from './types.ts'

/** 单个网关实例使用的 storage-domain 结构定义。 */
export const externalGatewayDomainSpec = defineDomain({
  name: 'external_gateway',
  version: 3,
  layout: 'single',
  tables: {
    deliveries: domainTable<string, GatewayDeliveryRecord>(gatewayDeliveryRecordSchema),
    outbox: domainTable<string, GatewayEvent>(gatewayEventSchema),
    clients: domainTable<string, GatewayClientStateRecord>(gatewayClientStateSchema),
    sessions: domainTable<string, GatewaySessionOwnershipRecord>(gatewaySessionOwnershipSchema),
    conversations: domainTable<string, GatewayConversationRecord>(gatewayConversationSchema),
    interactions: domainTable<string, GatewayInteractionRecord>(gatewayInteractionSchema),
    projection_cursors: domainTable<string, GatewayProjectionCursorRecord>(gatewayProjectionCursorSchema),
    artifacts: domainTable<string, GatewayArtifactRecord>(gatewayArtifactSchema),
    uploads: domainTable<string, GatewayUploadRecord>(gatewayUploadRecordSchema),
  },
})

/** {@link ExternalGatewayStore} 打开的具体 domain 类型。 */
export type ExternalGatewayDomain = Domain<typeof externalGatewayDomainSpec>

/** HTTP 适配器可映射为协议错误的稳定存储错误。 */
export type ExternalGatewayStoreErrorCode =
  | 'delivery-conflict'
  | 'delivery-not-found'
  | 'session-not-owned'
  | 'session-conflict'
  | 'interaction-not-found'
  | 'invalid-ack'
  | 'outbox-backpressure'
  | 'poll-in-progress'
  | 'upload-invalid'
  | 'upload-too-large'
  | 'upload-not-found'
  | 'upload-conflict'
  | 'upload-part-conflict'
  | 'upload-incomplete'
  | 'upload-checksum-mismatch'
  | 'upload-corrupt'

/** 持久化网关操作被拒绝时抛出的错误。 */
export class ExternalGatewayStoreError extends Error {
  /** 面向协议的稳定错误码。 */
  readonly code: ExternalGatewayStoreErrorCode
  /** 供调用方或日志使用、不含秘密信息的结构化详情。 */
  readonly details: Readonly<Record<string, unknown>>

  /**
   * @param code - 稳定错误码。
   * @param message - 便于阅读的诊断信息。
   * @param details - 与错误关联的安全结构化事实。
   */
  constructor(
    code: ExternalGatewayStoreErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'ExternalGatewayStoreError'
    this.code = code
    this.details = details
  }
}

/** Bearer Token 匹配后的 peer 身份。 */
export interface ExternalGatewayPeer extends GatewayPeerIdentity {}

/** 控制随部署变化的保留期和背压策略的存储选项。 */
export interface ExternalGatewayStoreOptions {
  /** storage-domain 服务提供的已打开 domain。 */
  readonly domain: ExternalGatewayDomain
  /** Session 归属预留记录使用的固定 cwd。 */
  readonly fixedCwd: string
  /** 编码产物文件的所有者私有目录。 */
  readonly artifactDirectory?: string
  /** 可恢复上传文件的所有者私有目录。 @default `<fixedCwd>/.dsh-external-gateway-uploads` */
  readonly uploadDirectory?: string
  /** 完整文件上传的最大字节数。 @default 协议文件上限 */
  readonly maxUploadBytes?: number
  /** 完整图片上传的最大字节数。 @default 协议图片上限 */
  readonly maxImageBytes?: number
  /** 持久化时间戳使用的时钟。 @default `Date.now` */
  readonly now?: () => number
  /** 已完成 inbox 记录的保留期。 @default 30 天 */
  readonly completedRetentionMs?: number
  /** 单个客户端的最大未确认事件数。 @default 10000 */
  readonly maxOutbox?: number
}

/** 接受 inbox 投递的结果。 */
export interface AcceptedGatewayDelivery {
  /** 包含当前生命周期状态的持久化记录。 */
  readonly record: GatewayDeliveryRecord
  /** 请求是否为幂等重放。 */
  readonly duplicate: boolean
}

/** outbox 游标返回的事件分页。 */
export interface GatewayEventPage {
  readonly events: readonly GatewayEvent[]
  readonly nextSequence: number
}

/** 确认 outbox 连续前缀的结果。 */
export interface GatewayAckResult {
  readonly upToSequence: number
  readonly removed: number
}

/** 写入单个上传分块的结果。 */
export interface GatewayUploadPartResult {
  readonly record: GatewayUploadRecord
  readonly part: GatewayUploadPartRecord
  readonly duplicate: boolean
}

/** 完成单次上传的结果。 */
export interface GatewayUploadCompletionResult {
  readonly record: GatewayUploadRecord
}

type DeliveryTable = KvTable<string, GatewayDeliveryRecord>
type EventTable = KvTable<string, GatewayEvent>
type ClientTable = KvTable<string, GatewayClientStateRecord>
type SessionTable = KvTable<string, GatewaySessionOwnershipRecord>
type ConversationTable = KvTable<string, GatewayConversationRecord>
type InteractionTable = KvTable<string, GatewayInteractionRecord>
type ProjectionCursorTable = KvTable<string, GatewayProjectionCursorRecord>
type ArtifactTable = KvTable<string, GatewayArtifactRecord>
type UploadTable = KvTable<string, GatewayUploadRecord>

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_OUTBOX = 10_000

function keyPart(value: string): string {
  return JSON.stringify(value)
}

function deliveryKey(clientId: string, deliveryId: string): string {
  return JSON.stringify(['delivery', clientId, deliveryId])
}

function sessionKey(clientId: string, accountId: string, peerId: string, sessionId: string): string {
  return JSON.stringify(['session', clientId, accountId, peerId, sessionId])
}

function conversationKey(clientId: string, accountId: string, peerId: string): string {
  return JSON.stringify(['conversation', clientId, accountId, peerId])
}

function interactionKey(clientId: string, interactionId: string): string {
  return JSON.stringify(['interaction', clientId, interactionId])
}

function eventKey(clientId: string, sequence: number): string {
  return JSON.stringify(['event', clientId, sequence])
}

function clientKey(clientId: string): string {
  return keyPart(clientId)
}

function projectionCursorKey(sessionId: SessionId): string {
  return keyPart(sessionId)
}

function artifactKey(clientId: string, artifactId: string): string {
  return JSON.stringify(['artifact', clientId, artifactId])
}

function uploadKey(clientId: string, uploadId: string): string {
  return JSON.stringify(['upload', clientId, uploadId])
}

const WINDOWS_RESERVED_FILENAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/**
 * 将不可信的上传名称转换为安全的单个文件名组成部分。
 * 应用 UTF-8 长度上限前，移除分隔符、控制字符、
 * Windows 非法字符及保留设备名称。
 * @param filename - 客户端提供的显示名称。
 * @returns 无法指向父目录的非空文件名。
 */
export function sanitizeGatewayFilename(filename: string): string {
  const normalized = filename.normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  let safe = normalized.length === 0 || normalized === '.' || normalized === '..' ? 'upload' : normalized
  const stem = safe.split('.')[0]?.toUpperCase() ?? ''
  if (WINDOWS_RESERVED_FILENAMES.has(stem)) safe = `_${safe}`
  let result = ''
  for (const character of safe) {
    if (Buffer.byteLength(result + character, 'utf8') > MAX_UPLOAD_FILENAME_BYTES) break
    result += character
  }
  return result.length === 0 ? 'upload' : result
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child.length === 0 || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

function assertDigest(value: string | undefined, field: string): void {
  if (value !== undefined && !/^[a-f0-9]{64}$/u.test(value)) {
    throw new ExternalGatewayStoreError('upload-invalid', `${field} must be a lowercase SHA-256 digest`)
  }
}

function expectedPartBytes(record: GatewayUploadRecord, partNumber: number): number {
  if (record.totalParts === 0) return 0
  const remaining = record.size - (partNumber * record.chunkSize)
  return Math.min(record.chunkSize, remaining)
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (result.bytesWritten <= 0) throw new Error('upload file write made no progress')
    offset += result.bytesWritten
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function digestOf(delivery: GatewayDelivery): string {
  return createHash('sha256')
    .update(canonicalJson({
      accountId: delivery.accountId,
      peerId: delivery.peerId,
      payload: delivery.payload,
    } as unknown as JsonValue), 'utf8')
    .digest('hex')
}

function withoutDeliveryErrors(record: GatewayDeliveryRecord): Omit<GatewayDeliveryRecord, 'errorCode' | 'errorMessage'> {
  const next = { ...record }
  delete next.errorCode
  delete next.errorMessage
  return next
}

/** 用于检测投递冲突的稳定 JSON 编码。 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

function isAutoCreatePayload(delivery: GatewayDelivery): boolean {
  if (delivery.payload.type === 'session-create') return true
  if (delivery.payload.type === 'message') {
    return delivery.payload.sessionId === undefined
  }
  return false
}

/**
 * 基于 domain 的 External Gateway 持久化实现。
 *
 * 读取返回防御性副本；复合方法在此串行执行，避免
 * 投递看到仅写入了一部分的归属或序号更新。
 */
export class ExternalGatewayStore {
  private readonly deliveries: DeliveryTable
  private readonly outbox: EventTable
  private readonly clients: ClientTable
  private readonly sessions: SessionTable
  private readonly conversations: ConversationTable
  private readonly interactions: InteractionTable
  private readonly projectionCursors: ProjectionCursorTable
  private readonly artifacts: ArtifactTable
  private readonly uploads: UploadTable
  private readonly fixedCwd: string
  private readonly artifactDirectory: string
  private readonly uploadDirectory: string
  private readonly inboxDirectory: string
  private readonly maxUploadBytes: number
  private readonly maxImageBytes: number
  private readonly now: () => number
  private readonly completedRetentionMs: number
  private readonly maxOutbox: number
  private operationTail: Promise<void> = Promise.resolve()
  private readonly eventWaiters = new Map<string, () => void>()

  /**
   * @param options - 已打开的 domain 和已校验的保留期、背压策略。
   */
  constructor(options: ExternalGatewayStoreOptions) {
    if (options.fixedCwd.trim().length === 0) throw new TypeError('external gateway fixedCwd must not be empty')
    if (!Number.isSafeInteger(options.completedRetentionMs ?? DEFAULT_RETENTION_MS)
      || (options.completedRetentionMs ?? DEFAULT_RETENTION_MS) < 0) {
      throw new TypeError('external gateway completedRetentionMs must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(options.maxUploadBytes ?? MAX_GATEWAY_UPLOAD_BYTES)
      || (options.maxUploadBytes ?? MAX_GATEWAY_UPLOAD_BYTES) < 1) {
      throw new TypeError('external gateway maxUploadBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.maxImageBytes ?? MAX_GATEWAY_IMAGE_BYTES)
      || (options.maxImageBytes ?? MAX_GATEWAY_IMAGE_BYTES) < 1) {
      throw new TypeError('external gateway maxImageBytes must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.maxOutbox ?? DEFAULT_MAX_OUTBOX) || (options.maxOutbox ?? DEFAULT_MAX_OUTBOX) < 1) {
      throw new TypeError('external gateway maxOutbox must be a positive safe integer')
    }
    this.deliveries = options.domain.table('deliveries')
    this.outbox = options.domain.table('outbox')
    this.clients = options.domain.table('clients')
    this.sessions = options.domain.table('sessions')
    this.conversations = options.domain.table('conversations')
    this.interactions = options.domain.table('interactions')
    this.projectionCursors = options.domain.table('projection_cursors')
    this.artifacts = options.domain.table('artifacts')
    this.uploads = options.domain.table('uploads')
    this.fixedCwd = options.fixedCwd
    this.artifactDirectory = resolve(options.artifactDirectory ?? join(options.fixedCwd, '.dsh-external-gateway-artifacts'))
    this.uploadDirectory = resolve(options.uploadDirectory ?? join(options.fixedCwd, '.dsh-external-gateway-uploads'))
    this.inboxDirectory = resolve(join(options.fixedCwd, '.dsh-external-gateway', 'inbox'))
    this.maxUploadBytes = options.maxUploadBytes ?? MAX_GATEWAY_UPLOAD_BYTES
    this.maxImageBytes = options.maxImageBytes ?? MAX_GATEWAY_IMAGE_BYTES
    this.now = options.now ?? Date.now
    this.completedRetentionMs = options.completedRetentionMs ?? DEFAULT_RETENTION_MS
    this.maxOutbox = options.maxOutbox ?? DEFAULT_MAX_OUTBOX
  }

  /** 每条新归属预留记录使用的固定 cwd。 */
  get startupCwd(): string {
    return this.fixedCwd
  }

  /**
   * 接受一条投递，或在幂等重试时返回已有记录。
   * 方法完成前，记录已持久化。
   * @param clientId - 由凭据推导的客户端 ID。
   * @param delivery - 已解析的传输投递数据。
   * @returns 持久化记录及重复标记。
   */
  async acceptDelivery(clientId: GatewayClientIdValue, delivery: GatewayDelivery): Promise<AcceptedGatewayDelivery> {
    return this.serialize(async () => {
      const key = deliveryKey(clientId, delivery.deliveryId)
      const existing = this.deliveries.get(key)
      const digest = digestOf(delivery)
      if (existing !== undefined) {
        if (existing.digest !== digest) {
          throw new ExternalGatewayStoreError(
            'delivery-conflict',
            `delivery '${delivery.deliveryId}' was already admitted with different content`,
            { deliveryId: delivery.deliveryId },
          )
        }
        return { record: clone(existing), duplicate: true }
      }
      if (this.countOutstanding(clientId) >= this.maxOutbox) {
        throw new ExternalGatewayStoreError(
          'outbox-backpressure',
          `client '${clientId}' has reached the external gateway outbox limit`,
          { clientId, maxOutbox: this.maxOutbox },
        )
      }
      const timestamp = this.now()
      const record: GatewayDeliveryRecord = {
        ...clone(delivery),
        clientId,
        digest,
        status: 'pending',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      await this.deliveries.put(key, record)
      return { record: clone(record), duplicate: false }
    })
  }

  /** 读取一条投递，用于幂等检查和 worker 恢复。 */
  getDelivery(clientId: GatewayClientIdValue, deliveryId: GatewayDeliveryIdValue): GatewayDeliveryRecord | undefined {
    const found = this.deliveries.get(deliveryKey(clientId, deliveryId))
    return found === undefined ? undefined : clone(found)
  }

  /** 按准入顺序列出全部待处理投递。 */
  listPendingDeliveries(): readonly GatewayDeliveryRecord[] {
    return [...this.deliveries.entries()]
      .map(([, record]) => record)
      .filter(record => record.status === 'pending')
      .sort((left, right) => left.createdAt - right.createdAt || left.deliveryId.localeCompare(right.deliveryId))
      .map(record => clone(record))
  }

  /** 增加一次 worker 尝试次数并返回更新后的记录。 */
  async beginDelivery(clientId: GatewayClientIdValue, deliveryId: GatewayDeliveryIdValue): Promise<GatewayDeliveryRecord> {
    return this.serialize(async () => {
      const key = deliveryKey(clientId, deliveryId)
      const current = this.requireDelivery(clientId, deliveryId)
      if (current.status !== 'pending') return clone(current)
      const next: GatewayDeliveryRecord = {
        ...current,
        attempts: current.attempts + 1,
        updatedAt: this.now(),
      }
      await this.deliveries.put(key, next)
      return clone(next)
    })
  }

  /** 宿主接受变更后，将投递标记为已完成。 */
  async completeDelivery(
    clientId: GatewayClientIdValue,
    deliveryId: GatewayDeliveryIdValue,
    result?: JsonValue,
  ): Promise<GatewayDeliveryRecord> {
    return this.serialize(async () => {
      const key = deliveryKey(clientId, deliveryId)
      const current = this.requireDelivery(clientId, deliveryId)
      if (current.status === 'completed') return clone(current)
      const timestamp = this.now()
      const withoutError = withoutDeliveryErrors(current)
      const next: GatewayDeliveryRecord = {
        ...withoutError,
        status: 'completed',
        updatedAt: timestamp,
        completedAt: timestamp,
        ...(result === undefined ? {} : { result: clone(result) }),
      }
      await this.deliveries.put(key, next)
      return clone(next)
    })
  }

  /** 将投递标记为失败，并保留记录以供诊断。 */
  async failDelivery(
    clientId: GatewayClientIdValue,
    deliveryId: GatewayDeliveryIdValue,
    code: string,
    message: string,
  ): Promise<GatewayDeliveryRecord> {
    return this.serialize(async () => {
      const key = deliveryKey(clientId, deliveryId)
      const current = this.requireDelivery(clientId, deliveryId)
      const next: GatewayDeliveryRecord = {
        ...current,
        status: 'failed',
        updatedAt: this.now(),
        errorCode: code,
        errorMessage: message,
      }
      await this.deliveries.put(key, next)
      return clone(next)
    })
  }

  /** 为显式重试请求重置失败记录。 */
  async retryDelivery(clientId: GatewayClientIdValue, deliveryId: GatewayDeliveryIdValue): Promise<GatewayDeliveryRecord> {
    return this.serialize(async () => {
      const key = deliveryKey(clientId, deliveryId)
      const current = this.requireDelivery(clientId, deliveryId)
      if (current.status !== 'failed') return clone(current)
      const withoutError = withoutDeliveryErrors(current)
      const next: GatewayDeliveryRecord = {
        ...withoutError,
        status: 'pending',
        updatedAt: this.now(),
      }
      await this.deliveries.put(key, next)
      return clone(next)
    })
  }

  /**
   * 调用运行时前预留显式 Session 标识符。
   * 创建操作和自动确定目标的消息或命令投递会将此 ID 持久化到
   * inbox 和活动对话映射中，避免崩溃后生成第二个 ID。
   * @param clientId - 由凭据推导的客户端 ID。
   * @param deliveryId - 正在准备的投递。
   * @returns 更新后的投递及可选的预留 Session ID。
   */
  async reserveSessionForDelivery(
    clientId: GatewayClientIdValue,
    deliveryId: GatewayDeliveryIdValue,
  ): Promise<{ readonly record: GatewayDeliveryRecord; readonly sessionId?: SessionId }> {
    return this.serialize(async () => {
      const deliveryKeyValue = deliveryKey(clientId, deliveryId)
      const current = this.requireDelivery(clientId, deliveryId)
      if (!isAutoCreatePayload(current)) return { record: clone(current) }
      const active = current.payload.type === 'session-create'
        ? undefined
        : this.conversations.get(conversationKey(clientId, current.accountId, current.peerId))
      const sessionId = current.reservedSessionId ?? active?.sessionId ?? SessionId(`session-${randomUUID()}`)
      const timestamp = this.now()
      const reserved: GatewayDeliveryRecord = {
        ...current,
        reservedSessionId: sessionId,
        updatedAt: timestamp,
      }
      // 修改归属前，先将预留 ID 持久化到 inbox。如果
      // 后续归属写入失败，重试同一投递
      // 仍使用相同的显式 Session ID。
      if (current.reservedSessionId === undefined) {
        await this.deliveries.put(deliveryKeyValue, reserved)
      }
      await this.claimSessionUnsafe({ clientId, accountId: current.accountId, peerId: current.peerId }, sessionId)
      const conversation: GatewayConversationRecord = {
        clientId,
        accountId: current.accountId,
        peerId: current.peerId,
        sessionId,
        updatedAt: timestamp,
      }
      await this.conversations.put(
        conversationKey(clientId, current.accountId, current.peerId),
        conversation,
      )
      return { record: clone(reserved), sessionId }
    })
  }

  /** 返回当前 peer 所属 Session 或 `undefined`，不泄露其他 peer 的信息。 */
  ownsSession(peer: ExternalGatewayPeer, sessionId: SessionId): boolean {
    const record = this.sessions.get(sessionKey(peer.clientId, peer.accountId, peer.peerId, sessionId))
    return record !== undefined
  }

  /** 宿主创建前，为当前 peer 预留 Session 标识符。 */
  async claimSession(peer: ExternalGatewayPeer, sessionId: SessionId): Promise<boolean> {
    return this.serialize(async () => this.claimSessionUnsafe(peer, sessionId))
  }

  private async claimSessionUnsafe(peer: ExternalGatewayPeer, sessionId: SessionId): Promise<boolean> {
    const key = sessionKey(peer.clientId, peer.accountId, peer.peerId, sessionId)
    const existing = this.sessions.get(key)
    if (existing !== undefined) return false
    for (const [, candidate] of this.sessions.entries()) {
      if (candidate.sessionId === sessionId) {
        throw new ExternalGatewayStoreError(
          'session-conflict',
          `session '${sessionId}' is already owned by another peer`,
          { sessionId },
        )
      }
    }
    const timestamp = this.now()
    await this.sessions.put(key, {
      clientId: GatewayClientId(peer.clientId),
      accountId: peer.accountId,
      peerId: peer.peerId,
      sessionId,
      cwd: this.fixedCwd,
      createdAt: timestamp,
      status: 'pending',
      active: false,
    })
    return true
  }

  /** 将预留 Session 标记为宿主已创建，并可选设为活动 Session。 */
  async markSessionReady(
    peer: ExternalGatewayPeer,
    sessionId: SessionId,
    active = false,
  ): Promise<void> {
    await this.serialize(async () => {
      const key = sessionKey(peer.clientId, peer.accountId, peer.peerId, sessionId)
      const current = this.sessions.get(key)
      if (current === undefined) {
        throw new ExternalGatewayStoreError('session-not-owned', `session '${sessionId}' is not owned by this peer`)
      }
      await this.sessions.put(key, { ...current, status: 'ready', active: active || current.active })
      if (active) await this.setActiveUnsafe(peer, sessionId)
    })
  }

  /** 按创建顺序读取当前 peer 的全部 Session 归属记录。 */
  listSessions(peer: ExternalGatewayPeer): readonly GatewaySessionOwnershipRecord[] {
    return [...this.sessions.entries()]
      .map(([, value]) => value)
      .filter(value => value.clientId === peer.clientId && value.accountId === peer.accountId && value.peerId === peer.peerId)
      .sort((left, right) => left.createdAt - right.createdAt || String(left.sessionId).localeCompare(String(right.sessionId)))
      .map(value => clone(value))
  }

  /** 读取全部归属记录，用于启动时恢复投影。 */
  listAllSessions(): readonly GatewaySessionOwnershipRecord[] {
    return [...this.sessions.entries()]
      .map(([, value]) => clone(value))
      .sort((left, right) => left.createdAt - right.createdAt || String(left.sessionId).localeCompare(String(right.sessionId)))
  }

  /** 查找 Session ID 所属的客户端、账号和 peer，不暴露其他记录。 */
  ownerOfSession(sessionId: SessionId): ExternalGatewayPeer | undefined {
    for (const [, record] of this.sessions.entries()) {
      if (record.sessionId === sessionId) {
        return { clientId: record.clientId, accountId: record.accountId, peerId: record.peerId }
      }
    }
    return undefined
  }

  /** 返回最后一个已持久化复制到客户端 outbox 的 Session 事件。 */
  projectedSequence(sessionId: SessionId): number {
    return this.projectionCursors.get(projectionCursorKey(sessionId))?.sequence ?? 0
  }

  /** outbox 事件持久化后，推进对应 Session 的投影游标。 */
  async markProjected(sessionId: SessionId, sequence: number): Promise<void> {
    await this.serialize(async () => {
      const key = projectionCursorKey(sessionId)
      const current = this.projectionCursors.get(key)?.sequence ?? 0
      if (sequence <= current) return
      await this.projectionCursors.put(key, { sessionId, sequence })
    })
  }

  /** 持久化当前 peer 所属产物文件及其查询元数据。 */
  async saveArtifact(
    peer: ExternalGatewayPeer,
    sessionId: SessionId,
    bytes: Uint8Array,
    filename: string,
    contentType: string,
  ): Promise<GatewayArtifactRecord> {
    if (!this.ownsSession(peer, sessionId)) {
      throw new ExternalGatewayStoreError('session-not-owned', 'resource was not found')
    }
    const artifactId = randomUUID()
    const path = join(this.artifactDirectory, `${artifactId}.base64`)
    await writeFileAtomic(path, Buffer.from(bytes).toString('base64'), { mode: 0o600, dirMode: 0o700 })
    const record: GatewayArtifactRecord = {
      clientId: GatewayClientId(peer.clientId),
      accountId: peer.accountId,
      peerId: peer.peerId,
      artifactId,
      sessionId,
      path,
      filename,
      contentType,
      createdAt: this.now(),
    }
    try {
      await this.serialize(async () => this.artifacts.put(artifactKey(peer.clientId, artifactId), record))
    } catch (error) {
      // 持久化元数据是授权依据；若对应记录无法提交，
      // 则删除孤立文件。
      await rm(path, { force: true })
      throw error
    }
    return clone(record)
  }

  /** 仅在凭据推导出的 peer 拥有产物时读取该产物。 */
  async readArtifact(
    peer: ExternalGatewayPeer,
    artifactId: string,
  ): Promise<{ readonly record: GatewayArtifactRecord; readonly bytes: Uint8Array } | undefined> {
    const record = this.artifacts.get(artifactKey(peer.clientId, artifactId))
    if (record === undefined || record.accountId !== peer.accountId || record.peerId !== peer.peerId) return undefined
    const encoded = await readFile(record.path, 'utf8')
    return { record: clone(record), bytes: Buffer.from(encoded, 'base64') }
  }

  /**
   * 启动或恢复一次按所有者隔离的上传。
   * 方法完成前，元数据记录已持久化。客户端提供的
   * 上传 ID 使重复初始化保持幂等；同一 ID 对应不同
   * 元数据时拒绝请求。
   * @param clientId - 由凭据推导的客户端 ID。
   * @param request - 所有者地址和上传元数据。
   * @returns 持久化元数据及是否复用了已有记录。
   */
  async createUpload(
    clientId: GatewayClientIdValue,
    request: GatewayUploadInitRequest,
  ): Promise<{ readonly record: GatewayUploadRecord; readonly duplicate: boolean }> {
    this.validateUploadInit(request)
    const filename = sanitizeGatewayFilename(request.filename)
    const contentType = request.contentType.trim()
    const uploadId = request.uploadId ?? GatewayUploadId(randomUUID())
    return this.serialize(async () => {
      const key = uploadKey(clientId, uploadId)
      const existing = this.uploads.get(key)
      if (existing !== undefined) {
        if (existing.accountId !== request.accountId || existing.peerId !== request.peerId) {
          throw new ExternalGatewayStoreError('upload-not-found', 'resource was not found', { uploadId })
        }
        const sameMetadata = existing.accountId === request.accountId
          && existing.peerId === request.peerId
          && existing.kind === request.kind
          && existing.filename === filename
          && existing.contentType === contentType
          && existing.size === request.size
          && (request.sha256 === undefined || request.sha256 === existing.sha256)
        if (!sameMetadata) {
          throw new ExternalGatewayStoreError(
            'upload-conflict',
            `upload '${uploadId}' was already initialized with different metadata`,
            { uploadId },
          )
        }
        return { record: clone(existing), duplicate: true }
      }
      const timestamp = this.now()
      const directory = join(this.uploadDirectory, randomUUID())
      const record: GatewayUploadRecord = {
        clientId: GatewayClientId(clientId),
        accountId: request.accountId,
        peerId: request.peerId,
        uploadId,
        kind: request.kind,
        filename,
        contentType,
        size: request.size,
        ...(request.sha256 === undefined ? {} : { sha256: request.sha256 }),
        chunkSize: GATEWAY_UPLOAD_CHUNK_BYTES,
        totalParts: Math.ceil(request.size / GATEWAY_UPLOAD_CHUNK_BYTES),
        parts: [],
        path: join(directory, filename),
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      try {
        await this.uploads.put(key, record)
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
      return { record: clone(record), duplicate: false }
    })
  }

  /** 按凭据推导出的客户端 ID 读取上传记录。 */
  getUploadForClient(clientId: string, uploadId: string): GatewayUploadRecord | undefined {
    const record = this.uploads.get(uploadKey(clientId, uploadId))
    return record === undefined ? undefined : clone(record)
  }

  /** 仅在已认证 peer 拥有该上传地址时读取上传。 */
  getUpload(peer: ExternalGatewayPeer, uploadId: string): GatewayUploadRecord | undefined {
    const record = this.getUploadForClient(peer.clientId, uploadId)
    if (record === undefined || record.accountId !== peer.accountId || record.peerId !== peer.peerId) return undefined
    return record
  }

  /** 列出已认证 peer 所属的上传元数据。 */
  listUploads(peer: ExternalGatewayPeer): readonly GatewayUploadRecord[] {
    return [...this.uploads.entries()]
      .map(([, record]) => record)
      .filter(record => record.clientId === peer.clientId && record.accountId === peer.accountId && record.peerId === peer.peerId)
      .sort((left, right) => left.createdAt - right.createdAt || String(left.uploadId).localeCompare(String(right.uploadId)))
      .map(record => clone(record))
  }

  /**
   * 写入一个固定大小的上传分块。
   * 以相同摘要重复提交分块保持幂等；已存储分块对应的
   * 摘要不同时拒绝请求，不修改持久化记录。
   * @param peer - 由凭据推导的所有者身份。
   * @param uploadId - 待修改的上传。
   * @param partNumber - 从零开始的分块编号。
   * @param bytes - 原始分块字节，最多 4 MiB，且大小必须符合其所在位置。
   * @returns 更新后的元数据、分块摘要和重复标记。
   */
  async putUploadPart(
    peer: ExternalGatewayPeer,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<GatewayUploadPartResult> {
    if (!Number.isSafeInteger(partNumber) || partNumber < 0) {
      throw new ExternalGatewayStoreError('upload-invalid', 'part number must be a non-negative safe integer')
    }
    if (bytes.byteLength > GATEWAY_UPLOAD_CHUNK_BYTES) {
      throw new ExternalGatewayStoreError('upload-too-large', 'one upload part exceeds 4 MiB')
    }
    return this.serialize(async () => {
      const current = this.requireOwnedUpload(peer, uploadId)
      if (current.status !== 'pending') {
        throw new ExternalGatewayStoreError('upload-conflict', `upload '${uploadId}' is already completed`, { uploadId })
      }
      if (partNumber >= current.totalParts || current.totalParts === 0) {
        throw new ExternalGatewayStoreError('upload-invalid', `part ${String(partNumber)} is outside the upload`, { uploadId, partNumber })
      }
      const expectedBytes = expectedPartBytes(current, partNumber)
      if (bytes.byteLength !== expectedBytes) {
        throw new ExternalGatewayStoreError(
          'upload-invalid',
          `part ${String(partNumber)} must contain ${String(expectedBytes)} bytes`,
          { uploadId, partNumber, expectedBytes },
        )
      }
      const buffer = Buffer.from(bytes)
      const digest = createHash('sha256').update(buffer).digest('hex')
      const existing = current.parts.find(part => part.partNumber === partNumber)
      if (existing !== undefined && (existing.bytes !== buffer.byteLength || existing.digest !== digest)) {
        throw new ExternalGatewayStoreError(
          'upload-part-conflict',
          `part ${String(partNumber)} was already stored with different bytes`,
          { uploadId, partNumber },
        )
      }
      if (existing !== undefined) {
        try {
          const existingPath = this.assertUploadPath(existing.path)
          const existingBytes = await readFile(existingPath)
          const existingDigest = createHash('sha256').update(existingBytes).digest('hex')
          if (existingBytes.byteLength === buffer.byteLength && existingDigest === digest) {
            return { record: clone(current), part: clone(existing), duplicate: true }
          }
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        }
      }
      const partPath = join(dirname(this.assertUploadPath(current.path)), `${randomUUID()}.part`)
      try {
        await writeFile(partPath, buffer, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        await rm(partPath, { force: true })
        throw error
      }
      const part: GatewayUploadPartRecord = { partNumber, bytes: buffer.byteLength, digest, path: partPath }
      const parts = [...current.parts.filter(candidate => candidate.partNumber !== partNumber), part]
        .sort((left, right) => left.partNumber - right.partNumber)
      const next: GatewayUploadRecord = { ...current, parts, updatedAt: this.now() }
      try {
        await this.uploads.put(uploadKey(peer.clientId, uploadId), next)
      } catch (error) {
        await rm(partPath, { force: true })
        throw error
      }
      if (existing !== undefined) await rm(this.assertUploadPath(existing.path), { force: true })
      return { record: clone(next), part: clone(part), duplicate: false }
    })
  }

  /**
   * 将收到的全部分块组装为固定 cwd 下的上传文件。
   * 持久化状态变为 `completed` 后，完成操作保持幂等。
   * @param peer - 由凭据推导的所有者身份。
   * @param uploadId - 待提交的上传。
   * @param request - 可选的预期整文件校验和。
   * @returns 包含计算所得 SHA-256 摘要的已完成元数据。
   */
  async completeUpload(
    peer: ExternalGatewayPeer,
    uploadId: string,
    request: GatewayUploadCompleteRequest = {},
  ): Promise<GatewayUploadCompletionResult> {
    assertDigest(request.sha256, 'sha256')
    return this.serialize(async () => {
      const current = this.requireOwnedUpload(peer, uploadId)
      if (current.status === 'completed') {
        if (request.sha256 !== undefined && current.sha256 !== request.sha256) {
          throw new ExternalGatewayStoreError('upload-checksum-mismatch', `upload '${uploadId}' checksum does not match`, { uploadId })
        }
        return { record: clone(current) }
      }
      if (request.sha256 !== undefined && current.sha256 !== undefined && request.sha256 !== current.sha256) {
        throw new ExternalGatewayStoreError('upload-checksum-mismatch', `upload '${uploadId}' checksum does not match`, { uploadId })
      }
      const partsByNumber = new Map(current.parts.map(part => [part.partNumber, part]))
      const missing = Array.from({ length: current.totalParts }, (_, partNumber) => partNumber)
        .filter(partNumber => !partsByNumber.has(partNumber))
      if (missing.length > 0) {
        throw new ExternalGatewayStoreError(
          'upload-incomplete',
          `upload '${uploadId}' is missing parts`,
          { uploadId, missingParts: missing },
        )
      }
      const finalPath = this.assertUploadPath(current.path)
      const temporaryPath = join(dirname(finalPath), `${randomUUID()}.tmp`)
      const hash = createHash('sha256')
      let totalBytes = 0
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        handle = await open(temporaryPath, 'wx', 0o600)
        for (let partNumber = 0; partNumber < current.totalParts; partNumber += 1) {
          const part = partsByNumber.get(partNumber)
          if (part === undefined) throw new ExternalGatewayStoreError('upload-corrupt', 'upload part metadata is incomplete')
          const partPath = this.assertUploadPath(part.path)
          const partBytes = await readFile(partPath)
          const partDigest = createHash('sha256').update(partBytes).digest('hex')
          if (partBytes.byteLength !== part.bytes || partDigest !== part.digest || partBytes.byteLength !== expectedPartBytes(current, partNumber)) {
            throw new ExternalGatewayStoreError('upload-corrupt', `upload part ${String(partNumber)} failed integrity validation`)
          }
          hash.update(partBytes)
          totalBytes += partBytes.byteLength
          await writeAll(handle, partBytes)
        }
        if (totalBytes !== current.size) {
          throw new ExternalGatewayStoreError('upload-corrupt', 'assembled upload size does not match metadata')
        }
        const digest = hash.digest('hex')
        if ((request.sha256 ?? current.sha256) !== undefined && digest !== (request.sha256 ?? current.sha256)) {
          throw new ExternalGatewayStoreError('upload-checksum-mismatch', `upload '${uploadId}' checksum does not match`, { uploadId })
        }
        await handle.close()
        handle = undefined
        await rm(finalPath, { force: true })
        await rename(temporaryPath, finalPath)
        const timestamp = this.now()
        const next: GatewayUploadRecord = {
          ...current,
          sha256: digest,
          status: 'completed',
          updatedAt: timestamp,
          completedAt: timestamp,
        }
        await this.uploads.put(uploadKey(peer.clientId, uploadId), next)
        await Promise.allSettled(current.parts.map(part => rm(part.path, { force: true })))
        return { record: clone(next) }
      } catch (error) {
        if (handle !== undefined) await handle.close().catch(() => {})
        await rm(temporaryPath, { force: true })
        throw error
      }
    })
  }

  /** 校验所有者后读取已完成上传的字节。 */
  async readUpload(
    peer: ExternalGatewayPeer,
    uploadId: string,
  ): Promise<{ readonly record: GatewayUploadRecord; readonly bytes: Uint8Array }> {
    const record = this.requireOwnedUpload(peer, uploadId)
    if (record.status !== 'completed') {
      throw new ExternalGatewayStoreError('upload-incomplete', `upload '${uploadId}' is not completed`, { uploadId })
    }
    const bytes = await readFile(this.assertUploadPath(record.path))
    return { record: clone(record), bytes }
  }

  /** 返回当前所有者已完成上传在固定 cwd 下的路径，不读取文件。 */
  completedUploadPath(peer: ExternalGatewayPeer, uploadId: string): string {
    const record = this.requireOwnedUpload(peer, uploadId)
    if (record.status !== 'completed') {
      throw new ExternalGatewayStoreError('upload-incomplete', `upload '${uploadId}' is not completed`, { uploadId })
    }
    return this.assertUploadPath(record.path)
  }

  /**
   * 将当前所有者已完成的文件复制到根 Session 固定 cwd 下的 inbox。
   * 长期上传暂存目录仅供协议内部使用，
   * 绝不作为模型可见路径。
   * @param peer - 已认证的上传所有者。
   * @param uploadId - 已完成文件上传的标识符。
   * @param sessionId - 接收文件的根 Session。
   * @returns 固定网关工作区内的稳定文件路径。
   */
  async materializeUploadFile(
    peer: ExternalGatewayPeer,
    uploadId: string,
    sessionId: SessionId,
  ): Promise<string> {
    const record = this.requireOwnedUpload(peer, uploadId)
    if (record.status !== 'completed') {
      throw new ExternalGatewayStoreError('upload-incomplete', `upload '${uploadId}' is not completed`, { uploadId })
    }
    if (record.kind !== 'file') {
      throw new ExternalGatewayStoreError('upload-invalid', `upload '${uploadId}' is not a file`, { uploadId })
    }
    const sessionDirectory = resolve(join(this.inboxDirectory, sanitizeGatewayFilename(String(sessionId))))
    if (!isWithin(this.inboxDirectory, sessionDirectory)) {
      throw new ExternalGatewayStoreError('upload-corrupt', 'Session inbox is outside the fixed gateway workspace')
    }
    const filename = `${createHash('sha256').update(uploadId).digest('hex').slice(0, 16)}-${sanitizeGatewayFilename(record.filename)}`
    const destination = resolve(join(sessionDirectory, filename))
    if (!isWithin(sessionDirectory, destination)) {
      throw new ExternalGatewayStoreError('upload-corrupt', 'materialized file is outside the Session inbox')
    }
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 })
    await copyFile(this.assertUploadPath(record.path), destination)
    return destination
  }

  private validateUploadInit(request: GatewayUploadInitRequest): void {
    if (request.kind !== 'image' && request.kind !== 'file') {
      throw new ExternalGatewayStoreError('upload-invalid', 'upload kind is not supported')
    }
    if (!Number.isSafeInteger(request.size) || request.size < 0) {
      throw new ExternalGatewayStoreError('upload-invalid', 'upload size must be a non-negative safe integer')
    }
    const maxBytes = request.kind === 'image' ? this.maxImageBytes : this.maxUploadBytes
    if (request.size > maxBytes) {
      throw new ExternalGatewayStoreError('upload-too-large', 'upload exceeds the maximum size', { maxBytes })
    }
    if (request.filename.trim().length === 0 || Buffer.byteLength(request.filename, 'utf8') > MAX_TEXT_LENGTH) {
      throw new ExternalGatewayStoreError('upload-invalid', 'upload filename is invalid')
    }
    if (request.contentType.trim().length === 0) {
      throw new ExternalGatewayStoreError('upload-invalid', 'upload content type is invalid')
    }
    assertDigest(request.sha256, 'sha256')
  }

  private requireOwnedUpload(peer: ExternalGatewayPeer, uploadId: string): GatewayUploadRecord {
    const record = this.getUpload(peer, uploadId)
    if (record === undefined) {
      throw new ExternalGatewayStoreError('upload-not-found', 'resource was not found', { uploadId })
    }
    return record
  }

  private assertUploadPath(path: string): string {
    const candidate = resolve(path)
    if (!isWithin(this.uploadDirectory, candidate)) {
      throw new ExternalGatewayStoreError('upload-corrupt', 'upload path is outside the gateway upload directory')
    }
    return candidate
  }

  /** 校验归属后读取 peer 的活动 Session。 */
  activeSession(peer: ExternalGatewayPeer): SessionId | undefined {
    const record = this.conversations.get(conversationKey(peer.clientId, peer.accountId, peer.peerId))
    if (record?.sessionId === undefined) return undefined
    return this.ownsSession(peer, record.sessionId) ? record.sessionId : undefined
  }

  /** 持久化 peer 的活动 Session 选择。 */
  async setActiveSession(peer: ExternalGatewayPeer, sessionId: SessionId | undefined): Promise<void> {
    await this.serialize(async () => this.setActiveUnsafe(peer, sessionId))
  }

  private async setActiveUnsafe(peer: ExternalGatewayPeer, sessionId: SessionId | undefined): Promise<void> {
    if (sessionId !== undefined && !this.ownsSession(peer, sessionId)) {
      throw new ExternalGatewayStoreError('session-not-owned', `session '${sessionId}' is not owned by this peer`)
    }
    const key = conversationKey(peer.clientId, peer.accountId, peer.peerId)
    const next: GatewayConversationRecord = {
      clientId: GatewayClientId(peer.clientId),
      accountId: peer.accountId,
      peerId: peer.peerId,
      ...(sessionId === undefined ? {} : { sessionId }),
      updatedAt: this.now(),
    }
    await this.conversations.put(key, next)
    for (const [sessionKeyValue, record] of this.sessions.entries()) {
      if (record.clientId !== peer.clientId || record.accountId !== peer.accountId || record.peerId !== peer.peerId) continue
      const shouldBeActive = sessionId !== undefined && record.sessionId === sessionId
      if (record.active !== shouldBeActive) {
        await this.sessions.put(sessionKeyValue, { ...record, active: shouldBeActive })
      }
    }
  }

  /** 校验归属记录未关联工作区。 */
  isUngrouped(peer: ExternalGatewayPeer, sessionId: SessionId): boolean {
    const record = this.sessions.get(sessionKey(peer.clientId, peer.accountId, peer.peerId, sessionId))
    return record !== undefined
  }

  /** 持久化一个待决问题或审批交互。 */
  async saveInteraction(record: GatewayInteractionRecord): Promise<void> {
    await this.serialize(async () => {
      await this.interactions.put(interactionKey(record.clientId, record.interactionId), clone(record))
    })
  }

  /** 读取单个交互，不暴露其他客户端的记录。 */
  getInteraction(clientId: GatewayClientIdValue, interactionId: GatewayInteractionIdValue): GatewayInteractionRecord | undefined {
    const record = this.interactions.get(interactionKey(clientId, interactionId))
    return record === undefined ? undefined : clone(record)
  }

  /** 检查交互的 peer、Session 归属及待决有效期。 */
  ownsInteraction(
    peer: ExternalGatewayPeer,
    sessionId: SessionId,
    interactionId: string,
    kind: GatewayInteractionRecord['kind'],
  ): boolean {
    const record = this.interactions.get(interactionKey(peer.clientId, interactionId))
    return record !== undefined
      && record.accountId === peer.accountId
      && record.peerId === peer.peerId
      && record.sessionId === sessionId
      && record.kind === kind
      && record.status === 'pending'
      && record.expiresAt > this.now()
  }

  /** 将交互标记为已回答或已过期。 */
  async finishInteraction(
    clientId: GatewayClientIdValue,
    interactionId: GatewayInteractionIdValue,
    status: 'answered' | 'expired',
  ): Promise<void> {
    await this.serialize(async () => {
      const key = interactionKey(clientId, interactionId)
      const record = this.interactions.get(key)
      if (record === undefined) {
        throw new ExternalGatewayStoreError('interaction-not-found', `interaction '${interactionId}' was not found`)
      }
      if (record.status === 'pending') await this.interactions.put(key, { ...record, status })
    })
  }

  /** 追加一个 outbox 事件，并执行每客户端积压上限检查。 */
  async appendEvent(
    clientId: GatewayClientIdValue,
    address: Pick<GatewayDelivery, 'accountId' | 'peerId'>,
    payload: GatewayEventPayload,
    options: { readonly sessionId?: SessionId; readonly causedByDeliveryId?: GatewayDeliveryIdValue } = {},
  ): Promise<GatewayEvent> {
    return this.serialize(async () => {
      const outstanding = this.countOutstanding(clientId)
      if (outstanding >= this.maxOutbox) {
        throw new ExternalGatewayStoreError(
          'outbox-backpressure',
          `client '${clientId}' has reached the external gateway outbox limit`,
          { clientId, maxOutbox: this.maxOutbox },
        )
      }
      const state = this.clients.get(clientKey(clientId)) ?? {
        clientId,
        nextSequence: 1,
        acknowledgedSequence: 0,
      }
      let maxStoredSequence = state.nextSequence - 1
      for (const [, candidate] of this.outbox.entries()) {
        if (candidate.clientId === clientId && candidate.sequence > maxStoredSequence) {
          maxStoredSequence = candidate.sequence
        }
      }
      const sequence = maxStoredSequence + 1
      const event: GatewayEvent = {
        clientId,
        sequence,
        eventId: GatewayEventId(randomUUID()),
        accountId: address.accountId,
        peerId: address.peerId,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.causedByDeliveryId === undefined ? {} : { causedByDeliveryId: options.causedByDeliveryId }),
        payload,
        createdAt: this.now(),
      }
      // 推进序号状态前先写入事件；崩溃可能留下
      // 无害的重复序号候选，但绝不会仅推进状态而留下事件缺口。
      await this.outbox.put(eventKey(clientId, sequence), event)
      await this.clients.put(clientKey(clientId), { ...state, nextSequence: sequence + 1 })
      this.notify(clientId)
      return clone(event)
    })
  }

  /** 返回客户端排他序号游标之后的一页事件。 */
  listEvents(clientId: GatewayClientIdValue, after: number, limit: number): GatewayEventPage {
    const acknowledged = this.clients.get(clientKey(clientId))?.acknowledgedSequence ?? 0
    const events = [...this.outbox.entries()]
      .map(([, event]) => event)
      .filter(event => event.clientId === clientId && event.sequence > after && event.sequence > acknowledged)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
      .map(event => clone(event))
    const nextSequence = events.at(-1)?.sequence ?? Math.max(after, acknowledged)
    return { events, nextSequence }
  }

  /**
   * 等待事件或有界超时；每个已认证客户端
   * 仅允许一个活动长轮询。
   */
  async waitForEvents(
    clientId: GatewayClientIdValue,
    after: number,
    limit: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<GatewayEventPage> {
    const immediate = this.listEvents(clientId, after, limit)
    if (immediate.events.length > 0 || waitMs === 0 || signal?.aborted === true) return immediate
    if (this.eventWaiters.has(clientId)) {
      throw new ExternalGatewayStoreError('poll-in-progress', `client '${clientId}' already has an active event poll`)
    }
    await new Promise<void>(resolve => {
      let timer: NodeJS.Timeout | undefined
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        this.eventWaiters.delete(clientId)
        resolve()
      }
      this.eventWaiters.set(clientId, finish)
      timer = setTimeout(finish, waitMs)
      signal?.addEventListener('abort', finish, { once: true })
    })
    return this.listEvents(clientId, after, limit)
  }

  /** 确认并删除已存在的 outbox 连续前缀。 */
  async acknowledge(clientId: GatewayClientIdValue, upToSequence: number): Promise<GatewayAckResult> {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(upToSequence) || upToSequence < 0) {
        throw new ExternalGatewayStoreError('invalid-ack', 'upToSequence must be a non-negative safe integer')
      }
      const state = this.clients.get(clientKey(clientId)) ?? {
        clientId,
        nextSequence: 1,
        acknowledgedSequence: 0,
      }
      let maxStoredSequence = state.nextSequence - 1
      for (const [, candidate] of this.outbox.entries()) {
        if (candidate.clientId === clientId && candidate.sequence > maxStoredSequence) {
          maxStoredSequence = candidate.sequence
        }
      }
      if (upToSequence < state.acknowledgedSequence) {
        if (state.nextSequence !== maxStoredSequence + 1) {
          await this.clients.put(clientKey(clientId), { ...state, nextSequence: maxStoredSequence + 1 })
        }
        return { upToSequence: state.acknowledgedSequence, removed: await this.deleteAcknowledged(clientId, state.acknowledgedSequence) }
      }
      const lastIssued = maxStoredSequence
      if (upToSequence > lastIssued) {
        throw new ExternalGatewayStoreError('invalid-ack', `acknowledgement ${String(upToSequence)} exceeds issued sequence ${String(lastIssued)}`)
      }
      for (let sequence = state.acknowledgedSequence + 1; sequence <= upToSequence; sequence += 1) {
        if (this.outbox.get(eventKey(clientId, sequence)) === undefined) {
          throw new ExternalGatewayStoreError('invalid-ack', `acknowledgement has a gap at sequence ${String(sequence)}`)
        }
      }
      if (upToSequence === state.acknowledgedSequence) {
        if (state.nextSequence !== maxStoredSequence + 1) {
          await this.clients.put(clientKey(clientId), { ...state, nextSequence: maxStoredSequence + 1 })
        }
        return { upToSequence, removed: await this.deleteAcknowledged(clientId, upToSequence) }
      }
      // 删除记录前先持久化游标，避免崩溃后
      // 将已确认事件视为未确认事件再次确认。
      await this.clients.put(clientKey(clientId), {
        ...state,
        nextSequence: maxStoredSequence + 1,
        acknowledgedSequence: upToSequence,
      })
      const removed = await this.deleteAcknowledged(clientId, upToSequence)
      return { upToSequence, removed }
    })
  }

  /** 删除超过配置保留期的已完成 inbox 记录。 */
  async pruneCompleted(now = this.now()): Promise<number> {
    return this.serialize(async () => {
      const cutoff = now - this.completedRetentionMs
      let removed = 0
      for (const [key, record] of this.deliveries.entries()) {
        if (record.status !== 'completed' || record.completedAt === undefined || record.completedAt > cutoff) continue
        if (await this.deliveries.delete(key)) removed += 1
      }
      return removed
    })
  }

  /** 返回适用于 Session 运行时封装层的归属回调。 */
  ownership(): {
    readonly ownsSession: (peer: ExternalGatewayPeer, sessionId: SessionId) => boolean
    readonly claimSession: (peer: ExternalGatewayPeer, sessionId: SessionId) => Promise<boolean>
    readonly activeSession: (peer: ExternalGatewayPeer) => SessionId | undefined
    readonly setActiveSession: (peer: ExternalGatewayPeer, sessionId: SessionId | undefined) => Promise<void>
    readonly isUngrouped: (peer: ExternalGatewayPeer, sessionId: SessionId) => boolean
    readonly ownsInteraction: ExternalGatewayStore['ownsInteraction']
  } {
    return {
      ownsSession: (peer, sessionId) => this.ownsSession(peer, sessionId),
      claimSession: (peer, sessionId) => this.claimSession(peer, sessionId),
      activeSession: peer => this.activeSession(peer),
      setActiveSession: (peer, sessionId) => this.setActiveSession(peer, sessionId),
      isUngrouped: (peer, sessionId) => this.isUngrouped(peer, sessionId),
      ownsInteraction: (peer, sessionId, interactionId, kind) => this.ownsInteraction(peer, sessionId, interactionId, kind),
    }
  }

  /** 单个客户端当前未确认的事件数量。 */
  countOutstanding(clientId: GatewayClientIdValue): number {
    const acknowledged = this.clients.get(clientKey(clientId))?.acknowledgedSequence ?? 0
    return [...this.outbox.entries()].reduce(
      (count, [, event]) => count + (event.clientId === clientId && event.sequence > acknowledged ? 1 : 0),
      0,
    )
  }

  private async deleteAcknowledged(clientId: GatewayClientIdValue, upToSequence: number): Promise<number> {
    let removed = 0
    for (const [key, event] of this.outbox.entries()) {
      if (event.clientId === clientId && event.sequence <= upToSequence && await this.outbox.delete(key)) removed += 1
    }
    return removed
  }

  private requireDelivery(clientId: GatewayClientIdValue, deliveryId: GatewayDeliveryIdValue): GatewayDeliveryRecord {
    const record = this.deliveries.get(deliveryKey(clientId, deliveryId))
    if (record === undefined) {
      throw new ExternalGatewayStoreError('delivery-not-found', `delivery '${deliveryId}' was not found`, { deliveryId })
    }
    return clone(record)
  }

  private notify(clientId: GatewayClientIdValue): void {
    this.eventWaiters.get(clientId)?.()
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(work)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

/** 将持久化投递记录转换回 worker 的调度输入。 */
export function dispatchRequestOf(record: GatewayDeliveryRecord, cwd: string): ExternalGatewayDispatchRequest {
  return {
    clientId: record.clientId,
    accountId: record.accountId,
    peerId: record.peerId,
    deliveryId: record.deliveryId,
    payload: clone(record.payload),
    ...(record.reservedSessionId === undefined ? {} : { reservedSessionId: record.reservedSessionId }),
    cwd,
  }
}
