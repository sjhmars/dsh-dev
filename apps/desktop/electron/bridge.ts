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

/** One open Gateway stream pump and the abort that stops it. */
interface StreamPump {
  abort: AbortController
  close: () => void
}

/** Narrow an unknown IPC value to the stream-open wire shape. */
function parseStreamOpen(value: unknown): { id: string; endpoint: string; payload: unknown } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record['id'] !== 'string' || typeof record['endpoint'] !== 'string') return undefined
  return { id: record['id'], endpoint: record['endpoint'], payload: record['payload'] }
}

/**
 * Wire the booted host's connection and Gateway stream faces to one window.
 * The preload is the only caller; anything it forwards already crossed the
 * contextBridge whitelist, so the bridge treats every request as the local
 * (loopback-equivalent) caller the desktop trust model documents.
 * @param ctx - booted host context carrying connection and typertGateway.
 * @param window - the renderer window this bridge serves.
 * @returns a disposer removing every handler and stopping every stream.
 */
export function wireDesktopBridge(ctx: Context, window: BrowserWindow): () => void {
  const connection = ctx.get('connection')
  if (connection === undefined) {
    throw new Error('dsh-desktop: the booted composition must mount the connection service (dsh-client-connection)')
  }
  const typertGateway = ctx.get('typertGateway')
  if (typertGateway === undefined) {
    throw new Error('dsh-desktop: the booted composition must mount typertGateway (dsh-api-gateway)')
  }
  const contents: WebContents = window.webContents
  const sink: DesktopBridgeSink = {
    sendChunk: (streamId, chunk) => contents.send(CH.chunk, { streamId, chunk }),
    endStream: streamId => contents.send(CH.streamEnd, { streamId }),
    sendItem: (id, value) => contents.send(CH.item, { id, value }),
    endItemStream: id => contents.send(CH.itemEnd, { id }),
    failItemStream: (id, failure) => contents.send(CH.itemError, { id, failure }),
  }
  const bridge = new DesktopBridge(connection, typertGateway.wireStream, sink)
  const pumps = new Map<string, StreamPump>()

  ipcMain.handle(CH.request, (_event, value: unknown) => bridge.handleRequest(value))
  ipcMain.handle(CH.streamOpen, (_event, value: unknown) => {
    const open = parseStreamOpen(value)
    if (open === undefined || pumps.has(open.id)) return false
    const abort = new AbortController()
    const close = bridge.openStream(open.id, open.endpoint, open.payload, abort.signal)
    pumps.set(open.id, { abort, close })
    return true
  })
  ipcMain.handle(CH.streamClose, (_event, value: unknown) => {
    if (typeof value !== 'string') return false
    const pump = pumps.get(value)
    if (pump === undefined) return false
    pump.close()
    pump.abort.abort()
    pumps.delete(value)
    return true
  })

  return () => {
    for (const pump of pumps.values()) {
      pump.close()
      pump.abort.abort()
    }
    pumps.clear()
    ipcMain.removeHandler(CH.request)
    ipcMain.removeHandler(CH.streamOpen)
    ipcMain.removeHandler(CH.streamClose)
  }
}
