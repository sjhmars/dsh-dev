/**
 * Durable inbox, outbox, and peer ownership for the External Gateway.
 *
 * The store deliberately uses the storage-domain service rather than a
 * database client.  The domain serializes individual writes; this class adds
 * a small operation queue for mutations that touch more than one table.
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

/** The storage-domain schema used by one gateway installation. */
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

/** The concrete domain type opened by {@link ExternalGatewayStore}. */
export type ExternalGatewayDomain = Domain<typeof externalGatewayDomainSpec>

/** Stable store failures that the HTTP adapter can map to protocol errors. */
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

/** Error raised for a rejected durable gateway operation. */
export class ExternalGatewayStoreError extends Error {
  /** Stable protocol-facing code. */
  readonly code: ExternalGatewayStoreErrorCode
  /** Non-secret structured details for a caller or log. */
  readonly details: Readonly<Record<string, unknown>>

  /**
   * @param code - Stable failure code.
   * @param message - Human-readable diagnostic.
   * @param details - Safe structured facts associated with the failure.
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

/** A peer identity after bearer-token matching. */
export interface ExternalGatewayPeer extends GatewayPeerIdentity {}

/** Store options controlling deployment-varying retention and backpressure. */
export interface ExternalGatewayStoreOptions {
  /** Open domain supplied by the storage-domain service. */
  readonly domain: ExternalGatewayDomain
  /** Fixed cwd recorded for Session ownership reservations. */
  readonly fixedCwd: string
  /** Owner-private directory for encoded artifact files. */
  readonly artifactDirectory?: string
  /** Owner-private directory for resumable upload files. @default `<fixedCwd>/.dsh-external-gateway-uploads` */
  readonly uploadDirectory?: string
  /** Maximum completed file upload bytes. @default protocol file limit */
  readonly maxUploadBytes?: number
  /** Maximum completed image upload bytes. @default protocol image limit */
  readonly maxImageBytes?: number
  /** Clock used for durable timestamps. @default `Date.now` */
  readonly now?: () => number
  /** Completed inbox retention. @default 30 days */
  readonly completedRetentionMs?: number
  /** Maximum unacknowledged events for one client. @default 10000 */
  readonly maxOutbox?: number
}

/** Result of accepting an inbox delivery. */
export interface AcceptedGatewayDelivery {
  /** Durable record, including its current lifecycle state. */
  readonly record: GatewayDeliveryRecord
  /** Whether the request was an idempotent replay. */
  readonly duplicate: boolean
}

/** Event page returned by the outbox cursor. */
export interface GatewayEventPage {
  readonly events: readonly GatewayEvent[]
  readonly nextSequence: number
}

/** Result of acknowledging a contiguous outbox prefix. */
export interface GatewayAckResult {
  readonly upToSequence: number
  readonly removed: number
}

/** Result of writing one upload part. */
export interface GatewayUploadPartResult {
  readonly record: GatewayUploadRecord
  readonly part: GatewayUploadPartRecord
  readonly duplicate: boolean
}

/** Result of completing one upload. */
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
 * Convert an untrusted upload name to one safe filename component.
 * Separators, control characters, Windows-invalid characters, and reserved
 * device names are removed before the UTF-8 length cap is applied.
 * @param filename - Client-supplied display name.
 * @returns A non-empty filename that cannot select a parent directory.
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

/** Stable JSON encoding used for delivery conflict detection. */
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
 * Domain-backed persistence for the External Gateway.
 *
 * Reads return defensive copies. Compound methods are serialized here so a
 * delivery cannot observe a half-written ownership or sequence update.
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
   * @param options - Open domain and validated retention/backpressure policy.
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

  /** Fixed cwd recorded in every new ownership reservation. */
  get startupCwd(): string {
    return this.fixedCwd
  }

  /**
   * Admit one delivery or return the existing record for an idempotent retry.
   * The record is durable before the method resolves.
   * @param clientId - Credential-derived client id.
   * @param delivery - Parsed wire delivery.
   * @returns durable record and duplicate marker.
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

  /** Read one delivery for idempotency and worker recovery. */
  getDelivery(clientId: GatewayClientIdValue, deliveryId: GatewayDeliveryIdValue): GatewayDeliveryRecord | undefined {
    const found = this.deliveries.get(deliveryKey(clientId, deliveryId))
    return found === undefined ? undefined : clone(found)
  }

  /** List all pending deliveries in admission order. */
  listPendingDeliveries(): readonly GatewayDeliveryRecord[] {
    return [...this.deliveries.entries()]
      .map(([, record]) => record)
      .filter(record => record.status === 'pending')
      .sort((left, right) => left.createdAt - right.createdAt || left.deliveryId.localeCompare(right.deliveryId))
      .map(record => clone(record))
  }

  /** Increment one worker attempt and return the updated record. */
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

  /** Mark one delivery completed after the Host accepted its mutation. */
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

  /** Mark one delivery failed while keeping it available for diagnostics. */
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

  /** Reset a failed record for an explicit retry request. */
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
   * Reserve an explicit Session identity before the runtime is called.
   * Create and auto-targeted message/command deliveries persist this id in the
   * inbox and active conversation mapping, so a crash cannot mint a second id.
   * @param clientId - Credential-derived client id.
   * @param deliveryId - Delivery being prepared.
   * @returns the updated delivery and optional reserved Session id.
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
      // Persist the reservation in the inbox before touching ownership. If
      // the following ownership write fails, retrying this same delivery
      // still uses the same explicit Session id.
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

  /** Return one peer-owned Session or `undefined` without leaking other peers. */
  ownsSession(peer: ExternalGatewayPeer, sessionId: SessionId): boolean {
    const record = this.sessions.get(sessionKey(peer.clientId, peer.accountId, peer.peerId, sessionId))
    return record !== undefined
  }

  /** Reserve a Session identity for one peer before Host creation. */
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

  /** Mark a reserved Session as Host-created and optionally active. */
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

  /** Read all Session ownership records for a peer in creation order. */
  listSessions(peer: ExternalGatewayPeer): readonly GatewaySessionOwnershipRecord[] {
    return [...this.sessions.entries()]
      .map(([, value]) => value)
      .filter(value => value.clientId === peer.clientId && value.accountId === peer.accountId && value.peerId === peer.peerId)
      .sort((left, right) => left.createdAt - right.createdAt || String(left.sessionId).localeCompare(String(right.sessionId)))
      .map(value => clone(value))
  }

  /** Read every ownership row for startup projection recovery. */
  listAllSessions(): readonly GatewaySessionOwnershipRecord[] {
    return [...this.sessions.entries()]
      .map(([, value]) => clone(value))
      .sort((left, right) => left.createdAt - right.createdAt || String(left.sessionId).localeCompare(String(right.sessionId)))
  }

  /** Find the owning client/account/peer for a Session id without exposing other rows. */
  ownerOfSession(sessionId: SessionId): ExternalGatewayPeer | undefined {
    for (const [, record] of this.sessions.entries()) {
      if (record.sessionId === sessionId) {
        return { clientId: record.clientId, accountId: record.accountId, peerId: record.peerId }
      }
    }
    return undefined
  }

  /** Return the last Session event copied durably into the client outbox. */
  projectedSequence(sessionId: SessionId): number {
    return this.projectionCursors.get(projectionCursorKey(sessionId))?.sequence ?? 0
  }

  /** Advance one Session projection cursor after its outbox events are durable. */
  async markProjected(sessionId: SessionId, sequence: number): Promise<void> {
    await this.serialize(async () => {
      const key = projectionCursorKey(sessionId)
      const current = this.projectionCursors.get(key)?.sequence ?? 0
      if (sequence <= current) return
      await this.projectionCursors.put(key, { sessionId, sequence })
    })
  }

  /** Persist one peer-owned artifact file and its lookup metadata. */
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
      // The durable metadata is the authorization source. Remove an orphan
      // file if its matching record could not be committed.
      await rm(path, { force: true })
      throw error
    }
    return clone(record)
  }

  /** Read one artifact only when the credential-derived peer owns it. */
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
   * Start or resume one owner-scoped upload.
   * The metadata row is durable before this method resolves. A client-supplied
   * upload id makes repeated initiation idempotent; the same id with different
   * metadata is rejected.
   * @param clientId - Credential-derived client id.
   * @param request - Owner address and upload metadata.
   * @returns Durable metadata and whether an existing row was reused.
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

  /** Read one upload row by credential-derived client id. */
  getUploadForClient(clientId: string, uploadId: string): GatewayUploadRecord | undefined {
    const record = this.uploads.get(uploadKey(clientId, uploadId))
    return record === undefined ? undefined : clone(record)
  }

  /** Read one upload only when the authenticated peer owns its address. */
  getUpload(peer: ExternalGatewayPeer, uploadId: string): GatewayUploadRecord | undefined {
    const record = this.getUploadForClient(peer.clientId, uploadId)
    if (record === undefined || record.accountId !== peer.accountId || record.peerId !== peer.peerId) return undefined
    return record
  }

  /** List upload metadata owned by one authenticated peer. */
  listUploads(peer: ExternalGatewayPeer): readonly GatewayUploadRecord[] {
    return [...this.uploads.entries()]
      .map(([, record]) => record)
      .filter(record => record.clientId === peer.clientId && record.accountId === peer.accountId && record.peerId === peer.peerId)
      .sort((left, right) => left.createdAt - right.createdAt || String(left.uploadId).localeCompare(String(right.uploadId)))
      .map(record => clone(record))
  }

  /**
   * Write one fixed-size upload part.
   * Repeating a part with the same digest is idempotent. A different digest for
   * an already stored part is rejected without changing the durable row.
   * @param peer - Credential-derived owner identity.
   * @param uploadId - Upload to mutate.
   * @param partNumber - Zero-based part number.
   * @param bytes - Raw part bytes, at most 4 MiB and exact for its position.
   * @returns Updated metadata, part digest, and duplicate marker.
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
   * Assemble every received part into the fixed-cwd upload file.
   * Completion is idempotent after the durable status changes to `completed`.
   * @param peer - Credential-derived owner identity.
   * @param uploadId - Upload to commit.
   * @param request - Optional expected whole-file checksum.
   * @returns Completed metadata with the computed SHA-256 digest.
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

  /** Read a completed upload's bytes after owner validation. */
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

  /** Return the fixed-cwd path of a completed owner-owned upload without reading it. */
  completedUploadPath(peer: ExternalGatewayPeer, uploadId: string): string {
    const record = this.requireOwnedUpload(peer, uploadId)
    if (record.status !== 'completed') {
      throw new ExternalGatewayStoreError('upload-incomplete', `upload '${uploadId}' is not completed`, { uploadId })
    }
    return this.assertUploadPath(record.path)
  }

  /**
   * Copy a completed owner-owned file into the root Session's fixed-cwd inbox.
   * The permanent upload staging directory remains private to the protocol and
   * never becomes a model-visible path.
   * @param peer - Authenticated upload owner.
   * @param uploadId - Completed file upload identifier.
   * @param sessionId - Root Session that receives the file.
   * @returns Stable file path under the fixed gateway workspace.
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

  /** Read a peer's active Session after validating ownership. */
  activeSession(peer: ExternalGatewayPeer): SessionId | undefined {
    const record = this.conversations.get(conversationKey(peer.clientId, peer.accountId, peer.peerId))
    if (record?.sessionId === undefined) return undefined
    return this.ownsSession(peer, record.sessionId) ? record.sessionId : undefined
  }

  /** Persist a peer's active Session selection. */
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

  /** Verify that an ownership record has no workspace attachment. */
  isUngrouped(peer: ExternalGatewayPeer, sessionId: SessionId): boolean {
    const record = this.sessions.get(sessionKey(peer.clientId, peer.accountId, peer.peerId, sessionId))
    return record !== undefined
  }

  /** Persist one pending question or approval interaction. */
  async saveInteraction(record: GatewayInteractionRecord): Promise<void> {
    await this.serialize(async () => {
      await this.interactions.put(interactionKey(record.clientId, record.interactionId), clone(record))
    })
  }

  /** Read one interaction without exposing another client’s record. */
  getInteraction(clientId: GatewayClientIdValue, interactionId: GatewayInteractionIdValue): GatewayInteractionRecord | undefined {
    const record = this.interactions.get(interactionKey(clientId, interactionId))
    return record === undefined ? undefined : clone(record)
  }

  /** Check peer/session ownership and pending lifetime for an interaction. */
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

  /** Mark an interaction answered or expired. */
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

  /** Append one outbox event, enforcing the per-client backlog limit. */
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
      // Write the event before advancing sequence state. A crash can leave a
      // harmless duplicate sequence candidate, but never a state-only gap.
      await this.outbox.put(eventKey(clientId, sequence), event)
      await this.clients.put(clientKey(clientId), { ...state, nextSequence: sequence + 1 })
      this.notify(clientId)
      return clone(event)
    })
  }

  /** Return a page after an exclusive client sequence cursor. */
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
   * Wait for events or a bounded timeout. Only one active long poll is allowed
   * per authenticated client.
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

  /** Acknowledge and delete an existing contiguous outbox prefix. */
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
      // The cursor is durable before rows are removed, so a crash cannot cause
      // an acknowledged event to be re-acknowledged as unconfirmed.
      await this.clients.put(clientKey(clientId), {
        ...state,
        nextSequence: maxStoredSequence + 1,
        acknowledgedSequence: upToSequence,
      })
      const removed = await this.deleteAcknowledged(clientId, upToSequence)
      return { upToSequence, removed }
    })
  }

  /** Remove completed inbox rows older than the configured retention. */
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

  /** Return ownership callbacks suitable for the Session runtime facade. */
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

  /** Number of currently unacknowledged events for one client. */
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

/** Convert a durable delivery record back into the worker's dispatch input. */
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
