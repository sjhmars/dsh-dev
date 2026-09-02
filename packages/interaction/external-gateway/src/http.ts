/**
 * HTTP carrier for the versioned External Gateway protocol.
 *
 * This module only translates authenticated JSON requests into store and
 * Session-runtime calls. It does not expose the browser API or any Cordis
 * remote route.
 * @module @deepseek-ai/dsh-external-gateway/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  gatewayAckSchema,
  gatewayDeliverySchema,
  gatewayUploadCompleteSchema,
  gatewayUploadInitSchema,
  GATEWAY_UPLOAD_CHUNK_BYTES,
} from './schema.ts'
import { hasValidBearerToken } from './token.ts'
import type {
  ExternalGatewayConfig,
  ExternalGatewayQueryOperation,
  ExternalGatewayQueryResult,
  ExternalGatewayRuntime,
  GatewayDelivery,
  GatewayClientId as GatewayClientIdValue,
  GatewayPeerIdentity,
  GatewayUploadReceipt,
  GatewayUploadRecord,
  JsonValue,
} from './types.ts'
import { GatewayClientId, GatewayUploadId } from './brand.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ExternalGatewayStore, ExternalGatewayStoreError } from './storage.ts'
import type { ExternalGatewayWorker } from './worker.ts'

/** Minimal route carrier required by the HTTP adapter. */
export interface ExternalGatewayHttpCarrier {
  /** Register one route and return its disposer. */
  register(route: WebRoute): () => void
}

/** Dependencies for one HTTP protocol instance. */
export interface ExternalGatewayHttpOptions {
  /** Route carrier, normally `ctx.webServer`. */
  readonly carrier: ExternalGatewayHttpCarrier
  /** Durable inbox/outbox and ownership store. */
  readonly store: ExternalGatewayStore
  /** Worker receiving newly admitted deliveries. */
  readonly worker: ExternalGatewayWorker
  /** Existing Session facade adapter. */
  readonly runtime: ExternalGatewayRuntime
  /** Loaded bearer token. */
  readonly token: string
  /** Validated HTTP and protocol limits. */
  readonly config: ExternalGatewayConfig
}

/** Structured error envelope returned by protected routes. */
export interface GatewayHttpError {
  readonly error: string
  readonly message: string
  readonly details?: JsonValue
}

function jsonResponse(res: ServerResponse, status: number, value: JsonValue): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function emptyResponse(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}

function fail(res: ServerResponse, status: number, error: string, message: string, details?: JsonValue): void {
  jsonResponse(res, status, { error, message, ...(details === undefined ? {} : { details }) })
}

function method(req: IncomingMessage, res: ServerResponse, expected: string): boolean {
  if (req.method === expected) return true
  res.setHeader('allow', expected)
  emptyResponse(res, 405)
  return false
}

function jsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers['content-type']
  return typeof contentType === 'string' && /^application\/json(?:\s*;|\s*$)/iu.test(contentType)
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const length = req.headers['content-length']
  if (length !== undefined) {
    const parsed = Number(length)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new HttpInputError(413, 'body_too_large', 'request body exceeds the configured limit')
    }
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new HttpInputError(413, 'body_too_large', 'request body exceeds the configured limit')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    throw new HttpInputError(400, 'invalid_json', error instanceof Error ? error.message : 'request body is not valid JSON')
  }
}

async function readOptionalJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const length = req.headers['content-length']
  if (length === '0') return {}
  if (length !== undefined) {
    const parsed = Number(length)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new HttpInputError(413, 'body_too_large', 'request body exceeds the configured limit')
    }
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new HttpInputError(413, 'body_too_large', 'request body exceeds the configured limit')
    chunks.push(buffer)
  }
  if (bytes === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    throw new HttpInputError(400, 'invalid_json', error instanceof Error ? error.message : 'request body is not valid JSON')
  }
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const length = req.headers['content-length']
  if (length !== undefined) {
    const parsed = Number(length)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      throw new HttpInputError(413, 'upload_part_too_large', 'upload part exceeds the 4 MiB limit')
    }
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new HttpInputError(413, 'upload_part_too_large', 'upload part exceeds the 4 MiB limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** HTTP parsing failure with a stable status/error code. */
export class HttpInputError extends Error {
  /** HTTP status. */
  readonly status: number
  /** Protocol error code. */
  readonly errorCode: string

  /**
   * @param status - HTTP response status.
   * @param errorCode - Stable error code.
   * @param message - Safe diagnostic.
   */
  constructor(status: number, errorCode: string, message: string) {
    super(message)
    this.name = 'HttpInputError'
    this.status = status
    this.errorCode = errorCode
  }
}

function parseWithSchema<T>(schema: { parse(value: unknown): T }, body: unknown): T {
  try {
    return schema.parse(body)
  } catch (error) {
    throw new HttpInputError(400, 'invalid_request', error instanceof Error ? error.message : 'request does not match the protocol')
  }
}

function assertTextBudget(value: unknown, maxBytes: number): void {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      throw new HttpInputError(413, 'text_too_large', 'request text exceeds the configured limit')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertTextBudget(item, maxBytes)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) assertTextBudget(item, maxBytes)
  }
}

function queryInteger(value: string | null, name: string, fallback: number, max: number): number {
  if (value === null || value === '') return fallback
  if (!/^\d+$/u.test(value)) throw new HttpInputError(400, 'invalid_query', `${name} must be a non-negative integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new HttpInputError(400, 'invalid_query', `${name} is outside the configured limit`)
  }
  return parsed
}

function queryAddress(url: URL): GatewayPeerIdentity {
  const accountId = url.searchParams.get('accountId')
  const peerId = url.searchParams.get('peerId')
  if (accountId === null || peerId === null || accountId.length === 0 || peerId.length === 0) {
    throw new HttpInputError(400, 'missing_address', 'accountId and peerId query parameters are required')
  }
  return { clientId: '', accountId, peerId }
}

function uploadReceipt(record: GatewayUploadRecord): GatewayUploadReceipt {
  return {
    uploadId: record.uploadId,
    status: record.status,
    kind: record.kind,
    filename: record.filename,
    contentType: record.contentType,
    size: record.size,
    chunkSize: record.chunkSize,
    totalParts: record.totalParts,
    receivedParts: record.parts.map(part => part.partNumber),
    ...(record.sha256 === undefined ? {} : { sha256: record.sha256 }),
    content: { type: 'upload', uploadId: record.uploadId },
  }
}

function pathParts(pathname: string, prefix: string): string[] {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return []
  return pathname.slice(prefix.length).split('/').filter(Boolean).map(value => {
    try {
      return decodeURIComponent(value)
    } catch {
      throw new HttpInputError(400, 'invalid_path', 'path contains an invalid escape')
    }
  })
}

function requestAbortSignal(req: IncomingMessage): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  req.once('aborted', abort)
  req.once('close', abort)
  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', abort)
      req.off('close', abort)
    },
  }
}

function errorStatus(error: unknown): { readonly status: number; readonly code: string; readonly message: string } {
  if (error instanceof HttpInputError) return { status: error.status, code: error.errorCode, message: error.message }
  if (error instanceof ExternalGatewayStoreError) {
    switch (error.code) {
      case 'delivery-conflict': return { status: 409, code: 'delivery_conflict', message: error.message }
      case 'delivery-not-found': return { status: 404, code: 'not_found', message: error.message }
      case 'session-not-owned': return { status: 404, code: 'not_found', message: 'resource was not found' }
      case 'session-conflict': return { status: 409, code: 'session_conflict', message: error.message }
      case 'interaction-not-found': return { status: 404, code: 'not_found', message: 'resource was not found' }
      case 'invalid-ack': return { status: 409, code: 'invalid_ack', message: error.message }
      case 'outbox-backpressure': return { status: 503, code: 'outbox_backpressure', message: 'client event backlog is full' }
      case 'poll-in-progress': return { status: 409, code: 'poll_in_progress', message: error.message }
      case 'upload-not-found': return { status: 404, code: 'not_found', message: 'resource was not found' }
      case 'upload-conflict': return { status: 409, code: 'upload_conflict', message: error.message }
      case 'upload-part-conflict': return { status: 409, code: 'upload_part_conflict', message: error.message }
      case 'upload-incomplete': return { status: 409, code: 'upload_incomplete', message: error.message }
      case 'upload-checksum-mismatch': return { status: 409, code: 'upload_checksum_mismatch', message: error.message }
      case 'upload-too-large': return { status: 413, code: 'upload_too_large', message: error.message }
      case 'upload-invalid': return { status: 400, code: 'invalid_upload', message: error.message }
      case 'upload-corrupt': return { status: 500, code: 'gateway_error', message: 'stored upload failed integrity validation' }
      default: return { status: 500, code: 'gateway_error', message: 'gateway storage operation failed' }
    }
  }
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    switch (error.code) {
      case 'session-not-owned':
      case 'session-location-invalid':
      case 'subagent-not-owned':
      case 'interaction-not-owned':
        return { status: 404, code: 'not_found', message: 'resource was not found' }
      case 'command-not-allowed': return { status: 403, code: 'forbidden', message: 'command is not available through the external gateway' }
      case 'invalid-location': return { status: 400, code: 'invalid_request', message: 'Session location is not valid for the external gateway' }
      case 'interaction-scope-unavailable': return { status: 409, code: 'interaction_unavailable', message: 'interaction is no longer available' }
      case 'interaction-expired': return { status: 409, code: 'interaction_expired', message: 'interaction is no longer available' }
      case 'not-found': return { status: 404, code: 'not_found', message: 'resource was not found' }
      case 'export-unavailable': return { status: 501, code: 'export_unavailable', message: 'Session export is unavailable' }
      case 'bad-request':
      case 'model-unavailable':
      case 'agent-preset-conflict':
        return { status: 400, code: 'invalid_request', message: error instanceof Error ? error.message : 'request is invalid' }
      default: break
    }
  }
  return { status: 500, code: 'gateway_error', message: 'gateway operation failed' }
}

/**
 * Register and serve all `/v1` routes for one authenticated client.
 */
export class ExternalGatewayHttp {
  private readonly carrier: ExternalGatewayHttpCarrier
  private readonly store: ExternalGatewayStore
  private readonly worker: ExternalGatewayWorker
  private readonly runtime: ExternalGatewayRuntime
  private readonly token: string
  private readonly config: ExternalGatewayConfig
  private readonly disposers: (() => void)[] = []

  /**
   * @param options - Carrier, durable store, worker, runtime, token and policy.
   */
  constructor(options: ExternalGatewayHttpOptions) {
    this.carrier = options.carrier
    this.store = options.store
    this.worker = options.worker
    this.runtime = options.runtime
    this.token = options.token
    this.config = options.config
  }

  /** Install all route registrations and return a disposer. */
  register(): () => void {
    this.disposers.push(this.carrier.register({ kind: 'exact', path: '/healthz', handler: (req, res) => {
      if (!method(req, res, 'GET')) return
      jsonResponse(res, 200, { status: 'ok' })
    } }))
    this.disposers.push(this.carrier.register({ kind: 'exact', path: '/v1/deliveries', handler: (req, res) => this.delivery(req, res) }))
    this.disposers.push(this.carrier.register({ kind: 'exact', path: '/v1/events', handler: (req, res) => this.events(req, res) }))
    this.disposers.push(this.carrier.register({ kind: 'exact', path: '/v1/events/ack', handler: (req, res) => this.ack(req, res) }))
    this.disposers.push(this.carrier.register({ kind: 'exact', path: '/v1/uploads', handler: (req, res) => this.uploadCollection(req, res) }))
    this.disposers.push(this.carrier.register({ kind: 'prefix', path: '/v1/uploads', handler: (req, res) => this.uploadResource(req, res) }))
    this.disposers.push(this.carrier.register({ kind: 'prefix', path: '/v1/sessions', handler: (req, res) => this.sessions(req, res) }))
    this.disposers.push(this.carrier.register({ kind: 'prefix', path: '/v1/artifacts', handler: (req, res) => this.artifact(req, res) }))
    return () => {
      for (const dispose of this.disposers.splice(0)) dispose()
    }
  }

  private async delivery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!method(req, res, 'POST')) return
    const clientId = this.authenticate(req, res)
    if (clientId === undefined) return
    if (!jsonContentType(req)) {
      fail(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    try {
      const body: GatewayDelivery = parseWithSchema(gatewayDeliverySchema, await readBody(req, this.config.maxBodyBytes))
      assertTextBudget(body, this.config.maxTextBytes)
      this.assertAllowedAddress(body.accountId, body.peerId)
      const accepted = await this.store.acceptDelivery(clientId, body)
      if (!accepted.duplicate) this.worker.enqueue(accepted.record)
      jsonResponse(res, accepted.duplicate ? 200 : 202, {
        deliveryId: accepted.record.deliveryId,
        status: accepted.record.status,
        ...(accepted.duplicate ? { duplicate: true } : {}),
      })
    } catch (error) {
      this.replyError(res, error)
    }
  }

  private async events(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!method(req, res, 'GET')) return
    const clientId = this.authenticate(req, res)
    if (clientId === undefined) return
    try {
      const url = new URL(req.url ?? '/v1/events', 'http://gateway')
      const after = queryInteger(url.searchParams.get('after'), 'after', 0, Number.MAX_SAFE_INTEGER)
      const limit = queryInteger(url.searchParams.get('limit'), 'limit', this.config.maxEvents, this.config.maxEvents)
      const waitMs = queryInteger(url.searchParams.get('waitMs'), 'waitMs', this.config.maxPollMs, this.config.maxPollMs)
      const request = requestAbortSignal(req)
      try {
        const page = await this.store.waitForEvents(clientId, after, limit, waitMs, request.signal)
      jsonResponse(res, 200, jsonValue({ events: page.events, nextSequence: page.nextSequence }))
      } finally {
        request.dispose()
      }
    } catch (error) {
      this.replyError(res, error)
    }
  }

  private async ack(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!method(req, res, 'POST')) return
    const clientId = this.authenticate(req, res)
    if (clientId === undefined) return
    if (!jsonContentType(req)) {
      fail(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    try {
      const body: { readonly upToSequence: number } = parseWithSchema(
        gatewayAckSchema,
        await readBody(req, this.config.maxBodyBytes),
      )
      const result = await this.store.acknowledge(clientId, body.upToSequence)
      await this.worker.resumePending()
      jsonResponse(res, 200, jsonValue(result))
    } catch (error) {
      this.replyError(res, error)
    }
  }

  private async uploadCollection(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const clientId = this.authenticate(req, res)
    if (clientId === undefined) return
    try {
      const url = new URL(req.url ?? '/v1/uploads', 'http://gateway')
      if (req.method === 'GET') {
        const address: GatewayPeerIdentity = { ...queryAddress(url), clientId }
        this.assertAllowedAddress(address.accountId, address.peerId)
        jsonResponse(res, 200, jsonValue({ uploads: this.store.listUploads(address).map(uploadReceipt) }))
        return
      }
      if (!method(req, res, 'POST')) return
      if (!jsonContentType(req)) {
        fail(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
        return
      }
      const body = parseWithSchema(gatewayUploadInitSchema, await readBody(req, this.config.maxBodyBytes))
      assertTextBudget(body, this.config.maxTextBytes)
      this.assertAllowedAddress(body.accountId, body.peerId)
      const accepted = await this.store.createUpload(clientId, body)
      jsonResponse(res, accepted.duplicate ? 200 : 201, jsonValue(uploadReceipt(accepted.record)))
    } catch (error) {
      this.replyError(res, error)
    }
  }

  private async uploadResource(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const clientId = this.authenticate(req, res)
    if (clientId === undefined) return
    try {
      const url = new URL(req.url ?? '/v1/uploads', 'http://gateway')
      const parts = pathParts(url.pathname, '/v1/uploads')
      if (parts.length === 0) {
        throw new HttpInputError(404, 'not_found', 'resource was not found')
      }
      const uploadId = GatewayUploadId(parts[0] as string)
      const address = this.uploadAddress(url, clientId)
      this.assertAllowedAddress(address.accountId, address.peerId)
      if (parts.length === 1) {
        if (!method(req, res, 'GET')) return
        const record = this.store.getUpload(address, uploadId)
        if (record === undefined) throw new HttpInputError(404, 'not_found', 'resource was not found')
        jsonResponse(res, 200, jsonValue(uploadReceipt(record)))
        return
      }
      if (parts.length === 2 && parts[1] === 'content') {
        if (!method(req, res, 'GET')) return
        const content = await this.store.readUpload(address, uploadId)
        res.writeHead(200, {
          'content-type': content.record.contentType,
          'content-length': content.bytes.byteLength,
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${content.record.filename.replace(/["\r\n]/gu, '')}"`,
        })
        res.end(content.bytes)
        return
      }
      if (parts.length === 2 && parts[1] === 'complete') {
        if (!method(req, res, 'POST')) return
        if (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' && !jsonContentType(req)) {
          fail(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
          return
        }
        const body = parseWithSchema(
          gatewayUploadCompleteSchema,
          await readOptionalJsonBody(req, this.config.maxBodyBytes),
        )
        const completed = await this.store.completeUpload(address, uploadId, body)
        jsonResponse(res, 200, jsonValue(uploadReceipt(completed.record)))
        return
      }
      if (parts.length === 3 && parts[1] === 'parts') {
        if (!method(req, res, 'PUT')) return
        const partSegment = parts[2] as string
        if (!/^\d+$/u.test(partSegment)) throw new HttpInputError(400, 'invalid_path', 'part number is invalid')
        const partNumber = Number(partSegment)
        if (!Number.isSafeInteger(partNumber)) throw new HttpInputError(400, 'invalid_path', 'part number is invalid')
        const bytes = await readRawBody(req, GATEWAY_UPLOAD_CHUNK_BYTES)
        const part = await this.store.putUploadPart(address, uploadId, partNumber, bytes)
        jsonResponse(res, 200, jsonValue({
          upload: uploadReceipt(part.record),
          part: { partNumber: part.part.partNumber, bytes: part.part.bytes, digest: part.part.digest },
          ...(part.duplicate ? { duplicate: true } : {}),
        }))
        return
      }
      throw new HttpInputError(404, 'not_found', 'resource was not found')
    } catch (error) {
      this.replyError(res, error)
    }
  }

  private uploadAddress(url: URL, clientId: GatewayClientIdValue): GatewayPeerIdentity {
    const address = queryAddress(url)
    return { clientId, accountId: address.accountId, peerId: address.peerId }
  }

  private async sessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!method(req, res, 'GET')) return
    const clientId = this.authenticate(req, res)
    if (clientId === undefined) return
    try {
      const url = new URL(req.url ?? '/v1/sessions', 'http://gateway')
      const parts = pathParts(url.pathname, '/v1/sessions')
      const untrustedAddress = queryAddress(url)
      const address: GatewayPeerIdentity = { ...untrustedAddress, clientId }
      this.assertAllowedAddress(address.accountId, address.peerId)
      const limit = queryInteger(url.searchParams.get('limit'), 'limit', this.config.maxEvents, this.config.maxEvents)
      const cursorValue = url.searchParams.get('cursor')
      let operation: ExternalGatewayQueryOperation
      let sessionId: string | undefined
      if (parts.length === 0) operation = 'sessions'
      else if (parts.length === 1) { operation = 'session'; sessionId = parts[0] }
      else if (parts.length === 2 && parts[1] === 'history') { operation = 'history'; sessionId = parts[0] }
      else if (parts.length === 2 && parts[1] === 'models') { operation = 'models'; sessionId = parts[0] }
      else if (parts.length === 2 && parts[1] === 'skills') { operation = 'skills'; sessionId = parts[0] }
      else if (parts.length === 2 && parts[1] === 'subagents') { operation = 'subagents'; sessionId = parts[0] }
      else throw new HttpInputError(404, 'not_found', 'resource was not found')
      const cursor = cursorValue === null
        ? undefined
        : String(queryInteger(cursorValue, 'cursor', 0, Number.MAX_SAFE_INTEGER))
      if (sessionId !== undefined && !this.store.ownsSession(address, SessionId(sessionId))) {
        throw new HttpInputError(404, 'not_found', 'resource was not found')
      }
      const request = requestAbortSignal(req)
      try {
        const result = await this.runtime.query({
          clientId,
          accountId: address.accountId,
          peerId: address.peerId,
          operation,
          ...(sessionId === undefined ? {} : { sessionId: SessionId(sessionId) }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(operation === 'history' || operation === 'sessions' ? { limit } : {}),
        }, request.signal)
        this.sendQueryResult(res, result)
      } finally {
        request.dispose()
      }
    } catch (error) {
      this.replyError(res, error)
    }
  }

  private async artifact(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!method(req, res, 'GET')) return
    const clientId = this.authenticate(req, res)
    if (clientId === undefined) return
    try {
      const url = new URL(req.url ?? '/v1/artifacts', 'http://gateway')
      const parts = pathParts(url.pathname, '/v1/artifacts')
      const artifactId = parts.length === 1 ? parts[0] : undefined
      if (artifactId === undefined) throw new HttpInputError(404, 'not_found', 'resource was not found')
      const address: GatewayPeerIdentity = { ...queryAddress(url), clientId }
      this.assertAllowedAddress(address.accountId, address.peerId)
      const request = requestAbortSignal(req)
      try {
        const result = await this.runtime.query({
          clientId,
          accountId: address.accountId,
          peerId: address.peerId,
          operation: 'artifact',
          artifactId,
        }, request.signal)
        this.sendQueryResult(res, result)
      } finally {
        request.dispose()
      }
    } catch (error) {
      this.replyError(res, error)
    }
  }

  private sendQueryResult(res: ServerResponse, result: ExternalGatewayQueryResult): void {
    if (result.kind === 'json') {
      jsonResponse(res, 200, result.value)
      return
    }
    res.writeHead(200, {
      'content-type': result.contentType,
      'content-length': result.body.byteLength,
      'cache-control': 'no-store',
      ...(result.filename === undefined
        ? {}
        : { 'content-disposition': `attachment; filename="${result.filename.replace(/["\r\n]/gu, '')}"` }),
    })
    res.end(result.body)
  }

  private authenticate(req: IncomingMessage, res: ServerResponse): GatewayClientIdValue | undefined {
    if (!hasValidBearerToken(req, this.token)) {
      fail(res, 401, 'unauthorized', 'valid bearer authentication is required')
      return undefined
    }
    return GatewayClientId(this.config.clientId)
  }

  private assertAllowedAddress(accountId: string, peerId: string): void {
    if (this.config.accountIds.length > 0 && !this.config.accountIds.includes(accountId)) {
      throw new HttpInputError(403, 'forbidden', 'account is not allowed')
    }
    if (this.config.peerIds.length > 0 && !this.config.peerIds.includes(peerId)) {
      throw new HttpInputError(403, 'forbidden', 'peer is not allowed')
    }
  }

  private replyError(res: ServerResponse, error: unknown): void {
    const status = errorStatus(error)
    fail(res, status.status, status.code, status.message)
  }
}
