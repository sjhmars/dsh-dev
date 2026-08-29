/**
 * IPC channel names shared by the desktop preload and the Electron main
 * bridge wiring. The renderer never sees these — the preload is the only
 * consumer and exposes the typed transport instead.
 * @module @deepseek-ai/dsh-desktop/channels
 */

export const DESKTOP_BRIDGE_CHANNELS = {
  /** Renderer → main: one fetch-shaped round trip. */
  request: 'desktop:request',
  /** Renderer → main: open one mux/host event stream. */
  eventsOpen: 'desktop:events:open',
  /** Renderer → main: close one mux/host event stream. */
  eventsClose: 'desktop:events:close',
  /** Main → renderer: one base64 response chunk ({streamId, chunk}). */
  chunk: 'desktop:chunk',
  /** Main → renderer: one response stream ended ({streamId}). */
  streamEnd: 'desktop:stream-end',
  /** Main → renderer: one event frame ({kind, frame}). */
  frame: 'desktop:frame',
  /** Main → renderer: one event stream ended ({kind}). */
  eventsEnd: 'desktop:events:end',
} as const
