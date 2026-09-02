/**
 * The page-glue script the desktop shell injects ahead of every boot row: it
 * turns the contextBridge-exposed `window.desktopBridge` into the
 * `__DSH_TRANSPORT__` hooks the connection client plugin reads. The same seam
 * the worker carrier uses — the transport global must exist before any client
 * bundle executes. Kept as a self-contained inline script because generators
 * cannot cross the contextBridge: the AsyncIterable is assembled on the page
 * from subscription callbacks. Semantics mirror
 * `createDesktopTransport` in dsh-client-connection; both ends validate the
 * same wire shapes.
 * @module @deepseek-ai/dsh-desktop/transport-install
 */

/** The installer script injected into every index response. */
export const DESKTOP_TRANSPORT_INSTALL_SCRIPT = String.raw`
(function () {
  'use strict'
  var bridge = window.desktopBridge
  if (!bridge) return
  function bytesToBase64(bytes) {
    var binary = ''
    var step = 0x8000
    for (var i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
    }
    return btoa(binary)
  }
  function base64ToBytes(body) {
    var binary = atob(body)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  function headersOf(init) {
    var out = {}
    var value = init && init.headers
    if (!value) return out
    if (typeof Headers !== 'undefined' && value instanceof Headers) {
      value.forEach(function (v, k) { out[k] = v })
    } else if (Array.isArray(value)) {
      value.forEach(function (pair) { out[pair[0]] = pair[1] })
    } else {
      for (var k in value) out[k] = value[k]
    }
    return out
  }
  function bodyOf(init) {
    var body = init && init.body
    if (body === undefined || body === null) return undefined
    if (typeof body === 'string') return bytesToBase64(new TextEncoder().encode(body))
    if (body instanceof URLSearchParams) return bytesToBase64(new TextEncoder().encode(body.toString()))
    if (body instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(body))
    if (ArrayBuffer.isView(body)) return bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
    throw new Error('desktop transport: unsupported fetch body type')
  }
  function desktopStream(endpoint, payload, signal) {
    return (async function* () {
      signal.throwIfAborted()
      var id = 'stream-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
      var item
      var wake
      var terminal = false
      var step = function (next) { item = next; if (wake) { var w = wake; wake = undefined; w() } }
      var offItem = bridge.onStreamItem(id, function (value) { step({ type: 'item', value: value }) })
      var offEnd = bridge.onItemEnd(id, function () { step({ type: 'end' }) })
      var offError = bridge.onStreamError(id, function (failure) { step({ type: 'error', failure: failure }) })
      var onAbort = function () { bridge.closeStream(id); step({ type: 'end' }) }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        bridge.openStream(id, endpoint, payload)
        for (;;) {
          if (!item) {
            await new Promise(function (resolve) { wake = resolve })
            signal.throwIfAborted()
          }
          var current = item
          item = undefined
          if (!current) continue
          if (current.type === 'item') {
            yield current.value
            continue
          }
          terminal = true
          if (current.type === 'error') {
            var failure = current.failure
            var error = new Error(failure.message)
            if (failure.kind === 'remote') {
              error.name = 'GatewayStreamError'
              error.code = failure.code
              error.details = failure.details
            } else {
              error.name = 'DesktopBridgeStreamError'
            }
            throw error
          }
          return
        }
      } finally {
        offItem()
        offEnd()
        offError()
        signal.removeEventListener('abort', onAbort)
        if (!terminal) bridge.closeStream(id)
      }
    })()
  }
  window.__DSH_TRANSPORT__ = {
    fetch: function (input, init) {
      return bridge.request({
        url: input.toString(),
        method: (init && init.method) || 'GET',
        headers: headersOf(init),
        body: bodyOf(init)
      }).then(function (settlement) {
        var responseInit = { status: settlement.status, headers: settlement.headers }
        if (settlement.streamId === undefined) {
          return new Response(settlement.body === '' ? new Uint8Array(0) : base64ToBytes(settlement.body), responseInit)
        }
        var streamId = settlement.streamId
        var body = new ReadableStream({
          start: function (controller) {
            bridge.onChunk(streamId, function (chunk) { controller.enqueue(base64ToBytes(chunk)) })
            bridge.onStreamEnd(streamId, function () { controller.close() })
          }
        })
        return new Response(body, responseInit)
      })
    },
    openStream: function (endpoint, payload, signal) {
      return desktopStream(endpoint, payload, signal)
    },
    ownsHost: true
  }
})()
`

/** Insert the installer as the first script in the document head. */
export function injectDesktopTransport(html: string): string {
  return html.replace(/<head[^>]*>/i, match => `${match}
<script>${DESKTOP_TRANSPORT_INSTALL_SCRIPT}</script>`)
}
