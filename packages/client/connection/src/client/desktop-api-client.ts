/**
 * Desktop API carrier: the AbstractApiClient transport seams bound to the
 * preload bridge, installed through the connection package's official
 * `ClientTransportHooks` page seam (`window.__DSH_TRANSPORT__`) — the same
 * mechanism the worker-preview shell uses — instead of forking the plugin's
 * apply. The preload exposes the raw bridge as `window.desktopBridge`; this
 * module's scope installs the transport when the bridge is present, so the
 * served web app (no bridge) stays on HTTP + WebSocket untouched.
 * `doFetch` rebuilds a WHATWG Response over the bridge's chunk stream;
 * `openMux`/`openHost` surface the bridge's event streams as the same
 * AsyncIterables the upstream carriers yield. Frame validation is the same
 * schema pair as every carrier (wire boundary).
 * @module @deepseek-ai/dsh-client-connection/desktop-api-client
 */

import type { ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { ClientTransportHooks } from './index.ts'
import type { DesktopBridgeTransport, DesktopEventKind } from './desktop-transport.ts'

/** Decode one base64 chunk into bytes. */
function decodeChunk(chunk: string): Uint8Array<ArrayBuffer> {
  const binary = atob(chunk)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Encode a request body into the bridge's base64 wire form. */
async function encodeBody(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body === null || body === undefined) return undefined
  const bytes = typeof body === 'string'
    ? new TextEncoder().encode(body)
    : new Uint8Array(await new Response(body).arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Serialize the init headers into the bridge's plain record. */
function headersOf(init: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {}
  if (init.headers === undefined) return headers
  if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) headers[key] = value
    return headers
  }
  for (const [key, value] of Object.entries(init.headers as Record<string, string>)) headers[key] = value
  return headers
}

/** Build a streaming Response over the bridge's chunk/end subscriptions. */
function streamingResponse(streamId: string, status: number, headers: Record<string, string>, bridge: DesktopBridgeTransport): Response {
  const chunks: string[] = []
  let ended = false
  let wake: (() => void) | undefined
  const stop = (): void => { offChunk(); offEnd() }
  const offChunk = bridge.onChunk(streamId, (chunk) => { chunks.push(chunk); wake?.(); wake = undefined })
  const offEnd = bridge.onStreamEnd(streamId, () => { ended = true; wake?.(); wake = undefined })
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const chunk = chunks.shift()
        if (chunk !== undefined) {
          controller.enqueue(decodeChunk(chunk))
          return
        }
        if (ended) {
          controller.close()
          return
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
    cancel() { stop() },
  })
  return new Response(body, { status, headers })
}

/** One bridged unary round trip: encode the request, dispatch, stream chunks back. */
async function desktopFetch(bridge: DesktopBridgeTransport, input: URL, init: RequestInit): Promise<Response> {
  const body = await encodeBody(init.body)
  const settlement = await bridge.request({
    url: input.toString(),
    method: init.method ?? 'GET',
    headers: headersOf(init),
    ...(body === undefined ? {} : { body }),
  })
  if (settlement.streamId !== undefined) {
    return streamingResponse(settlement.streamId, settlement.status, settlement.headers, bridge)
  }
  const bytes = settlement.body === '' ? new Uint8Array(0) : decodeChunk(settlement.body)
  return new Response(new Blob([bytes]), { status: settlement.status, headers: settlement.headers })
}

/** The preload-bridge carrier for the desktop shell. */
export class DesktopApiClient extends AbstractApiClient {
  constructor(private readonly bridge: DesktopBridgeTransport) {
    super()
  }

  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return desktopFetch(this.bridge, input, init ?? {})
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.openEvents<MuxFrame>('mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.openEvents<HostFrame>('host', signal, hostFrameSchema, onOpen)
  }

  private openEvents<F extends MuxFrame | HostFrame>(
    kind: DesktopEventKind,
    signal: AbortSignal,
    frameSchema: { parse(value: unknown): F },
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<F>> {
    type InboxItem = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
    const inbox: InboxItem[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: InboxItem): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const onFrame = (frame: ServerRequest): void => {
      try {
        const full = serverRequestSchema.parse(frame)
        const payload = frameSchema.parse(full.payload)
        this.onEnvelope(full)
        enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload } })
      } catch (error) {
        console.error(`[desktop-connection] dropping malformed ${kind} frame:`, error)
      }
    }
    const offEnd = this.bridge.onEventsEnd(kind, () => { enqueue({ kind: 'end' }) })
    const close = this.bridge.openEvents(kind, onFrame)
    const onAbort = (): void => {
      close()
      offEnd()
      enqueue({ kind: 'end' })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    onOpen?.()
    if (signal.aborted) onAbort()
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            for (;;) {
              const item = inbox.shift()
              if (item !== undefined) {
                if (item.kind === 'end') return { done: true, value: undefined }
                return { done: false, value: item.envelope }
              }
              await new Promise<void>((resolve) => { wake = resolve })
            }
          },
        }
      },
    }
  }
}

// Transport installation. The seam must exist before the connection apply
// reads it, and the only page-world entry points are bundle factories — so
// this module scope installs the desktop transport when the bridge is
// present. That is the mechanism the seam itself exists for (a custom
// transport shell replaces the browser carrier wholesale instead of forking
// the plugin), and it is inert in the served web app, where
// `window.desktopBridge` is unset.
if (typeof window !== 'undefined' && window.desktopBridge !== undefined) {
  const bridge = window.desktopBridge
  const transport: ClientTransportHooks = {
    createApiClient: () => new DesktopApiClient(bridge),
    fetch: (input, init) => desktopFetch(bridge, input, init),
  }
  ;(globalThis as { __DSH_TRANSPORT__?: ClientTransportHooks }).__DSH_TRANSPORT__ = transport
}
