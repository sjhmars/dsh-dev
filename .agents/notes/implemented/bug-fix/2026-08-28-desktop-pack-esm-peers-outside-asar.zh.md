# Agent Note: 打包桌面把 Cordis peer 打到真实文件系统上

Status: implemented

[English](2026-08-28-desktop-pack-esm-peers-outside-asar.md) | 中文

## Problem

打包后的桌面 exe 启动即崩溃：`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis'`，导入方是 `%TEMP%` 下的 `index.js`。Cordis Loader 把每个插件当独立 ESM 文件导入。`pnpm deploy --prod --config.auto-install-peers=false` 不会带上 `@deepseek-ai/cordis` 以及 `dsh-app-boot` 的其它必选 peer（`cordis-plugin-loader`、`include`、`group`）：它们是 peer，不是 `@deepseek-ai/dsh-desktop` 的生产依赖。tsdown 把这些包装进 `lib/electron/main.js`，主进程能起来，随后第一个插件 `import '@deepseek-ai/cordis'` 失败。electron-builder 的 asar 会让 Electron 把该插件文件拷到 `%TEMP%` 再执行 ESM，Node 的包查找走不到 `resources/app/node_modules`。Windows 上 profile 回退是目录 junction，不能指向 asar 路径。portable 目标每次启动把整个应用解到 `%TEMP%\<id>\`，崩溃对话框里就是这条路径。

## Decision

`@deepseek-ai/dsh-desktop` 把 `@deepseek-ai/cordis` 列为生产依赖，并带上官方 CLI bin 有、而 `dsh-base` / `dsh-web-app` 没有的 shipped 预设包（`dsh-persona`、`dsh-tool-ask-user`、`dsh-terminal`、`dsh-tool-cordis` 以及持久 shell 工具）。打包脚本的 `fillMissingProductionDeps` 同时遍历 `peerDependencies`（可选 peer 的跳过规则与 `optionalDependencies` 相同），这样 `cordis-plugin-loader` 等必选 workspace peer 会进 hoisted staging 树。`electron-builder.yml` 设 `asar: false`，插件文件与 `node_modules/@deepseek-ai/cordis` 同在真实目录上，`$DSH_HOME/profiles/node_modules` 下的 `healProfilesModuleFallback` junction 才能指向它们。`apps/desktop/tests/pack.spec.ts` 断言每条 bundle 补丁与 shipped 预设包名都在该生产图里。

## Alternatives considered

**asarUnpack `node_modules/**`，`lib/` 仍进 asar。** 解开模块足够让 Node 查找，但 Windows junction 仍不能指向 asar 覆盖路径上的 `app.asar/package.json`。关掉 asar 让安装锚与每个包目录落在同一棵真实树上。

**把 peer 交给 `pnpm deploy --config.auto-install-peers=true`。** 会装上桌面组合已经 disable 的可选 peer（HMR），且 asar 的 ESM 解压问题仍在。

## Consequences

此前用 asar、且未打进 cordis 的 `0.1.1-rc.1` 产物无法启动。本改动后需要重新打包。[deploy 隔离说明](../process/2026-08-27-desktop-pack-isolated-pnpm-deploy.zh.md) 仍拥有一次性 `pnpm deploy`；本说明拥有 peer 遍历与 `asar: false`。
