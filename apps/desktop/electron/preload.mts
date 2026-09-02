/**
 * Desktop preload: exposes the typed `window.desktopBridge` transport the
 * injected shell glue consumes. Only these channels exist — no raw ipcRenderer
 * reaches the renderer, and every inbound payload is shape-checked before
 * delivery.
 * @module @deepseek-ai/dsh-desktop/preload
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { DESKTOP_BRIDGE_CHANNELS as CH } from '../src/shared/channels.ts'
import { desktopTitleBarStyle } from './chrome.ts'
import type { DesktopBridgeTransport, DesktopFetchInit, DesktopStreamFailure } from './transport.ts'

function isChunk(payload: unknown): { streamId: string; chunk: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  return typeof record['streamId'] === 'string' && typeof record['chunk'] === 'string'
    ? { streamId: record['streamId'], chunk: record['chunk'] }
    : undefined
}

function isStreamEnd(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  return typeof record['streamId'] === 'string' ? record['streamId'] : undefined
}

function isItem(payload: unknown): { id: string; value: unknown } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  return typeof record['id'] === 'string' && 'value' in record
    ? { id: record['id'], value: record['value'] }
    : undefined
}

function isId(payload: unknown): string | undefined {
  return typeof payload === 'string' ? payload : undefined
}

function isFailure(payload: unknown): { id: string; failure: DesktopStreamFailure } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (typeof record['id'] !== 'string') return undefined
  const failure = record['failure']
  if (typeof failure !== 'object' || failure === null) return undefined
  const shape = failure as Record<string, unknown>
  if (shape['kind'] === 'carrier') {
    return typeof shape['message'] === 'string'
      ? { id: record['id'], failure: { kind: 'carrier', message: shape['message'] } }
      : undefined
  }
  if (shape['kind'] === 'remote') {
    return typeof shape['code'] === 'string' && typeof shape['message'] === 'string'
      && typeof shape['details'] === 'object' && shape['details'] !== null
      ? {
          id: record['id'],
          failure: {
            kind: 'remote',
            code: shape['code'],
            message: shape['message'],
            details: shape['details'],
          },
        }
      : undefined
  }
  return undefined
}

function subscribe<T>(channel: string, parse: (payload: unknown) => T | undefined, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: unknown): void => {
    const value = parse(payload)
    if (value !== undefined) listener(value)
  }
  ipcRenderer.on(channel, handler)
  return () => { ipcRenderer.off(channel, handler) }
}

const bridge: DesktopBridgeTransport = {
  request: input => ipcRenderer.invoke(CH.request, input) as Promise<DesktopFetchInit>,
  onChunk: (streamId, listener) => subscribe(CH.chunk, isChunk, (value) => {
    if (value.streamId === streamId) listener(value.chunk)
  }),
  onStreamEnd: (streamId, listener) => subscribe(CH.streamEnd, isStreamEnd, (value) => {
    if (value === streamId) listener()
  }),
  openStream: (id, endpoint, payload) => {
    // Subscriptions live on the exposed object; the main pump starts as soon
    // as this invoke lands and deliveries before registration would drop.
    void ipcRenderer.invoke(CH.streamOpen, { id, endpoint, payload })
  },
  closeStream: id => {
    void ipcRenderer.invoke(CH.streamClose, id)
  },
  onStreamItem: (id, listener) => subscribe(CH.item, isItem, (value) => {
    if (value.id === id) listener(value.value)
  }),
  onItemEnd: (id, listener) => subscribe(CH.itemEnd, isId, (value) => {
    if (value === id) listener()
  }),
  onStreamError: (id, listener) => subscribe(CH.itemError, isFailure, (value) => {
    if (value.id === id) listener(value.failure)
  }),
}

contextBridge.exposeInMainWorld('desktopBridge', bridge)

// The sidebar spans the title row while the native controls and drag seat use
// the remaining columns. Main content keeps the same lower edge and top inset.
if (typeof document !== 'undefined') {
  const style = document.createElement('style')
  style.textContent = desktopTitleBarStyle()
  const attach = (): void => {
    document.head.appendChild(style)
    const dragRegion = document.createElement('div')
    dragRegion.dataset['desktopWindowDrag'] = ''
    dragRegion.setAttribute('aria-hidden', 'true')
    document.body.appendChild(dragRegion)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true })
  } else {
    attach()
  }
}
