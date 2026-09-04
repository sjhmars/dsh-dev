# `@deepseek-ai/dsh-desktop`

[English](README.md) | 中文

DeepSeek Harness 的本地桌面客户端：**Electron 主进程就是 dsh 宿主本身**。它在进程内 boot web 组合（base + web-app + [`dsh-desktop-app`](../../packages/bundle/desktop/README.zh.md) 补丁层），经特权本地 `app://` 协议提供浏览器同款前端产物并注入启动清单，渲染层的每个请求经 Electron IPC 桥直达宿主。**全程没有任何 HTTP 监听**——网页版的全部功能（计划模式、模型选择、审批、ask_user_question、命令、设置、工作区）与浏览器完全一致，且随 Web 产品永久同步。

## 架构

| 部件 | 职责 |
|---|---|
| `electron/main.ts` | boot 宿主树（三个 bundle 补丁层叠在 [`cordis.yml`](cordis.yml) 空根上，外加与 CLI 相同的 shipped agent-preset overlay）、经 `app://` 提供前端产物、创建窗口、负责退出收敛 |
| `electron/boot.ts` | 无 Electron 依赖的宿主 boot：profile 机制加 shipped preset 根目录（检出为 `packages/preset/agent-presets/presets`；打包后为 `resources/agent-presets`）。用户自己做的预设仍在 `$DSH_HOME/.agent-presets`。 |
| `electron/bridge.ts` | 把传输无关网关（`@deepseek-ai/dsh-client-connection/desktop` 的 `DesktopBridge`）绑到 `ipcMain` 与窗口 |
| `electron/preload.mts` | 只暴露类型化的 `window.desktopBridge` 传输——渲染层拿不到裸 ipcRenderer |
| `electron/protocol.ts` | 带穿越防护的产物路径映射（纯函数、可测） |
| `packages/bundle/desktop` | 桌面补丁层：disable 纯传输行、把 `connection` 改为无绑定挂载，挂载 `desktop-startup`/`desktop-runtime`（产物解析、`DSH_WEB_MODE`、桌面 surface 提示段、Electron 目录选择器） |
| 渲染层 | 共享的 `@deepseek-ai/dsh-web-frontend` 产物；`DesktopApiClient`（在 `dsh-client-connection` 中）经桥承载 fetch 与两路事件流 |

## 运行

```sh
pnpm run build            # repo artifacts (lib/ for the workspace packages)
pnpm run desktop:dev      # build main + web dist, then launch Electron
```

开发模式从仓库 boot 组合（bundle 补丁经已安装包解析）。窗口展示的就是网页版 GUI；会话与设置存放在共享的 harness home。

再装插件写入 **`desktop` profile**（`~/.dsh/profiles/desktop`），与 `dsh plugin --profile desktop add` 同一目录。浏览器的 `web` profile 是另一套目录——用 `--profile web` 装的插件不会出现在这个窗口。内置的设置 → 插件页只写 `desktop`。

隐藏的原生标题栏在 30px 紧凑 overlay 中保留 Windows 最小化、最大化与关闭按钮的交互态。AppFrame 使用该高度作为第一条网格行：侧边栏跨越两行，获得标题行空间但不移动底部固定的设置区，会话栏与详情栏仍位于窗口控件下方。Electron preload 在整条标题行上挂载固定拖拽区，并在原生窗口控件之前结束，因此移动窗口不依赖共享 Web 布局先完成渲染。标题行使用 `--dsw-specific-sidebar-fill`，因此会随侧边栏同步浅色、深色及覆盖主题。

## 打包

`pnpm run desktop:pack` 先构建 Electron 主进程与 web 产物，再用 `pnpm deploy` 把生产闭包放到 workspace 之外的临时目录，然后对着该树执行 electron-builder（NSIS 安装包 + 便携版）。宿主组合作为生产依赖放在 `resources/app`（不用 asar：Cordis 把插件当 ESM 文件加载，Windows 上的 profile junction 也不能指向 asar 路径——[打包 peer](../../.agents/notes/implemented/bug-fix/2026-08-28-desktop-pack-esm-peers-outside-asar.zh.md)）。生产闭包包含 `dsh-desktop-app` 固定的已发布 `@sjhmars/plugin-install` 包；打包不要求相邻的插件仓库。干净的 Windows 机器无需 Node、无需仓库检出。agent-presets 包的 `presets` 目录作为只读系统名单拷进 `extraResources`；用户自己做的预设仍在 `$DSH_HOME/.agent-presets`。Electron 运行时由 electron-builder 自行获取（缓存下载）。在 Windows 上，为 Electron 重编译 `node-pty` 需要 Visual Studio 单个组件 **MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs**。这份一次性 deploy 让 electron-builder 的 pnpm collector 不必去跑会耗尽 Windows 文件句柄的 workspace `pnpm list`（[隔离](../../.agents/notes/implemented/process/2026-08-27-desktop-pack-isolated-pnpm-deploy.zh.md)）。

## 安全姿态

两条载波、两套围栏——浏览器 HTTP/WS 通道与其 Host/Origin/`sec-fetch-site` 围栏保持原样：

- **桌面载波：无 HTTP。** IPC 桥即信任边界——能过桥的只有本 app 自己的窗口，等价于浏览器载波的 loopback 调用者，因此特权方法直接可达。
- 该等价的前提：`contextIsolation: true`、`nodeIntegration: false`、仅白名单的 `contextBridge`（无裸 ipcRenderer）、窗口只加载本 app 本地产物（CSP `'self'`，禁止外链导航与新窗口；ESM preload 需要 `sandbox: false`）。**将来若向窗口引入远程内容，必须先补回网络级围栏。**

## Known Limitations and Deferred Work

- **桌面窗口无客户端插件热更新（HMR）**（web 开发监听是独立进程）；重建并重启即可生效。
- **单窗口、单机**：暂无多窗口工作区同步、代码签名与自动更新。
- **目录选择器对齐**：桌面使用宿主组合的原生选择器（`directory-picker-auto`），与桌面平台上的 web surface 一致。
