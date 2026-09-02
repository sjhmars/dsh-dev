---
description: "面向 VPS 桥接与未来 Web BFF 客户端的、经过认证且持久可靠的 peer 作用域 DSH Session HTTP 协议。"
kind: "package-reference"
---

# @deepseek-ai/dsh-external-gateway

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-external-gateway` 为 VPS `weixin-mouth` 桥接和未来 Web BFF 客户端提供一套版本化 `/v1` HTTP 协议。它让 DSH Host 保持本地运行，不加载浏览器界面，也绝不会注册现有浏览器 `/api` 或 `/api/remote.mux` 路由。

本包负责协议校验、Bearer Token 认证、peer 作用域的 Session 归属、持久化 inbox delivery、持久化 outbox 事件、序号游标，以及把已接收变更交给注入式 Session runtime 的 worker。Agent loop、Session 日志、工具、credentials 和存储后端仍由现有包负责。

## 目录

- [使用本包](#use-this-package)
- [配置](#configuration)
- [协议](#protocol)
- [持久化与投递](#persistence-and-delivery)
- [安全不变量](#security-invariants)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在仅含 Host 的 profile 中组合本包。通过 `ctx.storageDomain` 打开 `externalGatewayDomainSpec`，构造 `ExternalGatewayStore`，创建 Session runtime adapter，再将二者交给 `ExternalGatewayWorker` 和 `ExternalGatewayHttp`。应用 bundle 负责组合；本包不会启动 Node Server，也不会增加 package bin。

HTTP carrier 只需要隔离 Host WebServer realm 提供的 `register(route)` 方法。把网关路由注册到浏览器 WebServer 会违反 profile 的传输隔离不变量。

协议权威文档是 [PROTOCOL.md](PROTOCOL.md)。客户端必须遵循相同的 delivery 和事件规则，不得读取 Host 内部 controller 或浏览器 Remote API。

## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `tokenFile` | `$DSH_HOME/profiles/external-gateway/weixin-mouth.token` | 稳定且仅 owner 可访问的机器 credential。 |
| `artifactDirectory` | `$DSH_HOME/profiles/external-gateway/artifacts` | 仅 owner 可访问的 Session export 存储。 |
| `clientId` | `weixin-mouth` | 配置 Token 匹配后推导的身份。 |
| `accountIds`、`peerIds` | 空 | 可选的 credential 级 allowlist。 |
| `maxBodyBytes` | 由应用定义 | 单个 JSON 请求的最大物理大小。 |
| `maxTextBytes` | 由应用定义 | 单个请求字符串的最大 UTF-8 大小。 |
| `maxEvents` | 由应用定义 | 单次 poll 返回的最大事件数量。 |
| `maxPollMs` | 由应用定义 | 长轮询最大等待时间。 |
| `maxOutbox` | `10,000` | 单个客户端未确认事件的最大数量。 |
| `completedRetentionMs` | `30 天` | 已完成 inbox row 的保留时间。 |
| `interactionTimeoutMs` | 由应用定义 | question 或 approval interaction 的有效期。 |
| `maxUploadBytes` | `100 MiB` | 已完成 file upload 的最大大小。 |
| `maxImageBytes` | `20 MiB` | 已完成 image upload 的最大大小。 |

固定在 `127.0.0.1:18765` 的隔离 WebServer 由 bundle 而非此 plugin 配置。Profile 提供固定的启动 cwd。它用于归属检查且不会接受请求体中的 cwd。

<a id="protocol"></a>
## 协议

受保护路由要求 `Authorization: Bearer <token>`，mutation 请求要求 JSON content。Server 从匹配的 credential 推导 `clientId`、允许的 account 和允许的 peer；请求不能声明或覆盖这些值。

`POST /v1/deliveries` 接收 Session 创建、选择、重命名、分叉、取消、模型和权限选择、消息、Session 命令、interaction 答案、subagent 控制和 Session 导出。新 delivery 在获得 `202` 前已经持久化；相同 `(clientId, deliveryId)` 的重试具有幂等性。

`GET /v1/events` 按排他序号游标读取客户端 outbox。`POST /v1/events/ack` 只接受客户端已接收的最高连续序号。事件在确认前保持持久化，因此客户端必须保存游标，并在传输失败后重试发送。

只读 Session 投影通过 `GET /v1/sessions`、其 Session 子路径和 `GET /v1/artifacts/:artifactId` 提供。每次投影读取前都会检查 peer 归属；外部 peer 的或猜测的 Session 统一报告为不存在。

`POST /v1/uploads` 会启动一个经过认证且归属于 peer 的上传。客户端向 `/v1/uploads/:uploadId/parts/:partNumber` 发送原始 4 MiB 分片，可安全重试相同分片，并通过 `/complete` 提交全部分片；metadata 和已完成 byte 会持久化在固定 gateway cwd 下。

已完成的 image upload 可以在后续 message 中引用，并通过现有 Session Controller 提升。已完成的 file upload 会复制到固定 cwd 中 `.dsh-external-gateway/inbox/<sessionId>/` 下，再变成安全路径提示，因此现有 model 和 tool 可以读取它，无需修改共享 Session message model。

完整的 payload 和事件词汇见 [PROTOCOL.md](PROTOCOL.md)。

<a id="persistence-and-delivery"></a>
## 持久化与投递

`external_gateway` storage domain 保存 inbox delivery、peer 拥有的 Session reservation、active peer 映射、interaction、upload metadata 和分片状态、Session projection cursor、artifact metadata、客户端游标和 outbox 事件。Upload 和 export byte 使用仅 owner 可访问的文件。Domain 在重开时校验 schema，版本不匹配会令启动失败，而不是静默迁移数据。

Worker 按一个 client/account/peer conversation 串行处理 delivery，不同 conversation 可以并行。若 runtime 已接受 mutation 但进程在完成 inbox row 前崩溃，mutation 可能再次执行；这是有意采用的至少一次语义。Worker 在改变 inbox 状态前先写入完成或失败事件，因此已完成 delivery 不会隐藏其唯一结果。

Session 创建会在 runtime 创建 Session 之前把显式 Session id 保存在 inbox。部分写入或进程重启后的重试会复用同一 id，而不是生成无关的第二个 Session。

Allowlist 中的 Session event 会使用持久的逐 Session cursor 复制到 outbox。启动时会重放 cursor 之后的 event，因此 Session log commit 与 outbox write 之间发生崩溃时可能重复 projection，但不会静默丢失。

<a id="security-invariants"></a>
## 安全不变量

自动生成的 Bearer Token 保存在 owner-only 文件中，并在重启间保持不变。Token 不会放进 URL、cookie、profile 文件、请求体或环境变量。跨机器使用仍必须通过加密 FRP、SSH、WireGuard 或 TLS 传输。

网关 Session 未分组，并使用 profile 启动 cwd。协议没有 `cwd`、`workspaceId`、credentials、全局 settings、plugin、动态 Cordis 或 Agent preset 修改操作。访问 Host 前会检查 Session、interaction 和 subagent id 是否属于认证 peer。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 第一个客户端是单账号 VPS `weixin-mouth` 桥接；其 iLink 游标、`context_token`、二维码绑定和 FRP service 位于独立仓库。
- 本包不提供 exactly-once 语义。客户端与 Host 必须接受崩溃窗口内重复 mutation 或事件投递。
- 完整 Web 控制台仍需要 richer history、文件、settings 和模型管理的 BFF adapter；它必须继续使用本协议，而不能暴露浏览器 API。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`ExternalGatewayRuntime` 是现有 Session Controller、command、permission、skill 和 subagent service 的 package seam。应用 profile 负责提供这些 service；本包提供协议和持久投递机制。

</details>
