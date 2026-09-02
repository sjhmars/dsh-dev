/**
 * IPC channel names shared by the desktop preload and the Electron main
 * bridge wiring. The renderer never sees these — the preload is the only
 * consumer and exposes the typed transport instead.
 * @module @deepseek-ai/dsh-desktop/channels
 */

export const DESKTOP_BRIDGE_CHANNELS = {
  /** Renderer → main: one fetch-shaped round trip. */
  request: 'desktop:request',
  /** Main → renderer: one base64 response chunk ({streamId, chunk}). */
  chunk: 'desktop:chunk',
  /** Main → renderer: one response stream ended ({streamId}). */
  streamEnd: 'desktop:stream-end',
  /** Renderer → main: open one Gateway stream pump ({id, endpoint, payload}). */
  streamOpen: 'desktop:stream:open',
  /** Renderer → main: abort one Gateway stream pump (id). */
  streamClose: 'desktop:stream:close',
  /** Main → renderer: one decoded Gateway stream item ({id, value}). */
  item: 'desktop:stream:item',
  /** Main → renderer: one Gateway stream ended ({id}). */
  itemEnd: 'desktop:stream:end',
  /** Main → renderer: one Gateway stream failed ({id, failure}). */
  itemError: 'desktop:stream:error',
} as const
