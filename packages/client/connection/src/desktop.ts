/**
 * Desktop IPC bridge (node half): unary `/api` dispatch through the shared
 * connection fetch handler and decoded Gateway streams, delivered to one
 * renderer over an injected sink. Electron-free by design — the desktop app
 * owns ipcMain/webContents wiring and injects the sink, so this module
 * typechecks and tests under plain Node.
 *
 * Trust model: the bridge exists only between the app's own main process and
 * its own window (contextBridge whitelist + local-only content). Reaching the
 * bridge therefore equals the browser carrier's loopback caller, so the
 * Host/Origin fence and browser authentication have no desktop counterpart —
 * documented in apps/desktop/README.md as a security precondition.
 * @module @deepseek-ai/dsh-client-connection/desktop
 */

import type { ConnectionFetchHandler, HostConnectionHandle } from './rpc.ts'
import { API_PATH } from './api-path.ts'

/** JSON-safe fetch request as it crosses the IPC wire. */
export interface DesktopFetchRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** Base64 request body; absent for bodyless requests. */
  body?: string
}

/** Fetch settlement returned to the renderer before any chunk arrives. */
export interface DesktopFetchInit {
  status: number
  headers: Record<string, string>
  /** Present when the response body streams; chunks follow on this id. */
  streamId?: string
  /** Base64 body for non-streamed responses (empty body included). */
  body: string
}

/**
 * Normalized Gateway stream failure, the same fields the WebSocket carrier's
 * Client reports: `remote` failures come from the Host stream itself, `carrier`
 * failures from the local transport.
 */
export type DesktopStreamFailure =
  | { readonly kind: 'remote'; readonly code: string; readonly message: string; readonly details: object }
  | { readonly kind: 'carrier'; readonly message: string }

/**
 * The Gateway stream faces the desktop carrier needs, structurally satisfied
 * by `typertGateway.wireStream`. Kept structural so this module does not
 * depend on the gateway package.
 */
export interface DesktopWireStream {
  open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
  failure(error: unknown): { code: string; message: string; details: object }
}

/** Delivery sink the Electron wiring implements. */
export interface DesktopBridgeSink {
  /** Deliver one base64 response chunk to the stream's renderer consumer. */
  sendChunk(streamId: string, chunk: string): void
  /** Close one response stream. */
  endStream(streamId: string): void
  /** Deliver one decoded Gateway stream item. */
  sendItem(streamId: string, value: unknown): void
  /** End one Gateway stream normally. */
  endItemStream(streamId: string): void
  /** Fail one Gateway stream with normalized failure fields. */
  failItemStream(streamId: string, failure: DesktopStreamFailure): void
}

/** Narrow an unknown IPC value to the fetch-request wire shape. */
function parseFetchRequest(value: unknown): DesktopFetchRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['url'] !== 'string' || typeof record['method'] !== 'string') return undefined
  const headers = record['headers']
  if (headers !== null && typeof headers === 'object' && !Array.isArray(headers)
    && Object.values(headers as Record<string, unknown>).every(entry => typeof entry === 'string')) {
    return {
      url: record['url'],
      method: record['method'],
      headers: headers as Record<string, string>,
      ...(typeof record['body'] === 'string' ? { body: record['body'] } : {}),
    }
  }
  return undefined
}

/** Decode a base64 request body into the bytes fetch consumes. */
function decodeBody(body: string | undefined): Buffer | undefined {
  if (body === undefined) return undefined
  return Buffer.from(body, 'base64')
}

/**
 * Owns the transport-independent dispatch for one desktop renderer. The app
 * constructs it once after boot with the connection service and the typert
 * gateway's stream face, then binds its methods to IPC handlers.
 */
export class DesktopBridge {
  private readonly fetchHandler: ConnectionFetchHandler

  constructor(
    connection: HostConnectionHandle,
    private readonly wireStream: DesktopWireStream,
    private readonly sink: DesktopBridgeSink,
  ) {
    this.fetchHandler = connection.createSharedFetchHandler(API_PATH)
  }

  /**
   * Handle one renderer fetch: validate the wire shape, dispatch through the
   * shared channel face, and stream the response body back chunk by chunk.
   * @param value - untrusted IPC input.
   * @returns the settlement; a malformed request yields a 400 response.
   */
  async handleRequest(value: unknown): Promise<DesktopFetchInit> {
    const input = parseFetchRequest(value)
    if (input === undefined) return { status: 400, headers: {}, body: Buffer.from('bad request').toString('base64') }
    const decoded = decodeBody(input.body)
    const request = new Request(input.url, {
      method: input.method,
      headers: input.headers,
      ...(decoded === undefined ? {} : { body: new Blob([new Uint8Array(decoded)]) }),
    })
    const response = await this.fetchHandler.fetch(request)
    const headers: Record<string, string> = {}
    for (const [key, value] of response.headers.entries()) headers[key] = value
    if (response.body === null) {
      return { status: response.status, headers, body: '' }
    }
    const streamId = randomId()
    void this.pump(streamId, response.body)
    return { status: response.status, headers, streamId, body: '' }
  }

  /** Pump one response body into the sink until end or error. */
  private async pump(streamId: string, body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of body) {
        this.sink.sendChunk(streamId, Buffer.from(chunk).toString('base64'))
      }
    } catch (error) {
      // Delivery ends here; the renderer's stream consumer observes the close.
      void error
    } finally {
      this.sink.endStream(streamId)
    }
  }

  /**
   * Pump one Gateway stream into the sink until the Host ends it, the renderer
   * aborts, or this bridge is disposed. Open failures report as `carrier`
   * failures; iteration failures normalize through the gateway's own failure
   * face as `remote` failures.
   * @param id - renderer-chosen stream id echoed on every sink delivery.
   * @param endpoint - Gateway stream endpoint.
   * @param payload - decoded endpoint payload.
   * @param signal - renderer-lifetime abort.
   * @returns a disposer stopping the pump.
   */
  openStream(id: string, endpoint: string, payload: unknown, signal: AbortSignal): () => void {
    // Boxed so the closure-disposed flag stays a runtime fact, not a literal.
    const state = { closed: false }
    void (async () => {
      let source: AsyncIterable<unknown>
      try {
        source = await this.wireStream.open(endpoint, payload, signal)
      } catch (error) {
        if (!state.closed && !signal.aborted) {
          this.sink.failItemStream(id, { kind: 'carrier', message: failureMessage(error) })
        }
        return
      }
      try {
        for await (const value of source) {
          if (state.closed || signal.aborted) return
          this.sink.sendItem(id, value)
        }
        if (!state.closed && !signal.aborted) this.sink.endItemStream(id)
      } catch (error) {
        if (!state.closed && !signal.aborted) {
          this.sink.failItemStream(id, { kind: 'remote', ...this.wireStream.failure(error) })
        }
      }
    })()
    return () => { state.closed = true }
  }
}

/** Render one thrown value as a carrier-failure message. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `crypto.randomUUID` is unavailable in the plain-Node test harness of older Nodes; keep one local id source. */
function randomId(): string {
  return `ds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
