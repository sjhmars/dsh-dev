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

/** Normalized Gateway stream failure, as the connection node half reports it. */
export type DesktopStreamFailure =
  | { readonly kind: 'remote'; readonly code: string; readonly message: string; readonly details: object }
  | { readonly kind: 'carrier'; readonly message: string }

/** The bridge surface exposed as `window.desktopBridge`. */
export interface DesktopBridgeTransport {
  request(input: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<DesktopFetchInit>
  onChunk(streamId: string, listener: (chunk: string) => void): () => void
  onStreamEnd(streamId: string, listener: () => void): () => void
  openStream(id: string, endpoint: string, payload: unknown): void
  closeStream(id: string): void
  onStreamItem(streamId: string, listener: (value: unknown) => void): () => void
  onItemEnd(streamId: string, listener: () => void): () => void
  onStreamError(streamId: string, listener: (failure: DesktopStreamFailure) => void): () => void
}
