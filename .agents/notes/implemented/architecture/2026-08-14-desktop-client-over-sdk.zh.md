# Agent Note: 桌面客户端在进程内承载 Web 组合并经 IPC 桥接入——无 SDK、无 HTTP 监听

Status: implemented

[English](2026-08-14-desktop-client-over-sdk.md) | 中文

## Problem

独立桌面客户端需要完整 Web GUI 功能集——计划模式、模型选择、审批、ask_user_question、命令、设置——而且不开浏览器。走第二条协议（SDK 路线）会分叉产品：每个宿主能力都要跨线重新接一遍，永远追不上 Web surface。给 `dsh web` 套窗口能保住功能对等，但会保留本地 HTTP 监听，这恰恰是仓库自己的桌面方案所拒绝的。

## Decision

**Electron 主进程就是 dsh 宿主。** `apps/desktop/electron/main.ts` 经 `@deepseek-ai/dsh-app-boot` 的 `boot()` 在进程内启动 web 组合：三个 bundle 补丁层——base、web-app 与新包 `dsh-desktop-app`——叠在空根配置上，与 acp-demo 的 boot 模式完全一致。桌面补丁层 disable 纯传输行（`webserver`、`web-runtime`、`web-startup`、`client-hmr`），并把 `connection` 改为无绑定挂载：其节点半现在把 `webServer` 视为可选（存在即注册、否则注入等待，与 modules 的改动同款），没有 web server 时该行不注册任何东西，而其浏览器半——渲染层提供 `ctx.connection` 的启动图行——保持组合。补丁还挂载 `desktop-startup`（提供 `desktopRuntime` 与产物 index）与 `desktop-runtime`（`app:desktop-surface` 提示段与 `DSH_WEB_MODE`）。整棵树没有任何 HTTP 监听。

**一份渲染层、两种载波。** 窗口经特权本地 `app://` 协议加载共享的 `@deepseek-ai/dsh-web-frontend` 产物（模块脚本无法在 `file://` 下运行），复用 modules 节点半的 `injectBootManifest` 注入 `window.__DSH_BOOT__`。连接层客户端在构造点选择载波：`window.desktopBridge` 存在 → `DesktopApiClient`，否则用现有 `WebApiClient`——`dsh-client-connection/src/client/index.ts` 里的一行，浏览器路径不受影响。

**桥复用传输无关网关。** `DesktopBridge`（`dsh-client-connection` 新增节点半模块，导出为 `./desktop`）把 fetch 形状请求经 `toFetchHandler(apiProxy)` 分发、把 `api.events.mux/host` 泵入注入的 sink；Electron 应用负责 `ipcMain`/`webContents` 接线。响应体以 base64 分块流回；事件帧保持 WebSocket 载波的 `ServerRequest` 形状与相同的客户端 schema 校验。插件 bundle 经 `ClientModuleRegistry.bundleText(id)` 面到达渲染层：shell 用同源 `<script src>` 加载（脚本标签不过桥），因此应用的 `app://` 协议按 web 宿主路由的同一路径词汇与 no-cache 语义提供 `/plugins/<id>/client.js`（及 `.map`）。渲染层的裸 `globalThis.fetch`（typert 网关 `remote.*` 命名空间所走的 `/api` 逻辑 RPC 通道——`rpc.ts` 保持原样不动）由同一协议处理器应答：它把 `/api` 转发给进程内网关；桥自身的 fetch 通道承载 api 客户端的单体请求。

**modules 节点半去掉对 webServer 的硬依赖。** `inject` 改为 `['loader']`；`/plugins` 路由与 index tap 在 `ctx.inject(['webServer'], …)` 内注册，没有 web server 的组合保留图与 bundle 面、不注册 HTTP 路由。Web 注册语义不变。

**目录选择器钉住 native 交互，走 Electron 自带对话框。** web profile 的自适应选择器行靠 webserver bind 分辨 native/browse，因此桌面补丁将其 disable；`desktop-runtime` 自己注册 `ctx.directoryPicker`，`native` 能力由惰性 `import('electron')` → `dialog.showOpenDialog` 支撑（不用 koffi 子进程——其 native addon ABI 与 Electron 不匹配），补丁同时钉住 `dsh-client-ui-directory-picker-native` surface 行，ui-workspace 的目录流插孔仍有占据者。Electron 无法程序化关闭已打开的对话框：被中止的 `pickDirectory` 返回 `null`，对话框留待操作者关闭。

**桌面 boot 复刻 CLI 的部署 overlay。** 除 profile 各层外，`bootDesktopHost` 也像 `composeProfile` 一样补上 shipped agent-preset 根目录：未打包为 `{ path: <apps>/cli/config/agent-presets, trust: 'system' }`；打包后 pack 把该 CLI 目录拷进 extraResources，覆盖为 `{ path: join(process.resourcesPath, 'agent-presets'), trust: 'system' }`（[presets extraResources](2026-08-28-desktop-presets-extraresources-plugin-install.zh.md)）。缺了系统根，桌面名单里只剩用户的 `$DSH_HOME/.agent-presets`，`session.create` 会因默认 preset 失败。

**信任模型。** 桥即围栏：只有本 app 自己的窗口能到达（contextBridge 白名单、纯本地内容），等价于浏览器载波的 loopback 调用者——桌面载波上的特权方法无需 Host 检查。该等价的前提（CSP `'self'`、禁导航/禁新窗口、`sandbox: false` 仅因 preload 是 ESM）记录在 `apps/desktop/README.md`：将来引入远程内容必须先补回网络级围栏。

**打包对着一次性 `pnpm deploy` 树运行 electron-builder。** 整套宿主组合作为生产依赖放在 `resources/app`（`asar: false`：插件是独立 ESM 文件，[打包 peer](../bug-fix/2026-08-28-desktop-pack-esm-peers-outside-asar.zh.md)），无需 pkg 单文件可执行、无需 `python/sdk-runtime` deploy-root。`desktop:pack` 构建 Electron 主进程与 web 产物，把 `@deepseek-ai/dsh-desktop` 的生产闭包 deploy 到 workspace 之外，再从该树产出 NSIS + portable 双目标，这样 electron-builder 的 pnpm collector 就不会列出每个 workspace 包（[隔离](../process/2026-08-27-desktop-pack-isolated-pnpm-deploy.zh.md)）。

## Consequences

- 功能对等是结构性的：桌面窗口渲染的就是浏览器抓取的那份产物，每个 Web 能力自动到位并保持同步。
- SDK 阶段的自绘 UI（React 渲染层、对象层、SDK RuntimeManager）被移除——未发布、无兼容负债；SDK 与 ACP 包零改动。
- 仅桌面载波以"loopback 等价"信任模型替代 Host 围栏；浏览器围栏代码保持原样，前提已写入文档。
- Electron 保持为工作区 dev 依赖（安装时下载二进制，`pnpm-workspace.yaml` `allowBuilds`）；桌面 bundle 以 devDependency 声明它供类型使用，并在 tsdown 配置里把它钉为 external，让惰性 dialog 导入在打包后仍成立。
- `host.pickDirectory` 经 Electron 对话框可用；`listDirectory`/`createDirectory` 返回 `directory-picker-unavailable`，与任何钉住 native 交互的 Web 部署一致。
- **共享 home 隐患**：桌面宿主与同时运行的 `dsh web` 服务是两个进程共享一个 `$DSH_HOME`，而 jsonl 持久化没有跨进程锁——两个 surface 同时挂同一个会话会重复分配 seq 并损坏日志（已观测到：重复的 `agent/inbox/spliced` seq）。在持久化 seam 获得进程间互斥之前，不要从两个 surface 同时打开同一个会话。

## Alternatives considered

- **SDK 传输 + 自绘 UI** —— 第一版实现；有流式、零服务端改动，但每个宿主能力（计划模式、审批、模型选择）都要跨线重接，永远落后于 Web 产品。
- **窗口套 `dsh web`** —— 立即对等，但保留本地 HTTP 监听与"框里套浏览器"的形态，正是仓库文档化的桌面方案所拒绝的。
- **pkg 单文件宿主 exe** —— 没有必要：宿主跑在 Electron 主进程内，打包应用只需 `resources/app` 里的组合与依赖。
- **用 boot 标志而非 `window.desktopBridge` 做运行时嗅探** —— preload 暴露的传输对象是更直接的信号：载波正是 preload 安装的东西。
