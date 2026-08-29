# Agent Note: 桌面打包在隔离的 pnpm deploy 树中进行

Status: implemented

[English](2026-08-27-desktop-pack-isolated-pnpm-deploy.md) | 中文

## 问题

`desktop:pack` 会在 pnpm workspace 内对 `apps/desktop` 运行 electron-builder。electron-builder 26 的 pnpm collector 会在该目录执行 `pnpm list --prod --json --depth Infinity`。pnpm 11 会输出每个 workspace 包的生产依赖树；在 Windows 上这次遍历会耗尽文件句柄（`EMFILE`，无符号退出码 `4294963230`）。面向 Electron 的 `node-pty` 原生重编译可以成功，打包仍会在组装输出之前失败。[桌面客户端架构说明](../architecture/2026-08-14-desktop-client-over-sdk.zh.md) 仍然拥有进程内宿主 boot；它不拥有这次 collector 隔离。Peer 补齐与 `asar: false` 见 [打包 peer](../bug-fix/2026-08-28-desktop-pack-esm-peers-outside-asar.zh.md)。

## 决策

`apps/desktop/scripts/pack.ts` 是打包驱动。在现有的主进程与 web 构建之后，它使用与 Python SDK 运行时 deploy 相同的 legacy-hoisted 生产标志（`--legacy --prod --config.node-linker=hoisted --config.auto-install-peers=false --config.link-workspace-packages=true`），把 `pnpm deploy --filter @deepseek-ai/dsh-desktop` 放到 `os.tmpdir()` 下的临时目录。该 staging 树位于 workspace 之外，因此 electron-builder 的 collector 只列出这份闭包。

deploy 遵守 package.json 的 `files`（仅 `lib/`）。脚本复制 `electron-builder.yml` 与 `build/icon.png`，在 staged manifest 上盖上 `packageManager`，使 electron-builder 不会向上走进父级 workspace，把包的符号链接替换成真实目录，把残留的 `workspace:` 范围改写成 staged 包版本（当 `link:` override 漏掉某个必需的 workspace 包时，再从 vendor、packages 或 native/landlock-run 拷入；deploy 跳过的可选 workspace 包则删除，例如 Windows 上的 Linux Landlock 插件），补齐这些拷贝漏掉的生产依赖与必选 peer（`@deepseek-ai/cordis`，schemastery 需要 `@standard-schema/spec`），并以 `node` 直接调用 workspace 里的 `electron-builder` CLI（不用 `pnpm exec`），`--projectDir` 指向 staging、`directories.output` 指向 `apps/desktop/release`、`electronVersion` 取自 workspace 已安装的 `electron`。原生重编译仍在该树内运行。electron-builder 退出后删除 staging 目录。

## 考虑过的替代方案

**给 app-builder-lib 的 `getArgs()` 打补丁，加上 `--filter @deepseek-ai/dsh-desktop`。** collector 的这一行改动仍然对着 workspace 检出运行 `pnpm list`。pnpm 11 仍可能从成员目录吐出巨大 JSON，而且这块补丁必须跟着 electron-builder 升级走。

**让 `beforeBuild` 返回 false。** 该标志会同时跳过 collector 与原生重编译。跳过重编译会把 Node ABI 的 `node-pty` 打进 Electron。

**提高 Windows 句柄上限或关掉其他进程。** workspace 级 `pnpm list` 的包数量没有上限；关掉 Cursor 不是打包约定。

**用 `nodeLinker: hoisted` 提升整个 workspace。** 那会为了一条 Windows 打包路径改变仓库里的每一次安装，而且在已报告的 electron-builder 失败里，pnpm 11 在该布局下仍然列出了整个 workspace。

## 后果

Windows 上的 `desktop:pack` 不再依赖列出完整 workspace 生产依赖图。打包现在需要桌面生产闭包的 `pnpm deploy` 成功（workspace 的 `lib/` 产物必须已经存在，这与 electron-builder 从检出复制时的前提相同）。这份一次性 deploy 不是 Python SDK 的 `python/sdk-runtime` deploy-root；那份闭包仍是另一套发行物。electron-builder 的输出是 `resources/app` 下的生产组合。
