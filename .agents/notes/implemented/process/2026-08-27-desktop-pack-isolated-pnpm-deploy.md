# Agent Note: Desktop pack stages an isolated pnpm deploy tree

Status: implemented

English | [中文](2026-08-27-desktop-pack-isolated-pnpm-deploy.zh.md)

## Problem

`desktop:pack` ran electron-builder against `apps/desktop` inside the pnpm workspace. electron-builder 26's pnpm collector executes `pnpm list --prod --json --depth Infinity` from that directory. pnpm 11 emits every workspace package's production tree, and on Windows that walk exhausts file handles (`EMFILE`, unsigned exit `4294963230`). The native `node-pty` rebuild for Electron can succeed and packaging still dies before the asar is assembled. The [desktop-client architecture note](../architecture/2026-08-14-desktop-client-over-sdk.md) still owns in-process host boot; it does not own this collector isolation. Peer filling and `asar: false` live in [packed peers](../bug-fix/2026-08-28-desktop-pack-esm-peers-outside-asar.md).

## Decision

`apps/desktop/scripts/pack.ts` is the pack driver. After the existing main and web builds, it `pnpm deploy --filter @deepseek-ai/dsh-desktop` into a temporary directory under `os.tmpdir()` using the same legacy-hoisted production flags as the Python SDK runtime deploy (`--legacy --prod --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true`). The staging tree is outside the workspace, so electron-builder's collector lists only that closure.

Deploy honors package.json `files` (`lib/` only). The script copies `electron-builder.yml` and `build/icon.png`, stamps `packageManager` on the staged manifest so electron-builder does not walk into a parent workspace, replaces package symlinks with real directories, rewrites leftover `workspace:` ranges to the staged package version (copying a missing required workspace package from vendor, packages, or native/landlock-run when `link:` overrides omitted it; dropping optional workspace packages that deploy skipped, such as Linux Landlock addons on Windows), copies production dependencies and required peers those copies left behind (`@deepseek-ai/cordis`, schemastery needs `@standard-schema/spec`), and invokes the workspace `electron-builder` CLI with `node` (not `pnpm exec`) with `--projectDir` pointing at staging, `directories.output` pointing at `apps/desktop/release`, and `electronVersion` read from the workspace `electron` install. Native rebuild still runs inside that tree. The staging directory is deleted after electron-builder exits.

## Alternatives considered

**Patch app-builder-lib `getArgs()` to add `--filter @deepseek-ai/dsh-desktop`.** A one-line collector change still runs `pnpm list` against the workspace checkout. pnpm 11 can still emit a huge JSON from a member directory, and the patch would have to track electron-builder upgrades.

**`beforeBuild` returning false.** That flag skips both the collector and native rebuild. Skipping rebuild would ship a Node-ABI `node-pty` into Electron.

**Raise the Windows handle limit or close other processes.** The workspace `pnpm list` is unbounded in the number of packages; closing Cursor is not a pack contract.

**Hoist the workspace with `nodeLinker: hoisted`.** That would change every install in the repository for one Windows pack path, and pnpm 11 still listed the whole workspace under that layout in reported electron-builder failures.

## Consequences

Windows `desktop:pack` no longer depends on listing the full workspace production graph. Pack now needs a successful `pnpm deploy` of the desktop production closure (workspace `lib/` artifacts must already exist, as they did when electron-builder copied from the checkout). The throwaway deploy is not the Python SDK `python/sdk-runtime` deploy-root; that closure remains a separate distribution. electron-builder's output is the production composition under `resources/app`.
