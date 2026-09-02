---
description: "仅监听本机回环地址的 HTTP 网关 profile 层：在共享 DSH Host 之上提供可靠外部投递，不提供浏览器 GUI。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-external-gateway-app

[English](README.md) | 中文

## 概述

运行 `dsh --profile external-gateway`，即可在本机回环 HTTP 监听器上提供 DSH 外部协议。本层保留 Web bundle 的 Host 控制器与每个 Session 的 Agent preset，然后移除浏览器传输、前端与 UI 行。它为 `@deepseek-ai/dsh-external-gateway` 添加隔离的 WebServer，并将该包的 `external_gateway` 记录路由到 SQLite。需要 VPS 适配器等机器客户端时选择它；它不提供浏览器页面或第二个可执行程序。

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

当另一个服务需要 DSH 外部协议，而 DSH 进程仍在本机运行时，使用本层。profile 拥有监听器，协议包拥有认证、投递与事件行为。

### 启动随附 profile

```sh
dsh --profile external-gateway
```

该 profile 监听 `127.0.0.1:18765`。启动成功后，浏览器表层保持禁用，不提供根 Web `/api` 或浏览器资源路由。连接另一台机器的客户端前，请在回环监听器前放置加密隧道或 TLS 反向代理。

### 将本层添加到自定义 profile

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-external-gateway-app
dsh plugin --profile <name> remove @deepseek-ai/dsh-external-gateway-app
```

添加操作会把本包的 `dsh.bundle.patch` 层安装到所选 profile。该 profile 还必须组合 `dsh-base` 与 `dsh-web-app`；本层不会重复它们的 Agent、Session 或 Host 控制器行。

### 你会得到什么

本层保留前置 bundle 提供的 Host Session Controller、Agent preset 清单、模型提供方、工具、权限、技能与 subagent 服务。它禁用仅浏览器使用的行，并让 WebServer 与 external-gateway 两个 entry 共享一个私有 `webServer` realm。网关包获得继承的 storage-domain 服务，只有 `external_gateway` 被路由到新增的 SQLite 后端。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本 bundle 是仅配置的 patch。它用显式禁用项替换 Web 传输行，保留不需要浏览器传输的 Host 行，并添加 SQLite 后端以及两个使用相同 `isolate.webServer` 标签的同级 entry。它们继承核心 Agent 与存储服务，因此协议包可以使用现有 Session 与工具组合，而不会接触浏览器 `/api` carrier。

Patch 条目会替换目标行的完整配置。因此 `storage-domain` 条目会重述共享 JSON 默认值，并增加 `external_gateway: sqlite` 路由。隔离 WebServer 在随附层中固定回环主机与端口。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 禁用浏览器表层、路由网关领域，并挂载隔离服务器与协议包 |
| [`src/index.ts`](src/index.ts) | 空 bundle 入口；应用组合由 patch 文档负责 |
| [`src/invariant.ts`](src/invariant.ts) | 没有 bundle 自有运行时关系的不变式伴生插件 |
| [`tests/external-gateway-app.spec.ts`](tests/external-gateway-app.spec.ts) | manifest、禁用行、存储路由与隔离服务器声明 |

### 不变式归属

伴生插件注册空安装器，因为本包只拥有静态 patch 列表。external-gateway 插件、WebServer、存储后端与 Host 控制器拥有其行创建的运行时关系。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

需要了解共享 profile 层、被本 patch 缩减的 Web 组合以及协议实现时，阅读以下页面。

- [dsh-base](../base/README.zh.md)——共享 Agent、模型、工具、Session、策略与存储行。
- [dsh-web-app](../web-app/README.zh.md)——本 profile 复用的 Host 控制器与 Agent preset 组合。
- [external-gateway](../../interaction/external-gateway/README.zh.md)——拥有 HTTP 行为与持久投递的协议包。
- [app-boot profile 章节](../../boot/app-boot/README.zh.md)——bundle 顺序与 patch 替换语义。

-----

<a id="model-experience"></a>
## 模型体验

通过前置 bundle 继承的 Agent preset 与 Host 服务间接产生影响。本 bundle 自身不添加模型可见的提示词、工具或 schema。

### Token 影响

本 bundle 自身不增加请求 token。

### KV Cache 影响

本 bundle 自身没有改变缓存的提示词前缀。所选 Agent preset 与 external-gateway 包拥有任何模型可见内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **监听器只接受回环连接**——另一台机器的客户端需要加密隧道或 TLS 终止；bearer token 不会加密 HTTP。
- **本 bundle 没有浏览器表层**——根页面、前端资源、HMR、浏览器模块与浏览器 UI 行按设计禁用。
- **需要前置 Web bundle**——本 patch 复用它的 Host 控制器与 Agent preset 行，不是独立替代 base 的组合。
- **外部协议拥有自己的限制**——投递保留期、事件积压、认证与允许的操作由 `@deepseek-ai/dsh-external-gateway` 配置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
