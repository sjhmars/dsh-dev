/** The external-gateway bundle declares a static, isolated loopback patch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

interface PatchRow {
  id?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: PatchRow[]
  group?: boolean
  isolate?: Record<string, boolean | string>
  name?: string
}

function fixture(): { manifest: Record<string, unknown>; patches: PatchRow[] } {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>
  const dsh = manifest.dsh as { bundle?: { patch?: string } } | undefined
  if (dsh?.bundle?.patch === undefined) throw new Error('bundle patch is missing')
  const patches = yaml.load(readFileSync(resolve(root, dsh.bundle.patch), 'utf8'), {
    schema: entryListSchema,
  })
  if (!Array.isArray(patches)) throw new TypeError('bundle patch must be a list')
  return { manifest, patches: patches as PatchRow[] }
}

function rows(patches: PatchRow[]): PatchRow[] {
  return patches.flatMap(patch => patch.insert ?? [])
}

describe('dsh-external-gateway-app bundle', () => {
  it('declares the patch and its runtime package dependencies', () => {
    const { manifest } = fixture()
    expect(manifest.dsh).toEqual({ bundle: { patch: './cordis.patch.yml' } })
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-external-gateway': 'workspace:^',
      '@deepseek-ai/dsh-host-webserver': 'workspace:^',
      '@deepseek-ai/dsh-storage-sqlite': 'workspace:^',
    })
  })

  it('removes the Web transport and browser roster while keeping Host rows available', () => {
    const { patches } = fixture()
    const disabled = new Set(patches.filter(patch => patch.disabled).map(patch => patch.id))
    expect(disabled).toEqual(new Set([
      'webserver', 'web-startup', 'web-runtime', 'client-hmr', 'modules',
      'connection', 'api-remotes', 'cordis-client-runner', 'session-log-download',
      'directory-picker', 'ui-theme', 'locale', 'ui-layout', 'ui-renderer',
      'ui-session', 'ui-sidebar', 'ui-settings', 'ui-settings-general',
      'ui-settings-models', 'ui-settings-plugin-inventory', 'ui-conversation',
      'ui-approval', 'ui-chat', 'ui-brand-official', 'ui-attachment', 'ui-tool',
      'ui-cordis', 'ui-workflow-run', 'ui-deliverables', 'ui-workspace',
      'ui-input-trigger', 'ui-commands', 'ui-skill', 'ui-subagent', 'ui-reference',
      'ui-jobs', 'ui-goal', 'ui-message-feedback', 'ui-model-selection',
      'ui-permission', 'ui-agent-preset', 'ui-settings-plugins', 'ui-plan',
      'ui-user-questions', 'ui-trajectory',
    ]))
    expect(patches.find(patch => patch.id === 'session-controller')).toBeUndefined()
    expect(rows(patches).some(row => row.id === 'session-controller')).toBe(false)
  })

  it('routes only external_gateway through SQLite and isolates its listener', () => {
    const { patches } = fixture()
    const storage = patches.find(patch => patch.id === 'storage-domain')
    expect(storage?.config).toEqual({ backend: 'json', routes: { external_gateway: 'sqlite' } })
    const inserted = rows(patches)
    expect(inserted.find(row => row.id === 'storage-sqlite')).toMatchObject({
      name: '@deepseek-ai/dsh-storage-sqlite',
      config: { path: { __jsExpr: "dshHomePath('storages', 'external-gateway.sqlite')" } },
    })
    expect(inserted).toContainEqual(expect.objectContaining({
      id: 'external-gateway-webserver',
      name: '@deepseek-ai/dsh-host-webserver',
      isolate: { webServer: 'external-gateway' },
      config: expect.objectContaining({ host: '127.0.0.1', port: 18765 }),
    }))
    expect(inserted).toContainEqual(expect.objectContaining({
      id: 'external-gateway',
      name: '@deepseek-ai/dsh-external-gateway',
      isolate: { webServer: 'external-gateway' },
    }))
  })
})
