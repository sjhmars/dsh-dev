import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESKTOP_PACKAGE_NAME,
  desktopDir,
  electronBuilderArgs,
  electronBuilderCli,
  ensureStagedPackage,
  extraStagingCopies,
  fillMissingProductionDeps,
  pluginInstallCheckout,
  pnpmDeployArgs,
  repoRoot,
  rewriteWorkspaceProtocol,
  stampStagingPackageManager,
} from '../scripts/pack.ts'
import { desktopPackPluginGaps } from '../scripts/check-pack-plugins.ts'

describe('desktop pack staging', () => {
  it('deploys only the desktop package with the hoisted production flags', () => {
    const staging = join('C:\\', 'tmp', 'dsh-desktop-pack', 'app')
    expect(pnpmDeployArgs(staging)).toEqual([
      '--filter',
      DESKTOP_PACKAGE_NAME,
      'deploy',
      '--legacy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      staging,
    ])
  })

  it('points electron-builder at the staging tree and the app release directory', () => {
    const staging = join('C:\\', 'tmp', 'dsh-desktop-pack', 'app')
    const output = join(desktopDir, 'release')
    expect(electronBuilderArgs(staging, output, '37.10.3')).toEqual([
      '--projectDir',
      staging,
      `--config.directories.output=${output}`,
      '--config.electronVersion=37.10.3',
      '--publish',
      'never',
    ])
  })

  it('resolves the workspace electron-builder CLI for a direct node spawn', () => {
    expect(electronBuilderCli().replaceAll('\\', '/')).toMatch(/electron-builder\/cli\.js$/)
  })

  it('resolves the sibling dsh-plugin installer checkout', () => {
    expect(pluginInstallCheckout().replaceAll('\\', '/')).toMatch(/dsh-plugin\/plugins\/plugin-install$/)
  })

  it('copies the builder config, Windows icon, and CLI agent-presets that deploy omits', () => {
    const staging = join('C:\\', 'tmp', 'dsh-desktop-pack', 'app')
    expect(extraStagingCopies(staging)).toEqual([
      { from: join(desktopDir, 'electron-builder.yml'), to: join(staging, 'electron-builder.yml') },
      { from: join(desktopDir, 'build/icon.png'), to: join(staging, 'build/icon.png') },
      { from: join(repoRoot, 'apps/cli/config/agent-presets'), to: join(staging, 'agent-presets') },
    ])
  })

  it('stamps packageManager so electron-builder does not walk into a parent workspace', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-desktop-stamp-'))
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: DESKTOP_PACKAGE_NAME }, null, 2)}\n`)
    await stampStagingPackageManager(staging)
    const stamped = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')) as { packageManager?: string }
    expect(stamped.packageManager).toBe('pnpm@11.7.0')
    rmSync(staging, { recursive: true, force: true })
  })

  it('rewrites workspace protocol ranges to the staged package version', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-desktop-workspace-'))
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
      name: DESKTOP_PACKAGE_NAME,
      dependencies: { 'pack-fixture': 'workspace:^' },
    }, null, 2)}\n`)
    mkdirSync(join(staging, 'node_modules', 'pack-fixture'), { recursive: true })
    writeFileSync(join(staging, 'node_modules', 'pack-fixture', 'package.json'), `${JSON.stringify({
      name: 'pack-fixture',
      version: '9.8.7',
    }, null, 2)}\n`)
    await expect(rewriteWorkspaceProtocol(staging)).resolves.toBe(1)
    const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')) as { dependencies: { 'pack-fixture': string } }
    expect(pkg.dependencies['pack-fixture']).toBe('9.8.7')
    rmSync(staging, { recursive: true, force: true })
  })

  it('copies cosmokit from vendor when the staged tree omitted it', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-desktop-cosmokit-'))
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: DESKTOP_PACKAGE_NAME }, null, 2)}\n`)
    const version = await ensureStagedPackage(staging, '@deepseek-ai/cosmokit')
    expect(version.length).toBeGreaterThan(0)
    expect(existsSync(join(staging, 'node_modules', '@deepseek-ai', 'cosmokit', 'package.json'))).toBe(true)
    rmSync(staging, { recursive: true, force: true })
  })

  it('copies required peerDependencies that deploy --prod omits', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-desktop-peer-'))
    const dest = join(staging, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: DESKTOP_PACKAGE_NAME }, null, 2)}\n`)
    writeFileSync(join(dest, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-app-boot',
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
    }, null, 2))
    await expect(fillMissingProductionDeps(staging)).resolves.toBeGreaterThan(0)
    expect(existsSync(join(staging, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'))).toBe(true)
    rmSync(staging, { recursive: true, force: true })
  })

  it('copies production deps of a linked vendor package into the staging tree', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-desktop-schemastery-'))
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: DESKTOP_PACKAGE_NAME }, null, 2)}\n`)
    await ensureStagedPackage(staging, '@deepseek-ai/schemastery')
    expect(existsSync(join(staging, 'node_modules', '@standard-schema', 'spec', 'package.json'))).toBe(true)
    rmSync(staging, { recursive: true, force: true })
  })

  it('fills production deps left behind after copying a package without nested modules', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-desktop-fill-'))
    const dest = join(staging, 'node_modules', '@deepseek-ai', 'schemastery')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: DESKTOP_PACKAGE_NAME }, null, 2)}\n`)
    writeFileSync(join(dest, 'package.json'), readFileSync(join(repoRoot, 'vendor/schemastery/package.json'), 'utf8'))
    await expect(fillMissingProductionDeps(staging)).resolves.toBeGreaterThan(0)
    expect(existsSync(join(staging, 'node_modules', '@standard-schema', 'spec', 'package.json'))).toBe(true)
    rmSync(staging, { recursive: true, force: true })
  })

  it('drops optional workspace packages that deploy omitted', async () => {
    const staging = mkdtempSync(join(tmpdir(), 'dsh-desktop-optional-'))
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
      name: DESKTOP_PACKAGE_NAME,
      optionalDependencies: { 'missing-optional': 'workspace:*' },
    }, null, 2)}\n`)
    await expect(rewriteWorkspaceProtocol(staging)).resolves.toBe(0)
    const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')) as {
      optionalDependencies?: Record<string, string>
    }
    expect(pkg.optionalDependencies?.['missing-optional']).toBeUndefined()
    rmSync(staging, { recursive: true, force: true })
  })

  it('reaches every composition and shipped-preset plugin from the desktop production graph', () => {
    expect(desktopPackPluginGaps()).toEqual({ notInGraph: [], unknown: [] })
  })
})
