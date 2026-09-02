/**
 * Browser-side bridge face the desktop preload exposes as
 * `window.desktopBridge`, plus the transport installer the desktop shell
 * injects ahead of the client boot. Everything crossing the contextBridge is
 * JSON-safe or a callback; the AsyncIterable the connection layer consumes is
 * assembled on the page from subscription callbacks, because generators do not
 * survive the bridge.
 * @module @deepseek-ai/dsh-client-connection/desktop-transport
 */

import type { RpcFetch, RpcStreamOpen } from './rpc.ts'

/** Serialized fetch request crossing the bridge. */
export interface DesktopFetchRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** Base64 request body; absent for bodyless requests. */
  body?: string
}

/** Fetch settlement returned before any chunk arrives. */
export interface DesktopFetchInit {
  status: number
  headers: Record<string, string>
  /** Present when the response body streams; chunks follow on this id. */
  streamId?: string
  /** Base64 body for non-streamed responses (empty body included). */
  body: string
}

/**
 * Normalized Gateway stream failure; mirrors
 * {@link import('./desktop.ts').DesktopStreamFailure} structurally so the
 * renderer face carries no node-half import.
 */
export type DesktopStreamFailure =
  | { readonly kind: 'remote'; readonly code: string; readonly message: string; readonly details: object }
  | { readonly kind: 'carrier'; readonly message: string }

/** The bridge surface the desktop preload exposes as `window.desktopBridge`. */
export interface DesktopBridgeTransport {
  /** One fetch-shaped round trip; streaming bodies deliver chunks separately. */
  request(input: DesktopFetchRequest): Promise<DesktopFetchInit>
  /** Subscribe to one response stream's base64 chunks. */
  onChunk(streamId: string, listener: (chunk: string) => void): () => void
  /** Subscribe to one response stream's end. */
  onStreamEnd(streamId: string, listener: () => void): () => void
  /** Start one Gateway stream pump; deliveries arrive through the subscriptions. */
  openStream(id: string, endpoint: string, payload: unknown): void
  /** Abort one Gateway stream pump. */
  closeStream(id: string): void
  /** Subscribe to one Gateway stream's decoded items. */
  onStreamItem(streamId: string, listener: (value: unknown) => void): () => void
  /** Subscribe to one Gateway stream's normal end. */
  onItemEnd(streamId: string, listener: () => void): () => void
  /** Subscribe to one Gateway stream's failure. */
  onStreamError(streamId: string, listener: (failure: DesktopStreamFailure) => void): () => void
}

declare global {
  interface Window {
    /** Present only in the desktop shell; the browser carrier leaves it unset. */
    desktopBridge?: DesktopBridgeTransport
  }
}

/** Decode a base64 wire body into bytes. */
function decodeBase64(body: string): Uint8Array<ArrayBuffer> {
  const binary = atob(body)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Base64-encode bytes in chunks, avoiding giant spread calls on large payloads. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

/** Encode one fetch body (string or bytes) into the base64 wire form. */
function encodeBody(body: BodyInit): string {
  if (typeof body === 'string') return encodeBase64(new TextEncoder().encode(body))
  if (body instanceof URLSearchParams) return encodeBase64(new TextEncoder().encode(body.toString()))
  if (body instanceof ArrayBuffer) return encodeBase64(new Uint8Array(body))
  if (ArrayBuffer.isView(body)) return encodeBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  // Blob and ReadableStream bodies never cross this bridge: the client RPC
  // layer issues JSON requests only.
  throw new Error('desktop transport: unsupported fetch body type')
}

/** Flatten one RequestInit headers value into the plain record the wire carries. */
function flattenHeaders(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {}
  const value = init.headers
  if (value === undefined) return headers
  if (value instanceof Headers) {
    value.forEach((entry, key) => { headers[key] = entry })
  } else if (Array.isArray(value)) {
    for (const [key, entry] of value) headers[key] = entry
  } else {
    for (const [key, entry] of Object.entries(value)) headers[key] = entry
  }
  return headers
}

/**
 * Assemble the connection transport hooks from the exposed bridge. The
 * desktop shell injects its output as `globalThis.__DSH_TRANSPORT__` before
 * any client bundle runs — the same page-glue seam the worker carrier uses.
 * @param bridge - the preload-exposed bridge.
 * @returns the transport hooks; `loadBundle` stays absent because plugin
 *   bundles load over the app:// origin like the served web app.
 */
export function createDesktopTransport(bridge: DesktopBridgeTransport): {
  fetch: RpcFetch
  openStream: RpcStreamOpen
  ownsHost: true
} {
  const fetch: RpcFetch = async (input, init) => {
    const settlement = await bridge.request({
      url: input.toString(),
      method: init.method ?? 'GET',
      headers: flattenHeaders(init),
      ...(init.body === undefined || init.body === null ? {} : { body: encodeBody(init.body) }),
    })
    const responseInit: ResponseInit = {
      status: settlement.status,
      headers: settlement.headers,
    }
    if (settlement.streamId === undefined) {
      const bytes = settlement.body === '' ? new Uint8Array(0) : decodeBase64(settlement.body)
      return new Response(bytes, responseInit)
    }
    const streamId = settlement.streamId
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bridge.onChunk(streamId, (chunk) => { controller.enqueue(decodeBase64(chunk)) })
        bridge.onStreamEnd(streamId, () => { controller.close() })
      },
    })
    return new Response(body, responseInit)
  }

  const openStream: RpcStreamOpen = async function * (endpoint, payload, signal) {
    signal.throwIfAborted()
    const id = `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    let terminal = false
    let wake: (() => void) | undefined
    let item: { type: 'item'; value: unknown } | { type: 'end' } | { type: 'error'; failure: DesktopStreamFailure } | undefined
    const step = (next: typeof item): void => {
      item = next
      wake?.()
      wake = undefined
    }
    const offItem = bridge.onStreamItem(id, (value) => { step({ type: 'item', value }) })
    const offEnd = bridge.onItemEnd(id, () => { step({ type: 'end' }) })
    const offError = bridge.onStreamError(id, (failure) => { step({ type: 'error', failure }) })
    const onAbort = (): void => { bridge.closeStream(id); step({ type: 'end' }) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      bridge.openStream(id, endpoint, payload)
      while (true) {
        if (item === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          signal.throwIfAborted()
        }
        const current = item
        item = undefined
        if (current === undefined) continue
        if (current.type === 'item') {
          yield current.value
          continue
        }
        terminal = true
        if (current.type === 'error') {
          throw new DesktopBridgeStreamError(current.failure)
        }
        return
      }
    } finally {
      offItem()
      offEnd()
      offError()
      signal.removeEventListener('abort', onAbort)
      // A consumer that stopped iterating early (or an abort racing the open)
      // must still tell the main process to stop the pump.
      if (!terminal) bridge.closeStream(id)
    }
  }

  return { fetch, openStream, ownsHost: true }
}

/**
 * One failed Gateway stream, carrying the normalized failure fields the
 * WebSocket carrier reports so the connection layer treats both alike.
 */
export class DesktopBridgeStreamError extends Error {
  constructor(readonly failure: DesktopStreamFailure) {
    super(failure.message)
    this.name = 'DesktopBridgeStreamError'
  }
}
