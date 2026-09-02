---
description: "dsh 桌面 GUI bundle：Electron IPC 传输、原生目录选择器、桌面模型上下文与已构建的前端入口。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

## 概述

本包在不开放本地 HTTP 服务器的前提下，把 Web GUI 组合转换为桌面 surface。它禁用 Web 传输行，保留浏览器侧客户端 roster，以 Electron IPC 桥替换 API 与数据流传输，提供已构建的前端入口，并挂载原生目录选择器。打包桌面客户端应选择本包；界面需要通过浏览器访问时使用 [`dsh-web-app`](../web-app/README.zh.md)。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Electron 应用通过 `desktop` profile 加载本 bundle。`desktop-startup` 行解析已构建前端的 `index.html`；产物缺失时，启动会失败并给出构建指令。runtime 行注册桌面模型上下文，向受管 shell 暴露 `DSH_WEB_MODE=desktop`，并把 Electron 的操作系统目录选择器作为 `ctx.directoryPicker` 提供。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `surfaceContext` | `true` | 注册 `app:desktop-surface` 提示段与 `DSH_WEB_MODE` shell 变量。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-desktop-app)列出可接受字段及其源码声明。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本 patch 叠加在 `dsh-web-app` 之上。它禁用 `webserver`、`web-runtime`、`web-startup`、`client-hmr` 与自适应目录选择器；无 HTTP bind 地重新挂载 `connection`；随后插入桌面 startup、runtime、原生目录选择器与插件安装行。Electron 应用拥有 `dsh-client-connection` 和 `apps/desktop` 中的 IPC 桥接线。

### 插件行

| 行 | 包 | 职责 |
|---|---|---|
| `desktop-startup` | `@deepseek-ai/dsh-desktop-app/startup` | 通过前端包导出提供 `desktopRuntime.distIndex`。 |
| `desktop-runtime` | `@deepseek-ai/dsh-desktop-app` | 注册桌面上下文、shell 变量与 Electron 目录选择器服务。 |
| `directory-picker-surface` | `@deepseek-ai/dsh-client-ui-directory-picker-native` | 在 workspace 槽位提供原生目录选择器 UI。 |
| `plugin-install` | `@sjhmars/plugin-install` | 把 npm 包添加到独立的桌面 profile。 |

### 源码索引

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 以桌面载体行替换 Web 传输行。 |
| [`src/startup.ts`](src/startup.ts) | 解析并提供已构建的前端入口。 |
| [`src/index.ts`](src/index.ts) | 注册桌面模型上下文、shell 变量与目录选择器。 |
| [`src/picker.ts`](src/picker.ts) | 把 Electron 目录对话框适配为 `ctx.directoryPicker`。 |
| [`src/invariant.ts`](src/invariant.ts) | 声明空的运行时 invariant companion。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [桌面应用](../../../apps/desktop/README.zh.md) — Electron 进程与 IPC 桥的所有权。
- [Web bundle](../web-app/README.zh.md) — 本 patch 特化的浏览器 surface。
- [客户端连接](../../client/connection/README.zh.md) — 浏览器与桌面传输选择。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-desktop-app) — 完整配置参考。

-----

<a id="model-experience"></a>
## 模型体验

### 桌面 surface 上下文

#### 模型看到什么

`surfaceContext` 开启时，一个 `app:desktop-surface` 段会标识桌面客户端，解释对本窗口或本应用的指代，说明不存在本地 HTTP 服务器，并指出客户端改动需要重建和重启。受管 shell 还会收到 `DSH_WEB_MODE=desktop`。

#### Token 影响

每次请求包含一个固定系统提示段和一个受管环境变量；两者都与数据无关。

#### KV Cache 影响

该段文本跨会话保持稳定，因此不会使可复用的请求前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **必须先构建前端** — 源码 checkout 需要运行 `pnpm run build`；导出的前端入口缺失时启动停止。
- **客户端插件不热更新** — 客户端改动需要重建并重启桌面窗口。
- **无法程序化关闭操作系统选择器** — 被中止的 `pickDirectory` 请求返回 `null`，但操作者必须手动关闭已经打开的对话框。
- **Web 传输行必须保持禁用** — 启用 `webserver` 或 `web-runtime` 会重新引入桌面载体移除的 HTTP surface。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
