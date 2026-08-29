/**
 * Host boot for the desktop app: the same profile machinery the dsh CLI
 * uses. The `desktop` profile (auto-initialized on first use, template from
 * dsh-app-boot) stacks base + web-app + desktop-app bundle layers; the
 * user's home patch layer applies on top exactly as it does for `dsh web`.
 * Electron-free so the composition smoke runs under plain Node.
 * @module @deepseek-ai/dsh-desktop/boot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  boot,
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  installFailLoud,
  loadEnv,
  loadOptionalPatches,
  loadProfile,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const NAME = 'dsh-desktop'
const PROFILE = 'desktop'
/** Empty root entry list every profile tree patches over (the CLI's constant). */
const PROFILE_ROOT_CONFIG = '# dsh desktop profile root — an empty entry list; the tree is composed as patches.\n[]\n'

/**
 * Shipped agent-preset root: the same directory the CLI deployment ships
 * (`apps/cli/config/agent-presets`). Unpackaged layout resolves it beside
 * this app (`../cli/config/agent-presets` from the install anchor). Packaged
 * Electron passes `process.resourcesPath/agent-presets` (extraResources).
 * @param installAnchor - the app's own package.json path.
 */
export function shippedPresetRoot(installAnchor: string): string {
  return join(dirname(installAnchor), '..', 'cli/config/agent-presets')
}

/**
 * Boot the desktop host composition in-process.
 * @param installAnchor - absolute path of the app's own package.json (the
 *   installation anchor bundle resolution and the module fallback heal from).
 * @param options - `presetRoot` overrides the shipped roster directory (packaged extraResources).
 * @returns the settled root context.
 */
export async function bootDesktopHost(
  installAnchor: string,
  options: { presetRoot?: string } = {},
): Promise<Context> {
  installFailLoud(NAME)
  loadEnv(NAME)
  healProfilesModuleFallback(installAnchor)
  const profileDir = resolveProfileDir(PROFILE)
  if (!existsSync(join(profileDir, 'package.json'))) {
    initProfile(profileDir, PROFILE_TEMPLATES[PROFILE] ?? ['@deepseek-ai/dsh-base'])
  }
  const profile = loadProfile(NAME, PROFILE, installAnchor, undefined, { userLayer: true })
  // Reuse the CLI's root-rewrite contract: the Loader's tree write-back can
  // bake composed rows into this file, and a fresh empty root re-anchors it.
  const rootConfig = join(profile.dir, 'cordis.yml')
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG)
  const patches: PatchOptions[] = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...loadOptionalPatches(NAME, join(profile.dir, '..', PROFILE_PATCH_FILENAME)) ?? [],
  ]
  // The shipped preset root is the deployment's own assembly fact, the same
  // overlay the CLI's composeProfile applies — the desktop app resolves the
  // same directory the CLI ships.
  const rows = composeEntries([patches])
  const agentRow = rows.find(row => row.id === 'agent-presets')
  const presetRoot = options.presetRoot ?? shippedPresetRoot(installAnchor)
  const overlays: PatchOptions[] = agentRow === undefined ? [] : [{
    id: 'agent-presets',
    config: {
      ...agentRow.config as Record<string, unknown>,
      roots: [{ path: presetRoot, trust: 'system' }],
    },
  }]
  return boot(NAME, rootConfig, structuredClone([...patches, ...overlays]))
}
