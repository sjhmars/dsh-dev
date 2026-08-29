# Agent Note: 桌面把 agent-presets 打进 extraResources，并内置安装器

Status: implemented

[English](2026-08-28-desktop-presets-extraresources-plugin-install.md) | 中文

## Problem

打包后的 asar 不含 `apps/cli`，boot 若仍指向 `../cli/config/agent-presets`，干净机器列不出自带的 `standard` / `code` / `minimal` / `cordis`。树外插件仍要 `dsh plugin add`，安装包用户没有这条命令。

## Decision

打包把 `apps/cli/config/agent-presets` 拷进 electron-builder `extraResources`（`agent-presets/`）。未打包 boot 仍用 CLI 邻居路径；打包后把 `agent-presets.roots` 覆盖为 `join(process.resourcesPath, 'agent-presets')`，`trust: system`。`includeUserRoot` 保持为 true，用户自己的预设仍在 `$DSH_HOME/.agent-presets`。同名时系统 id 优先，与 `dsh web` 一致。

`@sjhmars/plugin-install` 是树外包（Host Typert Remote + 设置页，只接受 npm 包名，自带 `pnpm`）。未跟踪的 `dsh-desktop-app` 补丁插入该行并设 `profile: desktop`，以 `file:` 依赖检出。打包时若 deploy 漏了，再把已构建插件（及其 `pnpm` 生产依赖）拷进 staging `node_modules`。设置页与 CLI 一样：桌面写入 `desktop`（`dsh plugin --profile desktop add`）；网页版仍用 `dsh plugin --profile web add`，两套 profile 互不相通。

## Alternatives considered

**首次启动把系统预设拷进 `$DSH_HOME/.agent-presets`。** 系统配方会变成 user 信任、可改；若同时 overlay 系统根，用户目录里的同名份会被盖住。官方 web 从不种进用户目录。

**把 `dsh plugin add` 抽进 `dsh-app-boot`，或 spawn PATH 上的 `dsh`。** 安装器已有公开 profile API 和自带 `pnpm`。写进 `dsh-web-app` 的 patch 会改官方 web 组合包。

## Consequences

打包桌面无需先跑过 `dsh web` 也能开 `standard` 会话。安装器 UI 始终在桌面组合里；再装其它插件仍需重启。打包要求旁边有已构建 `lib/` 的 `H:\dsh-plugin\plugins\plugin-install` 检出。
