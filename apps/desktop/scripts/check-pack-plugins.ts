/**
 * Composition and shipped-preset plugin names that the desktop production
 * graph must reach (dependencies + required peers of `@deepseek-ai/dsh-desktop`).
 * @module @deepseek-ai/dsh-desktop/check-pack-plugins
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './pack.ts'

/**
 * npm package name of a Cordis row specifier (`@scope/name/subpath` → `@scope/name`).
 * @param spec - patch `name:` value.
 * @returns the package name, or undefined for builtins such as `cordis:group`.
 */
export function packageRootOfRow(spec: string): string | undefined {
  if (spec.startsWith('cordis:')) return undefined
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec
  }
  return spec.split('/')[0]
}

function namesFrom(file: string): Set<string> {
  const text = readFileSync(file, 'utf8')
  const out = new Set<string>()
  for (const match of text.matchAll(/name:\s+['"]([^'"]+)['"]/g)) {
    const pkg = packageRootOfRow(match[1]!)
    if (pkg !== undefined) out.add(pkg)
  }
  return out
}

/**
 * Plugin packages the packed desktop host loads: bundle patches, shipped
 * agent-presets, and the Loader/runtime packages those files do not name.
 * @returns unique package names.
 */
export function requiredDesktopPackPlugins(): Set<string> {
  const required = new Set<string>([
    ...namesFrom(join(repoRoot, 'packages/bundle/base/cordis.patch.yml')),
    ...namesFrom(join(repoRoot, 'packages/bundle/web-app/cordis.patch.yml')),
    ...namesFrom(join(repoRoot, 'packages/bundle/desktop/cordis.patch.yml')),
  ])
  for (const preset of ['standard', 'code', 'minimal', 'cordis'] as const) {
    for (const name of namesFrom(join(repoRoot, 'apps/cli/config/agent-presets', preset, 'agent.cordis.yml'))) {
      required.add(name)
    }
  }
  for (const extra of [
    '@deepseek-ai/cordis',
    '@deepseek-ai/cordis-plugin-loader',
    '@deepseek-ai/cordis-plugin-include',
    '@deepseek-ai/cordis-plugin-group',
    '@deepseek-ai/cosmokit',
    '@sjhmars/plugin-install',
    'pnpm',
  ]) required.add(extra)
  return required
}

type Manifest = {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

function addDir(index: Map<string, Manifest>, dir: string): void {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  if (typeof pkg.name === 'string') index.set(pkg.name, pkg)
}

/**
 * Workspace + in-box plugin manifests pack can copy from.
 * @returns package name to manifest.
 */
function workspaceManifests(): Map<string, Manifest> {
  const index = new Map<string, Manifest>()
  for (const name of readdirSync(join(repoRoot, 'vendor'))) addDir(index, join(repoRoot, 'vendor', name))
  for (const group of readdirSync(join(repoRoot, 'packages'))) {
    const groupDir = join(repoRoot, 'packages', group)
    let entries: string[]
    try {
      entries = readdirSync(groupDir)
    } catch {
      continue
    }
    for (const name of entries) addDir(index, join(groupDir, name))
  }
  addDir(index, join(repoRoot, 'apps/desktop'))
  addDir(index, join(repoRoot, '..', 'dsh-plugin', 'plugins', 'plugin-install'))
  return index
}

function isOptionalPeer(pkg: Manifest, name: string): boolean {
  return pkg.peerDependenciesMeta?.[name]?.optional === true
}

/**
 * Production + required-peer closure of `@deepseek-ai/dsh-desktop`.
 * @returns reachable package names.
 */
export function desktopProductionGraph(): Set<string> {
  const index = workspaceManifests()
  const reachable = new Set<string>()
  const queue = ['@deepseek-ai/dsh-desktop']
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (reachable.has(next)) continue
    reachable.add(next)
    const pkg = index.get(next)
    if (pkg === undefined) continue
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const dep of Object.keys(pkg[field] ?? {})) {
        if (field === 'peerDependencies' && isOptionalPeer(pkg, dep)) continue
        if (!reachable.has(dep)) queue.push(dep)
      }
    }
  }
  return reachable
}

/** Packages the composition needs that the desktop production graph does not reach. */
export interface DesktopPackPluginGaps {
  /** Known workspace packages missing from the graph. */
  notInGraph: string[]
  /** Names with no package.json in vendor/packages/desktop/plugin-install. */
  unknown: string[]
}

/**
 * Compare {@link requiredDesktopPackPlugins} against {@link desktopProductionGraph}.
 * @returns sorted gaps; both arrays empty when the packed host can resolve every row.
 */
export function desktopPackPluginGaps(): DesktopPackPluginGaps {
  const index = workspaceManifests()
  const reachable = desktopProductionGraph()
  const missing = [...requiredDesktopPackPlugins()].filter(name => !reachable.has(name)).sort()
  return {
    notInGraph: missing.filter(name => index.has(name)),
    unknown: missing.filter(name => !index.has(name)),
  }
}

const invoked = process.argv[1] === undefined ? undefined : process.argv[1]
if (invoked !== undefined && invoked.replaceAll('\\', '/').endsWith('check-pack-plugins.ts')) {
  const gaps = desktopPackPluginGaps()
  for (const name of gaps.notInGraph) console.log(`not-in-graph ${name}`)
  for (const name of gaps.unknown) console.log(`unknown ${name}`)
  if (gaps.notInGraph.length > 0 || gaps.unknown.length > 0) process.exitCode = 1
}
