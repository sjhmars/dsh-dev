# Agent Note: 桌面把 agent-presets 打进 extraResources，并内置安装器

Status: implemented

[English](2026-08-28-desktop-presets-extraresources-plugin-install.md) | 中文

## Problem

打包后的 asar 不含 `apps/cli`，boot 若仍指向 `../cli/config/agent-presets`，干净机器列不出自带的 `standard` / `code` / `minimal` / `cordis`。树外插件仍要 `dsh plugin add`，安装包用户没有这条命令。

## Decision

打包把 `packages/preset/agent-presets/presets` 拷进 electron-builder `extraResources`（`agent-presets/`）。未打包 boot 仍用 agent-presets 行自身的包内根目录；打包后把 `agent-presets.roots` 覆盖为 `join(process.resourcesPath, 'agent-presets')`，`trust: system`。`includeUserRoot` 保持为 true，用户自己的预设仍在 `$DSH_HOME/.agent-presets`。同名时系统 id 优先，与 `dsh web` 一致。

`@sjhmars/plugin-install` 是树外包（Host Typert Remote + 设置页，只接受 npm 包名，自带 `pnpm`）。`dsh-desktop-app` 补丁插入该行并设 `profile: desktop`，其 bundle 把已发布的包固定为生产依赖。打包通过普通生产闭包暂存安装器及其 `pnpm` 依赖；[注册表依赖决策](../simplification/2026-09-04-desktop-installer-registry-dependency.zh.md)负责其来源与版本策略。设置页与 CLI 一样：桌面写入 `desktop`（`dsh plugin --profile desktop add`）；网页版仍用 `dsh plugin --profile web add`，两套 profile 互不相通。

## Alternatives considered

**首次启动把系统预设拷进 `$DSH_HOME/.agent-presets`。** 系统配方会变成 user 信任、可改；若同时 overlay 系统根，用户目录里的同名份会被盖住。官方 web 从不种进用户目录。

**把 `dsh plugin add` 抽进 `dsh-app-boot`，或 spawn PATH 上的 `dsh`。** 安装器已有公开 profile API 和自带 `pnpm`。写进 `dsh-web-app` 的 patch 会改官方 web 组合包。

## Consequences

打包桌面无需先跑过 `dsh web` 也能开 `standard` 会话。安装器 UI 始终在桌面组合里；再装其它插件仍需重启。打包通过 workspace 依赖安装解析固定版本的安装器，不要求相邻的插件仓库。
