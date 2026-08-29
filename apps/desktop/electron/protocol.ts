/**
 * Pure mapping from an app:// URL pathname to a served dist file — the
 * traversal-guarded SPA semantics frontend-static owns for the Web host,
 * reused by the desktop protocol handler. Also classifies the /plugins
 * bundle requests the browser shell loads via <script src> (which bypasses
 * fetch, so the bridge cannot carry them). Electron-free so tests run under
 * plain Node.
 * @module @deepseek-ai/dsh-desktop/protocol
 */

import { resolve, sep } from 'node:path'

/** One resolved app:// request target. */
export type DistResolution =
  /** The index document (boot-manifest injection applies). */
  | { kind: 'index' }
  /** One static asset inside the dist root. */
  | { kind: 'asset'; path: string }
  /** Malformed percent-encoding. */
  | { kind: 'bad' }
  /** The resolved target escapes the dist root. */
  | { kind: 'forbidden' }

/**
 * Resolve one decoded app:// pathname against the built dist root.
 * @param distRoot - absolute dist root (the distIndex's directory).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param pathname - the request URL pathname (still percent-encoded).
 * @returns the served target; the index covers `/` and every SPA fallback.
 */
export function resolveDistPath(distRoot: string, distIndex: string, pathname: string): DistResolution {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { kind: 'bad' }
  }
  if (decoded === '/' || decoded === '') return { kind: 'index' }
  const relative = decoded.replace(/^\/+/, '')
  const target = resolve(distRoot, relative)
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    return { kind: 'forbidden' }
  }
  if (target === distIndex) return { kind: 'index' }
  return { kind: 'asset', path: target }
}

/** One classified /plugins request target. */
export type PluginBundleResolution =
  /** A registered-entry bundle (or its source map); the id may contain a scope slash. */
  | { kind: 'bundle'; id: string; sourceMap: boolean }
  /** Anything else under /plugins (unknown ids, /plugins/events when the HMR row is absent). */
  | { kind: 'unknown' }

const PLUGIN_PREFIX = '/plugins/'
const PLUGIN_MAP_SUFFIX = '/client.js.map'
const PLUGIN_BUNDLE_SUFFIX = '/client.js'

/**
 * Classify one app:// pathname as a plugin-bundle request. Mirrors the Web
 * host's /plugins route parsing (same prefix/suffix vocabulary, same scoped
 * ids), so both carriers serve identical URLs.
 * @param pathname - the request URL pathname (still percent-encoded).
 * @returns the bundle id to read, or unknown.
 */
export function resolvePluginBundle(pathname: string): PluginBundleResolution {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { kind: 'unknown' }
  }
  if (!decoded.startsWith(PLUGIN_PREFIX)) return { kind: 'unknown' }
  const sourceMap = decoded.endsWith(PLUGIN_MAP_SUFFIX)
  const suffix = sourceMap ? PLUGIN_MAP_SUFFIX : PLUGIN_BUNDLE_SUFFIX
  if (!decoded.endsWith(suffix)) return { kind: 'unknown' }
  const id = decoded.slice(PLUGIN_PREFIX.length, -suffix.length)
  if (id === '') return { kind: 'unknown' }
  return { kind: 'bundle', id, sourceMap }
}
