/**
 * Browser-side bridge face the desktop preload exposes as
 * `window.desktopBridge`. Everything is JSON-safe or a callback — the
 * contextBridge serializes the invoke results and event payloads.
 * @module @deepseek-ai/dsh-client-connection/desktop-transport
 */

import type { ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'

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

/** One open server event stream. */
export type DesktopEventKind = 'mux' | 'host'

/** The bridge the desktop preload exposes to the renderer. */
export interface DesktopBridgeTransport {
  /** One fetch-shaped round trip; streaming bodies deliver chunks separately. */
  request(input: DesktopFetchRequest): Promise<DesktopFetchInit>
  /** Subscribe to one response stream's base64 chunks. */
  onChunk(streamId: string, listener: (chunk: string) => void): () => void
  /** Subscribe to one response stream's end. */
  onStreamEnd(streamId: string, listener: () => void): () => void
  /** Open one mux/host event stream. */
  openEvents(kind: DesktopEventKind, listener: (frame: ServerRequest) => void): () => void
  /** Observe one event stream's end. */
  onEventsEnd(kind: DesktopEventKind, listener: () => void): () => void
}

declare global {
  interface Window {
    /** Present only in the desktop shell; the browser carrier leaves it unset. */
    desktopBridge?: DesktopBridgeTransport
  }
}
