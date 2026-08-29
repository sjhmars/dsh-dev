# Agent Note: Desktop ships agent-presets extraResources and an in-box installer

Status: implemented

English | [中文](2026-08-28-desktop-presets-extraresources-plugin-install.zh.md)

## Problem

A packed desktop asar does not include `apps/cli`, so the boot overlay that pointed at `../cli/config/agent-presets` listed no shipped `standard` / `code` / `minimal` / `cordis` recipes on a clean machine. Out-of-tree plugins still needed `dsh plugin add`, which a Windows installer user does not have.

## Decision

Pack copies `apps/cli/config/agent-presets` into electron-builder `extraResources` (`agent-presets/`). Unpackaged boot keeps the CLI-neighbor path; packaged boot overlays `agent-presets.roots` to `join(process.resourcesPath, 'agent-presets')` with `trust: system`. `includeUserRoot` stays true, so `$DSH_HOME/.agent-presets` remains the user-authored roster. Shipped ids win on collision, matching `dsh web`.

`@sjhmars/plugin-install` is an out-of-tree package (Host Typert Remote + Settings tab, npm package name only, bundled `pnpm`). The untracked `dsh-desktop-app` patch inserts that row with `profile: desktop` and depends on the checkout via `file:`. Pack copies the built plugin (and its `pnpm` production dep) into the staging `node_modules` if deploy omitted it. The Settings tab and CLI match: desktop writes `desktop` (`dsh plugin --profile desktop add`); the browser still uses `dsh plugin --profile web add`. The two profiles do not share plugins.

## Alternatives considered

**Copy shipped presets into `$DSH_HOME/.agent-presets` on first launch.** That would make system recipes user-trust and editable, and a simultaneous system-root overlay would shadow the copies. Official web never seeds the user directory.

**Extract `dsh plugin add` into `dsh-app-boot` and spawn PATH `dsh`.** The installer package already has public profile APIs plus its own `pnpm`. Baking the UI into `dsh-web-app`'s patch would edit the official web bundle.

## Consequences

Packaged desktop can start a `standard` session without a prior `dsh web` home. The installer UI is always in the desktop composition; installing further plugins still requires restart. Packing requires a sibling `H:\dsh-plugin\plugins\plugin-install` checkout with `lib/` built.
