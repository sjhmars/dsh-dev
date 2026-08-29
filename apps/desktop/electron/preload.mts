/**
 * Desktop preload: exposes the typed `window.desktopBridge` transport the
 * DesktopApiClient consumes. Only these channels exist — no raw ipcRenderer
 * reaches the renderer, and every inbound payload is shape-checked before
 * delivery.
 * @module @deepseek-ai/dsh-desktop/preload
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { DESKTOP_BRIDGE_CHANNELS as CH } from '../src/shared/channels.ts'
import { desktopTitleBarStyle } from './chrome.ts'
import type { DesktopBridgeTransport, DesktopEventKind, DesktopFetchInit, DesktopFrame } from './transport.ts'

function isFrame(payload: unknown): payload is DesktopFrame {
  if (typeof payload !== 'object' || payload === null) return false
  const record = payload as Record<string, unknown>
  return record['type'] === 'server-request'
    && typeof record['rpcId'] === 'string'
    && typeof record['method'] === 'string'
    && typeof record['payload'] === 'object' && record['payload'] !== null
}

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

function isKindFrame(payload: unknown): { kind: DesktopEventKind; frame: DesktopFrame } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const kind = record['kind']
  if (kind !== 'mux' && kind !== 'host') return undefined
  if (!isFrame(record['frame'])) return undefined
  return { kind, frame: record['frame'] }
}

function isEventsEnd(payload: unknown): DesktopEventKind | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  return record['kind'] === 'mux' || record['kind'] === 'host' ? record['kind'] : undefined
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
  openEvents: (kind, listener) => {
    // Subscribe before the pump starts: the main handler begins emitting
    // frames as soon as the open request lands, and unregistered frames drop.
    const off = subscribe(CH.frame, isKindFrame, (value) => {
      if (value.kind === kind) listener(value.frame)
    })
    void ipcRenderer.invoke(CH.eventsOpen, kind)
    return off
  },
  onEventsEnd: (kind, listener) => subscribe(CH.eventsEnd, isEventsEnd, (value) => {
    if (value === kind) listener()
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
