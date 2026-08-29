/**
 * Electron bridge wiring: binds the transport-agnostic DesktopBridge from
 * dsh-client-connection to ipcMain and the window's webContents. Everything
 * electron-specific lives here; the bridge itself stays Node-testable.
 * @module @deepseek-ai/dsh-desktop/bridge
 */

import type { BrowserWindow, WebContents } from 'electron'
import { ipcMain } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { DesktopBridge, type DesktopBridgeSink } from '@deepseek-ai/dsh-client-connection/desktop'
import { DESKTOP_BRIDGE_CHANNELS as CH } from '../src/shared/channels.ts'

/** One open event stream and the abort that stops its pump. */
interface EventStream {
  abort: AbortController
  close: () => void
}

/**
 * Wire the booted host's gateway to one window. The preload is the only
 * caller; anything it forwards already crossed the contextBridge whitelist,
 * so the bridge treats every request as the local (loopback-equivalent)
 * caller the desktop trust model documents.
 * @param ctx - booted host context carrying apiProxy.
 * @param window - the renderer window this bridge serves.
 * @returns a disposer removing every handler and stopping every stream.
 */
export function wireDesktopBridge(ctx: Context, window: BrowserWindow): () => void {
  const apiProxy = ctx.get('apiProxy')
  if (apiProxy === undefined) {
    throw new Error('dsh-desktop: the booted composition must mount apiProxy (dsh-host-apiproxy)')
  }
  const contents: WebContents = window.webContents
  const sink: DesktopBridgeSink = {
    sendChunk: (streamId, chunk) => contents.send(CH.chunk, { streamId, chunk }),
    endStream: streamId => contents.send(CH.streamEnd, { streamId }),
    sendFrame: (kind, frame) => contents.send(CH.frame, { kind, frame }),
    endEvents: kind => contents.send(CH.eventsEnd, { kind }),
  }
  const bridge = new DesktopBridge(apiProxy, sink)
  const streams = new Map<string, EventStream>()

  ipcMain.handle(CH.request, (_event, value: unknown) => bridge.handleRequest(value))
  ipcMain.handle(CH.eventsOpen, (_event, value: unknown) => {
    const kind = value === 'mux' || value === 'host' ? value : undefined
    if (kind === undefined) return false
    const abort = new AbortController()
    const close = bridge.openEvents(kind, abort.signal)
    streams.set(kind, { abort, close })
    return true
  })
  ipcMain.handle(CH.eventsClose, (_event, value: unknown) => {
    const kind = value === 'mux' || value === 'host' ? value : undefined
    if (kind === undefined) return false
    const stream = streams.get(kind)
    if (stream === undefined) return false
    stream.close()
    stream.abort.abort()
    streams.delete(kind)
    return true
  })

  return () => {
    for (const stream of streams.values()) {
      stream.close()
      stream.abort.abort()
    }
    streams.clear()
    ipcMain.removeHandler(CH.request)
    ipcMain.removeHandler(CH.eventsOpen)
    ipcMain.removeHandler(CH.eventsClose)
  }
}
