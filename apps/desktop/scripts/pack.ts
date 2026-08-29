/**
 * Stage `@deepseek-ai/dsh-desktop` with `pnpm deploy` outside the workspace,
 * then run electron-builder against that tree. electron-builder's pnpm
 * collector would otherwise `pnpm list --depth Infinity` the whole workspace
 * and exhaust Windows file handles.
 * @module @deepseek-ai/dsh-desktop/pack
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Workspace package electron-builder packs. */
export const DESKTOP_PACKAGE_NAME = '@deepseek-ai/dsh-desktop'

/** Directory of this app's package.json. */
export const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Repository root (workspace that `pnpm deploy --filter` must run from). */
export const repoRoot = resolve(desktopDir, '../..')

/**
 * Package-manager binary name. Windows resolves `pnpm.cmd` via `PATHEXT`
 * when spawn uses `shell: true`.
 * @returns the executable to spawn.
 */
export function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/**
 * `pnpm deploy` argv that materializes a hoisted production closure.
 * Flags match the Python SDK runtime deploy: legacy hoister, no peer auto-install,
 * workspace packages injected as files.
 * @param staging - empty directory that becomes the deploy target.
 * @returns argv after the pnpm binary.
 */
export function pnpmDeployArgs(staging: string): string[] {
  return [
    '--filter',
    DESKTOP_PACKAGE_NAME,
    'deploy',
    '--legacy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    staging,
  ]
}

/**
 * electron-builder argv: pack the staged tree, write installers back into
 * this app's `release/` directory, and pin the Electron version from the
 * workspace install (the staged production tree has no `electron` package).
 * @param staging - deploy target that contains package.json, lib/, node_modules.
 * @param output - absolute `directories.output` for the NSIS/portable artifacts.
 * @param electronVersion - Electron version whose headers native rebuild uses.
 * @returns argv after `electron-builder`.
 */
export function electronBuilderArgs(staging: string, output: string, electronVersion: string): string[] {
  return [
    '--projectDir',
    staging,
    `--config.directories.output=${output}`,
    `--config.electronVersion=${electronVersion}`,
    '--publish',
    'never',
  ]
}

/**
 * Files copied into the deploy tree after `pnpm deploy`. Deploy honors
 * package.json `files` (`lib/` only), so the builder config, Windows icon,
 * and CLI agent-presets directory are not in that payload.
 * @param staging - deploy target.
 * @returns absolute source/destination pairs.
 */
export function extraStagingCopies(staging: string): Array<{ from: string, to: string }> {
  return [
    { from: join(desktopDir, 'electron-builder.yml'), to: join(staging, 'electron-builder.yml') },
    { from: join(desktopDir, 'build/icon.png'), to: join(staging, 'build/icon.png') },
    { from: join(repoRoot, 'apps/cli/config/agent-presets'), to: join(staging, 'agent-presets') },
  ]
}

/**
 * Out-of-workspace plugin the desktop bundle ships in-box.
 * @returns the plugin checkout directory next to this repository.
 */
export function pluginInstallCheckout(): string {
  return join(repoRoot, '..', 'dsh-plugin', 'plugins', 'plugin-install')
}

/**
 * Electron version the workspace already installed for this app.
 * @returns the `electron` package version string.
 */
export function installedElectronVersion(): string {
  const require = createRequire(import.meta.url)
  return (require('electron/package.json') as { version: string }).version
}

/**
 * Absolute path of the workspace-installed electron-builder CLI.
 * Pack invokes this with `node` so it does not run `pnpm exec` after
 * `pnpm deploy --prod`.
 * @returns the CLI module path.
 */
export function electronBuilderCli(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('electron-builder/cli.js')
}

/**
 * Run a subprocess with inherited stdio; reject on non-zero exit.
 * @param label - short name for the error prefix.
 * @param command - executable.
 * @param args - argv.
 * @param cwd - working directory.
 */
async function run(label: string, command: string, args: string[], cwd: string): Promise<void> {
  const printable = [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
  console.log(`dsh-desktop pack: ${label}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.once('error', error => {
      reject(new Error(`dsh-desktop pack: ${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`dsh-desktop pack: ${label} failed (${cause}): ${printable}`))
    })
  })
}

/**
 * Stamp `packageManager` so electron-builder treats the staging directory as
 * its own project root and does not walk into a parent workspace.
 * @param staging - deploy target that already has package.json.
 */
export async function stampStagingPackageManager(staging: string): Promise<void> {
  const pkgPath = join(staging, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>
  pkg.packageManager = 'pnpm@11.7.0'
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

/**
 * Whether `name` is an optional peer of `pkg` (`peerDependenciesMeta`).
 * @param pkg - parsed package.json.
 * @param name - dependency name.
 * @returns true when the peer is marked optional.
 */
function isOptionalPeer(pkg: Record<string, unknown>, name: string): boolean {
  const meta = pkg.peerDependenciesMeta
  if (meta === undefined || typeof meta !== 'object' || meta === null) return false
  const entry = (meta as Record<string, unknown>)[name]
  if (entry === undefined || typeof entry !== 'object' || entry === null) return false
  return (entry as { optional?: unknown }).optional === true
}

/**
 * Skip optional or optional-peer names that deploy omitted.
 * @param field - the manifest field being walked.
 * @param pkg - parsed package.json.
 * @param name - dependency name.
 * @returns true when a missing package must not fail the pack.
 */
function skipIfUnresolved(field: typeof DEPENDENCY_FIELDS[number], pkg: Record<string, unknown>, name: string): boolean {
  return field === 'optionalDependencies' || (field === 'peerDependencies' && isOptionalPeer(pkg, name))
}

function stagedPackageDir(staging: string, name: string): string {
  return join(staging, 'node_modules', ...name.split('/'))
}

async function copyPackageWithoutNestedModules(sourceDir: string, dest: string): Promise<void> {
  const nested = join(sourceDir, 'node_modules')
  await mkdir(dirname(dest), { recursive: true })
  await cp(sourceDir, dest, {
    recursive: true,
    dereference: true,
    filter: path => path !== nested && !path.startsWith(nested + sep),
  })
}

/**
 * Walk `fromDir` toward `stopAt` looking for an installed package directory.
 * @param fromDir - directory whose node_modules is searched first.
 * @param name - package name, including scope.
 * @param stopAt - last directory whose node_modules is searched.
 * @returns the package directory, or undefined.
 */
function resolveInstalledPackageDir(fromDir: string, name: string, stopAt: string): string | undefined {
  const parts = name.split('/')
  let current = fromDir
  const stop = resolve(stopAt)
  for (;;) {
    const candidate = join(current, 'node_modules', ...parts)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (resolve(current) === stop) return undefined
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function isPathInside(dir: string, root: string): boolean {
  const resolvedDir = resolve(dir).toLowerCase()
  const resolvedRoot = resolve(root).toLowerCase()
  return resolvedDir === resolvedRoot || resolvedDir.startsWith(resolvedRoot + sep.toLowerCase())
}

let workspacePackageDirs: Map<string, string> | undefined

/**
 * Index vendored, packages-group, and native-launcher manifests so workspace
 * protocol names resolve even when pnpm link overrides leave them out of root
 * node_modules.
 * @returns package name to directory.
 */
async function workspacePackageIndex(): Promise<Map<string, string>> {
  if (workspacePackageDirs !== undefined) return workspacePackageDirs
  const map = new Map<string, string>()
  const add = async (dir: string): Promise<void> => {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) return
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { name?: string }
    if (typeof pkg.name === 'string') map.set(pkg.name, dir)
  }
  for (const name of await readdir(join(repoRoot, 'vendor'))) {
    await add(join(repoRoot, 'vendor', name))
  }
  for (const group of await readdir(join(repoRoot, 'packages'))) {
    const groupDir = join(repoRoot, 'packages', group)
    let entries
    try {
      entries = await readdir(groupDir)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOTDIR') continue
      throw error
    }
    for (const name of entries) await add(join(groupDir, name))
  }
  const nativeRoot = join(repoRoot, 'native', 'landlock-run')
  await add(nativeRoot)
  const nativePackages = join(nativeRoot, 'packages')
  if (existsSync(nativePackages)) {
    for (const name of await readdir(nativePackages)) {
      await add(join(nativePackages, name))
    }
  }
  workspacePackageDirs = map
  return map
}

async function stageResolvedPackage(staging: string, name: string, sourceDir: string): Promise<void> {
  const dest = stagedPackageDir(staging, name)
  if (existsSync(join(dest, 'package.json'))) return
  await copyPackageWithoutNestedModules(sourceDir, dest)
  await materializeProductionDeps(
    staging,
    dest,
    sourceDir,
    isPathInside(sourceDir, repoRoot) ? repoRoot : staging,
  )
}

/**
 * Copy missing production dependencies of one staged package into the hoisted
 * staging node_modules, resolving them from the source install then the repo.
 * @param staging - deploy target.
 * @param dest - staged package directory.
 * @param sourceDir - directory to start Node-style resolution from.
 * @param stopAt - last directory whose node_modules is searched from sourceDir.
 * @returns how many packages were newly copied.
 */
async function materializeProductionDeps(
  staging: string,
  dest: string,
  sourceDir: string,
  stopAt: string,
): Promise<number> {
  const destPkg = join(dest, 'package.json')
  if (!existsSync(destPkg)) return 0
  const pkg = JSON.parse(await readFile(destPkg, 'utf8')) as { name?: string } & Record<string, unknown>
  let filled = 0
  for (const field of DEPENDENCY_FIELDS) {
    const deps = pkg[field]
    if (deps === undefined || typeof deps !== 'object' || deps === null) continue
    const record = deps as Record<string, string>
    for (const [name, version] of Object.entries(record)) {
      if (existsSync(join(stagedPackageDir(staging, name), 'package.json'))) continue
      if (version.startsWith('workspace:')) {
        if (skipIfUnresolved(field, pkg, name)) continue
        await ensureStagedPackage(staging, name)
        filled++
        continue
      }
      const resolved =
        resolveInstalledPackageDir(sourceDir, name, stopAt)
        ?? resolveInstalledPackageDir(repoRoot, name, repoRoot)
        ?? resolveInstalledPackageDir(staging, name, staging)
      if (resolved === undefined) {
        if (skipIfUnresolved(field, pkg, name)) continue
        throw new Error(
          `dsh-desktop pack: cannot resolve production dependency ${name} of ${pkg.name ?? dest}`,
        )
      }
      await stageResolvedPackage(staging, name, resolved)
      filled++
    }
  }
  return filled
}

/**
 * Copy a workspace package into the staging node_modules when deploy omitted
 * it (typical for pnpm link overrides such as cosmokit). Nested node_modules
 * stay behind so the hoisted tree keeps one copy of each package.
 * @param staging - deploy target.
 * @param name - package name, including scope.
 * @returns the copied or already-present package version.
 */
export async function ensureStagedPackage(staging: string, name: string): Promise<string> {
  const dest = stagedPackageDir(staging, name)
  const destPkg = join(dest, 'package.json')
  if (existsSync(destPkg)) {
    return (JSON.parse(await readFile(destPkg, 'utf8')) as { version: string }).version
  }
  const sourceDir = (await workspacePackageIndex()).get(name)
  if (sourceDir === undefined) {
    throw new Error(`dsh-desktop pack: cannot resolve ${name} from vendor, packages, or native`)
  }
  await copyPackageWithoutNestedModules(sourceDir, dest)
  await materializeProductionDeps(staging, dest, sourceDir, repoRoot)
  return (JSON.parse(await readFile(destPkg, 'utf8')) as { version: string }).version
}

/**
 * Copy production and required peer packages that symlink materialization left
 * behind because it skips nested node_modules. electron-builder's traversal
 * collector requires every production dependency directory to exist; Cordis
 * Loader also needs required peers such as `@deepseek-ai/cordis` on disk.
 * @param staging - deploy target.
 * @returns how many packages were newly copied.
 */
export async function fillMissingProductionDeps(staging: string): Promise<number> {
  const pkgFiles = [join(staging, 'package.json')]
  await collectPackageJsonFiles(join(staging, 'node_modules'), pkgFiles)
  let filled = 0
  for (const pkgPath of pkgFiles) {
    if (!existsSync(pkgPath)) continue
    const dir = dirname(pkgPath)
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { name?: string }
    const indexed = typeof pkg.name === 'string' ? (await workspacePackageIndex()).get(pkg.name) : undefined
    const fromDir = indexed ?? dir
    const stopAt = indexed === undefined ? staging : repoRoot
    filled += await materializeProductionDeps(staging, dir, fromDir, stopAt)
  }
  return filled
}

async function collectPackageJsonFiles(directory: string, into: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return
    throw error
  }
  for (const entry of entries) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await collectPackageJsonFiles(path, into)
      continue
    }
    if (entry.isFile() && entry.name === 'package.json') into.push(path)
  }
}

/**
 * Replace leftover workspace-protocol ranges with the staged package version
 * and copy any required workspace package electron-builder's traversal collector
 * cannot find. Optional workspace packages that deploy omitted (platform
 * addons such as Landlock on Windows) are dropped so the collector does not
 * look for them.
 * @param staging - deploy target.
 * @returns how many dependency entries were rewritten to a concrete version.
 */
export async function rewriteWorkspaceProtocol(staging: string): Promise<number> {
  const pkgFiles = [join(staging, 'package.json')]
  await collectPackageJsonFiles(join(staging, 'node_modules'), pkgFiles)
  let rewritten = 0
  for (const pkgPath of pkgFiles) {
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>
    let changed = false
    for (const field of DEPENDENCY_FIELDS) {
      const deps = pkg[field]
      if (deps === undefined || typeof deps !== 'object' || deps === null) continue
      const record = deps as Record<string, string>
      for (const [name, version] of Object.entries(record)) {
        if (!version.startsWith('workspace:')) continue
        const destPkg = join(stagedPackageDir(staging, name), 'package.json')
        if (field === 'optionalDependencies' && !existsSync(destPkg)) {
          delete record[name]
          changed = true
          continue
        }
        record[name] = await ensureStagedPackage(staging, name)
        changed = true
        rewritten++
      }
    }
    if (changed) await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  return rewritten
}

async function findSymlink(directory: string): Promise<string | undefined> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return undefined
    throw error
  }
  for (const entry of entries) {
    if (entry.name === '.pnpm' || entry.name === '.bin') continue
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Replace package symlinks with real directories so electron-builder's
 * traversal collector and the packed app tree do not depend on the workspace.
 * `.bin` shims are deleted; Electron does not launch those bins.
 * @param staging - deploy target.
 */
export async function materializeStagedLinks(staging: string): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const source = await realpath(remaining)
    const nestedNodeModules = join(source, 'node_modules')
    await rm(remaining, { recursive: true, force: true })
    await cp(source, remaining, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/**
 * Deploy the production closure, copy builder assets, run electron-builder,
 * then delete the staging directory. Installers land in `apps/desktop/release`.
 */
export async function packDesktop(): Promise<void> {
  const stagingParent = await mkdtemp(join(tmpdir(), 'dsh-desktop-pack-'))
  const staging = join(stagingParent, 'app')
  const output = join(desktopDir, 'release')
  const electronVersion = installedElectronVersion()
  try {
    await run('deploy', pnpmBin(), pnpmDeployArgs(staging), repoRoot)
    await mkdir(join(staging, 'build'), { recursive: true })
    for (const copy of extraStagingCopies(staging)) {
      await cp(copy.from, copy.to, { recursive: true })
    }
    await stampStagingPackageManager(staging)
    await materializeStagedLinks(staging)
    const rewritten = await rewriteWorkspaceProtocol(staging)
    console.log(`dsh-desktop pack: rewrote ${rewritten} workspace: dependency entries`)
    const pluginSource = pluginInstallCheckout()
    if (!existsSync(join(pluginSource, 'package.json'))) {
      throw new Error(`dsh-desktop pack: missing in-box plugin at ${pluginSource}`)
    }
    await stageResolvedPackage(staging, '@sjhmars/plugin-install', pluginSource)
    const filled = await fillMissingProductionDeps(staging)
    console.log(`dsh-desktop pack: filled ${filled} missing production packages`)
    await run(
      'electron-builder',
      process.execPath,
      [electronBuilderCli(), ...electronBuilderArgs(staging, output, electronVersion)],
      staging,
    )
  } finally {
    await rm(stagingParent, { recursive: true, force: true })
  }
}

const thisFile = fileURLToPath(import.meta.url)
const invoked = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invoked !== undefined && invoked.toLowerCase() === thisFile.toLowerCase()) {
  packDesktop().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
