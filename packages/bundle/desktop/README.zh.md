# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

dsh 桌面 surface bundle：叠在 [`dsh-web-app`](../web-app/README.zh.md) 之上的桌面补丁层加运行时胶水插件。它 disable 纯传输行（`webserver`、`web-runtime`、`web-startup`、`client-hmr`）以及自适应目录选择器（其交互方式依赖 webserver bind 解析），把 `connection` 行改为无绑定挂载（IPC 桥替代其 `/api` 路由与 WebSocket 下行，而其浏览器半必须留在启动图中），挂载桌面载波行——`desktop-startup`（提供 `desktopRuntime`：前端产物 index 的解析）、`desktop-runtime`（`app:desktop-surface` 提示段、`DSH_WEB_MODE` shell 变量与 Electron 支持的 `ctx.directoryPicker`）与钉住的 native 目录选择器 surface。浏览器 roster 与 Web surface 完全一致；IPC 桥接线属于 Electron 应用，位于 `dsh-client-connection` 与 `apps/desktop`。

## 插件

| 行 | 包 | 职责 |
|---|---|---|
| `desktop-startup` | `@deepseek-ai/dsh-desktop-app/startup` | 提供 `desktopRuntime`（经前端包导出解析 `distIndex`）。 |
| `desktop-runtime` | `@deepseek-ai/dsh-desktop-app` | 模型可见定位、shell 变量与 Electron 目录选择器服务；无服务器、无 URL。 |
| `directory-picker-surface` | `@deepseek-ai/dsh-client-ui-directory-picker-native` | 钉住的 native surface，占据 ui-workspace 的目录流插孔（Web profile 由自适应选择器动态挂载）。 |
| `plugin-install` | `@sjhmars/plugin-install` | 设置 → 插件页：等价 `dsh plugin --profile desktop add`（只接受 npm 包名）。浏览器的 `web` profile 是另一套目录，互不相通。 |

## Model Experience

### Prompt text

#### What the model sees

`surfaceContext` 开启时，一个 `app:desktop-surface` 段说明用户通过桌面客户端交互、没有本地 HTTP 服务（其他页面无法触达本会话）、客户端改动需要重建并重启。

#### Token effect

每次请求一个固定系统提示段；与数据无关。

#### KV Cache effect

追加稳定：段文本不随会话变化，可复用请求前缀不受影响。

## Known Limitations and Deferred Work

- **无客户端插件 HMR**：桌面窗口靠重建生效，不热更新客户端 bundle。
- **OS 选择器无法中止**：Electron 没有程序化关闭已打开目录对话框的方式。被中止的 `pickDirectory` 请求返回 `null`，但对话框保持打开，由操作者手动关闭。
- **纯传输行保持 disable**：`connection` 行以无绑定方式运行（没有 `webServer` 时其节点半跳过注册）；在桌面载波激活时重新启用 `webserver`/`web-runtime`，会重新引入本层存在的意义就是要移除的 HTTP surface。
