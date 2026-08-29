/**
 * Desktop IPC bridge (node half): the transport-agnostic gateway face
 * (`toFetchHandler(apiProxy)`) and the two server event streams, delivered to
 * one renderer over an injected sink. Electron-free by design — the desktop
 * app owns ipcMain/webContents wiring and injects the sink, so this module
 * typechecks and tests under plain Node.
 *
 * Trust model: the bridge exists only between the app's own main process and
 * its own window (contextBridge whitelist + local-only content). Reaching the
 * bridge therefore equals the browser carrier's loopback caller, so the
 * PRIVILEGED_METHODS Host fence has no desktop counterpart — documented in
 * apps/desktop/README.md as a security precondition.
 * @module @deepseek-ai/dsh-client-connection/desktop
 */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { randomUUID } from 'node:crypto'

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

/** One open event stream on the renderer side. */
export type DesktopEventKind = 'mux' | 'host'

/** Delivery sink the Electron wiring implements. */
export interface DesktopBridgeSink {
  /** Deliver one base64 response chunk to the stream's renderer consumer. */
  sendChunk(streamId: string, chunk: string): void
  /** Close one response stream. */
  endStream(streamId: string): void
  /** Deliver one mux/host event frame (the same ServerRequest shape as the WebSocket carrier). */
  sendFrame(kind: DesktopEventKind, frame: ServerRequest): void
  /** Close one event stream (iterator end on the renderer side). */
  endEvents(kind: DesktopEventKind): void
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
 * Owns the transport-independent gateway dispatch for one desktop renderer.
 * The app constructs it once after boot with `ctx.get('apiProxy')`, then
 * binds its methods to IPC handlers.
 */
export class DesktopBridge {
  private readonly fetchHandler: ReturnType<typeof toFetchHandler>

  constructor(
    private readonly api: ApiProxy,
    private readonly sink: DesktopBridgeSink,
  ) {
    this.fetchHandler = toFetchHandler(api)
  }

  /**
   * Handle one renderer fetch: validate the wire shape, dispatch through the
   * shared gateway face, and stream the response body back chunk by chunk.
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
    const streamId = randomUUID()
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
   * Open one mux/host event stream: frames flow in the same ServerRequest
   * shape the WebSocket carrier uses, until the renderer closes (the wiring
   * aborts the signal) or this bridge is disposed.
   * @param kind - which server stream to pump.
   * @param signal - renderer-lifetime abort.
   * @returns a disposer stopping the pump.
   */
  openEvents(kind: DesktopEventKind, signal: AbortSignal): () => void {
    const source: AsyncIterable<RpcRequest<MuxFrame | HostFrame>> = kind === 'mux'
      ? this.api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
      : this.api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
    // Boxed so the closure-disposed flag stays a runtime fact, not a literal.
    const state = { closed: false }
    void (async () => {
      try {
        for await (const frame of source) {
          if (state.closed || signal.aborted) return
          this.sink.sendFrame(kind, {
            type: 'server-request',
            rpcId: frame.rpcId,
            method: frame.payload.type,
            payload: frame.payload,
          })
        }
      } catch (error) {
        // Stream source ended (or aborted): the renderer observes the close.
        void error
      } finally {
        if (!state.closed) this.sink.endEvents(kind)
      }
    })()
    return () => { state.closed = true }
  }
}
