import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootDesktopHost } from '../electron/boot.ts'

let context: Context | undefined
let home: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-desktop-home-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (home !== undefined) delete process.env['DSH_HOME']
  home = undefined
})

describe('desktop composition smoke (keyless)', () => {
  it('boots base + web-app + desktop with no webserver and a live gateway/module face', { timeout: 120_000 }, async () => {
    const anchor = join(process.cwd(), 'apps/desktop/package.json')
    context = await bootDesktopHost(anchor)

    // The desktop carrier facts the Electron main depends on.
    const runtime = context.get('desktopRuntime') as { distIndex?: string } | undefined
    expect(runtime?.distIndex).toMatch(/index\.html$/)
    expect(context.get('clientModules')).toBeDefined()
    expect(context.get('connection')).toBeDefined()
    expect(context.get('typertGateway')).toBeDefined()
    // The whole point of the desktop patch: no HTTP listener.
    expect(context.get('webServer')).toBeUndefined()
    // The connection row stays enabled so its browser half (ctx.connection in
    // the renderer) remains in the boot graph; the HMR row (SSE-only) does not.
    const modules = context.get('clientModules') as { graph(): { entries: Array<{ id: string }> } }
    const graphIds = modules.graph().entries.map(entry => entry.id)
    expect(graphIds).toContain('@deepseek-ai/dsh-client-connection')
    expect(graphIds).toContain('@sjhmars/plugin-install')
    expect(graphIds).not.toContain('@deepseek-ai/dsh-client-hmr')
    expect(graphIds.length).toBeGreaterThan(10)
    // The desktop picker replaces the web profile's adaptive chooser (which
    // needs the webserver bind): the service exists and serves the native
    // Electron-dialog capability.
    const picker = context.get('directoryPicker') as { capability(): { kind: string } }
    expect(picker.capability().kind).toBe('native')
    // The boot adds the shipped preset root the way the CLI does: the roster
    // resolves through the dsh-agent-presets package and lists `standard`.
    const presets = context.get('agentPresets') as { list(): Promise<Array<{ id: string }>> }
    expect((await presets.list()).map(preset => preset.id)).toContain('standard')
  })
})
