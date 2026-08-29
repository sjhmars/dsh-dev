/**
 * The bridge transport face the desktop preload implements. Declared
 * app-side on purpose: the preload is the producer, and importing the
 * connection package's client-face types here would cross project faces
 * (the app references only the connection host face). The wire shapes stay
 * structurally identical to `DesktopBridgeTransport` in
 * dsh-client-connection — both ends validate the same payloads.
 * @module @deepseek-ai/dsh-desktop/transport
 */

/** Fetch settlement returned to the renderer before any chunk arrives. */
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

/** The server-request frame the renderer's carrier consumes. */
export interface DesktopFrame {
  type: 'server-request'
  rpcId: string
  method: string
  payload: Record<string, unknown>
}

/** The bridge surface exposed as `window.desktopBridge`. */
export interface DesktopBridgeTransport {
  request(input: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<DesktopFetchInit>
  onChunk(streamId: string, listener: (chunk: string) => void): () => void
  onStreamEnd(streamId: string, listener: () => void): () => void
  openEvents(kind: DesktopEventKind, listener: (frame: DesktopFrame) => void): () => void
  onEventsEnd(kind: DesktopEventKind, listener: () => void): () => void
}
