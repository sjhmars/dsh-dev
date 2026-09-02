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
import { join } from 'node:path'

const NAME = 'dsh-desktop'
const PROFILE = 'desktop'
/** Empty root entry list every profile tree patches over (the CLI's constant). */
const PROFILE_ROOT_CONFIG = '# dsh desktop profile root — an empty entry list; the tree is composed as patches.\n[]\n'

/**
 * Boot the desktop host composition in-process. Unpackaged runs keep the
 * agent-presets row's own shipped root (`@deepseek-ai/dsh-agent-presets`
 * resolves `../presets/` beside its lib), so only a packaged deployment
 * passes `presetRoot` (the extraResources copy).
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
  const profileDir = resolveProfileDir(PROFILE)
  if (!existsSync(join(profileDir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[PROFILE]
    initProfile(profileDir, template?.bundles ?? ['@deepseek-ai/dsh-base'], template?.patchReload)
  }
  const profile = loadProfile(NAME, PROFILE, installAnchor, undefined, { userLayer: true })
  // Reuse the CLI's root-rewrite contract: the Loader's tree write-back can
  // bake composed rows into this file, and a fresh empty root re-anchors it.
  const rootConfig = join(profile.dir, 'cordis.yml')
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG)
  // Heals the profile's module fallback from the bundles this profile
  // selected — it needs the loaded profile, so it runs after loadProfile
  // (the CLI's order).
  healProfilesModuleFallback({ installAnchor, profile })
  const patches: PatchOptions[] = [
    ...profile.layers.flatMap(layer => layer.patches),
    ...profile.patches,
    ...loadOptionalPatches(NAME, join(profile.dir, '..', PROFILE_PATCH_FILENAME)) ?? [],
  ]
  // A packaged deployment repoints the agent-presets row at the
  // extraResources copy; unpackaged runs keep the row's own shipped root, so
  // no overlay exists and a renamed row fails loud the same way the CLI's
  // does.
  const presetRoot = options.presetRoot
  if (presetRoot === undefined) {
    return boot(NAME, rootConfig, structuredClone(patches))
  }
  const rows = composeEntries([patches])
  const agentRow = rows.find(row => row.id === 'agent-presets')
  if (agentRow === undefined) {
    throw new Error('dsh-desktop: the composed tree has no agent-presets row to repoint at the packaged roster')
  }
  const overlays: PatchOptions[] = [{
    id: 'agent-presets',
    config: {
      ...agentRow.config as Record<string, unknown>,
      roots: [{ path: presetRoot, trust: 'system' }],
    },
  }]
  return boot(NAME, rootConfig, structuredClone([...patches, ...overlays]))
}
