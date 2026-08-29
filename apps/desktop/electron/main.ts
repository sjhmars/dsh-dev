/**
 * Desktop main entry: the Electron main process IS the dsh host. It boots
 * the web composition in-process (base + web-app + desktop patch layers,
 * transport rows disabled — no HTTP listener anywhere), then serves the same
 * built frontend dist over a privileged local app:// scheme with the boot
 * manifest injected, and bridges every renderer request over IPC.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { app, BrowserWindow, Menu, net, protocol, shell } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { bootInjections } from '@deepseek-ai/dsh-client-modules'
import { API_PATH, HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bootDesktopHost, shippedPresetRoot } from './boot.ts'
import { wireDesktopBridge } from './bridge.ts'
import { DESKTOP_TITLE_BAR } from './chrome.ts'
import { resolveDistPath, resolvePluginBundle } from './protocol.ts'

// Registered before ready: a standard, secure origin gives the renderer a
// real storage origin (localStorage/sessionStorage) and a secure context. A
// non-standard scheme leaves app:// opaque, and any localStorage read then
// throws "Access is denied for this document".
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

// apps/desktop/lib/electron/main.js -> the app package dir in both dev and
// packaged (app.asar) modes; the installation anchor the profile loader
// resolves bundles and the module fallback from.
const appDir = fileURLToPath(new URL('../..', import.meta.url))
const INSTALL_ANCHOR = join(appDir, 'package.json')

/**
 * Boot the host composition: the `desktop` profile (base + web-app +
 * desktop-app bundle layers, plus the user's home patch layer). The desktop
 * bundle disables the HTTP/WS transport rows, so the tree serves no
 * listener — the renderer reaches it only through the IPC bridge.
 * @returns the settled root context.
 */
async function bootHost(): Promise<Context> {
  const presetRoot = app.isPackaged
    ? join(process.resourcesPath, 'agent-presets')
    : shippedPresetRoot(INSTALL_ANCHOR)
  return bootDesktopHost(INSTALL_ANCHOR, { presetRoot })
}

let quitting = false
let disposeBridge: (() => void) | undefined
let hostContext: Context | undefined

function createWindow(ctx: Context): BrowserWindow {
  const distIndex = ctx.get('desktopRuntime')?.distIndex
  const clientModules = ctx.get('clientModules')
  if (distIndex === undefined || clientModules === undefined) {
    throw new Error('dsh-desktop: the booted composition must mount desktopRuntime and clientModules')
  }

  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // The web favicon's whale mark (same asset the browser tab shows).
    icon: join(appDir, 'build/icon.png'),
    // The transparent native overlay retains Windows hover, pressed, and
    // close-danger states. The renderer paints its title row from the live
    // sidebar token and reserves the same compact geometry.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: DESKTOP_TITLE_BAR.overlayColor,
      height: DESKTOP_TITLE_BAR.height,
    },
    backgroundColor: '#1b1b1c',
    webPreferences: {
      preload: join(appDir, 'lib/electron/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preloads require the renderer sandbox off; the contextBridge
      // whitelist is the whole boundary (see README security posture).
      sandbox: false,
    },
  })
  window.once('ready-to-show', () => { window.show() })
  // The window never navigates away from app:// (in-app links and window.open
  // are denied), but ordinary http(s) links open in the system browser —
  // the model's URLs, docs links, etc. stay usable without leaving the app.
  const openExternal = (url: string): void => {
    try {
      const protocol = new URL(url).protocol
      if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(url)
    } catch {
      // Malformed URLs are dropped; other schemes (file:, custom handlers)
      // are deliberately not opened.
    }
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternal(url)
  })
  if (!app.isPackaged) {
    // Dev affordance: renderer console reaches the terminal, so web-shell
    // failures are diagnosable without DevTools (the menu bar is removed).
    window.webContents.on('console-message', (event) => {
      const detail = event as { level?: string; message?: string }
      console.log(`[renderer ${detail.level ?? 'log'}] ${detail.message ?? String(event)}`)
    })
  }
  disposeBridge = wireDesktopBridge(ctx, window)
  void window.loadURL('app://app/index.html')
  return window
}

void app.whenReady().then(async () => {
  // No native menu bar: the Web shell owns every toolbar surface, and the
  // default File/Edit/View menu offers nothing this app uses.
  Menu.setApplicationMenu(null)

  // Serve the built frontend over the privileged local app:// scheme (module
  // scripts cannot load over file://). Index responses inject the boot
  // manifest the same way the Web host's index tap does.
  protocol.handle('app', async (request) => {
    const ctx = hostContext
    if (ctx === undefined) return new Response('host not ready', { status: 503 })
    const distIndex = ctx.get('desktopRuntime')?.distIndex
    const clientModules = ctx.get('clientModules')
    if (distIndex === undefined || clientModules === undefined) {
      return new Response('composition incomplete', { status: 500 })
    }
    const distRoot = dirname(distIndex)
    // Raw renderer fetches to /api (the logical RPC channel and any other
    // same-origin API call the web code issues through globalThis.fetch)
    // arrive here: forward them through the connection node half's shared
    // fetch handler, the same composition the Web host's /api route serves —
    // the typert gateway's interceptor claims the generated Remote endpoints
    // (commands/list etc.), and only the unclaimed rest falls through to the
    // in-process apiProxy gateway. The HTTP trust fence does not apply (the
    // desktop trust model: only this app's own window can reach this
    // protocol).
    if (new URL(request.url).pathname.startsWith('/api')) {
      const apiProxy = ctx.get('apiProxy')
      if (apiProxy === undefined) return new Response('not found', { status: 404 })
      const gateway = toFetchHandler(apiProxy)
      const hostConnection = ctx.get('connection')
      const handler = hostConnection instanceof HostConnectionService
        ? hostConnection.createSharedFetchHandler(API_PATH, gateway)
        : gateway
      return handler.fetch(request)
    }
    // Plugin bundles: the shell loads them via same-origin <script src> (a
    // script element never crosses the bridge), so this protocol serves them
    // exactly as the Web host's /plugins route does — same clientModules
    // face, same paths, same no-cache semantics.
    const plugin = resolvePluginBundle(new URL(request.url).pathname)
    if (plugin.kind === 'bundle') {
      const text = await clientModules.bundleText(plugin.id, plugin.sourceMap)
      if (text === undefined) return new Response('not found', { status: 404 })
      return new Response(text, {
        headers: {
          'content-type': plugin.sourceMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
        },
      })
    }
    const resolution = resolveDistPath(distRoot, distIndex, new URL(request.url).pathname)
    if (resolution.kind === 'bad') return new Response('bad request', { status: 400 })
    if (resolution.kind === 'forbidden') return new Response('forbidden', { status: 403 })
    // Index (and every SPA fallback) injects the boot manifest rows the same
    // way the Web host's webserver renders them.
    const injectIndex = async (): Promise<string> => {
      const html = await readFile(distIndex, 'utf8')
      return renderIndexInjections(html, bootInjections(clientModules.graph()))
    }
    if (resolution.kind === 'index') {
      return new Response(await injectIndex(), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    try {
      await readFile(resolution.path)
    } catch {
      // SPA fallback: unknown paths serve the index (same as frontend-static).
      return new Response(await injectIndex(), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    return net.fetch(pathToFileURL(resolution.path).toString())
  })

  hostContext = await bootHost()
  createWindow(hostContext)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && hostContext !== undefined) createWindow(hostContext)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  disposeBridge?.()
  void (hostContext?.fiber.dispose() ?? Promise.resolve()).finally(() => { app.exit(0) })
})
