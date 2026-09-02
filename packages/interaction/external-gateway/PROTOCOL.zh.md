---
description: "面向经过认证的外部 DSH 客户端的版本 1 权威线协议。"
kind: "protocol"
---

# DSH External Gateway Protocol v1

[English](PROTOCOL.md) | 中文

本文档是 `@deepseek-ai/dsh-external-gateway` 客户端应遵循的权威协议。`weixin-mouth` 和未来的 Web BFF 实现本协议，不暴露也不依赖 DSH 浏览器 `/api` 传输。

## 传输与认证

受支持的 `external-gateway` profile 让网关监听 `127.0.0.1`。跨机器客户端必须使用加密 FRP、SSH、WireGuard 或 TLS 访问该 loopback service；Bearer Token 不是传输加密机制。

每个受保护请求携带 `Authorization: Bearer <client-token>`。Mutation 请求还携带 `Content-Type: application/json`。Token 由 Host profile 生成并持久化，重启后保持稳定，绝不接受放在 URL、cookie、请求体、profile YAML 或环境变量中的 Token。

Server 从匹配的 Token 推导 `clientId`、account 白名单、peer 白名单和操作 scope。请求体中的 `clientId`、account identity 和 peer identity 会按 endpoint 规则拒绝或忽略；请求体不能扩大 credential 的 scope。

`GET /healthz` 是唯一无需认证的路由。它返回 `{ "status": "ok" }`，不披露版本、配置、credentials 或 storage 状态。

## 寻址与 JSON 规则

外部 identity tuple 是 `clientId + accountId + peerId`。客户端只在本文档允许的地方提供 `accountId` 和 `peerId`；Server 从认证结果提供 `clientId`。Opaque id 必须是非空且已去除首尾空白的字符串。未知对象字段会被拒绝。

所有 sequence 值都是非负安全整数。ID 和文本受当前 profile 的限制。JSON value 只能是有限 JSON primitive、数组和对象；NaN、Infinity、二进制值和循环值不是协议值。

网关 Session 始终未分组，并始终使用 profile 启动 cwd。协议不接受 `cwd`、`workspaceId`、credentials、全局 settings、plugin、动态 Cordis 操作或 Agent preset 文件编辑。

## 查询 endpoint

查询 endpoint 是幂等 GET 请求，不进入 inbox。

| 请求 | 用途 |
|---|---|
| `GET /v1/sessions?accountId=<account>&peerId=<peer>` | 列出该 peer 拥有的 Session 并返回 active Session。 |
| `GET /v1/sessions/:sessionId?accountId=<account>&peerId=<peer>` | 读取一个 Session 的状态、模型、权限、标题和投影。 |
| `GET /v1/sessions/:sessionId/history?...` | 分页读取消息、工具调用和工具结果。 |
| `GET /v1/sessions/:sessionId/models?...` | 列出该 Session 可用的模型。 |
| `GET /v1/sessions/:sessionId/skills?...` | 列出该 Session preset scope 可用的 skill。 |
| `GET /v1/sessions/:sessionId/subagents?...` | 列出该 root Session 直接派出的 subagent。 |
| `GET /v1/artifacts/:artifactId?accountId=<account>&peerId=<peer>` | 下载网关拥有的 export artifact。 |
| `GET /v1/uploads?accountId=<account>&peerId=<peer>` | 列出该 peer 拥有的 upload metadata。 |
| `GET /v1/uploads/:uploadId?...` | 读取一个 upload 的状态和已接收分片序号。 |
| `GET /v1/uploads/:uploadId/content?...` | 在检查归属后下载一个已完成的 upload。 |

Session 和 artifact 读取会在加载 Host 投影前检查归属。外部 peer、本地 Web、其他 client 的或猜测的 Session id 都返回 `404 not_found`，不暴露它是否存在。查询取消会跟随 HTTP 请求生命周期。

## 可靠 mutation

所有会改变状态的操作使用 `POST /v1/deliveries`，顶层字段严格如下：

```json
{
  "deliveryId": "opaque-client-id",
  "accountId": "account",
  "peerId": "peer",
  "payload": { "type": "message", "content": [{ "type": "text", "text": "hello" }] }
}
```

Server 认证并校验请求，检查 account 和 peer 白名单，写入 inbox row，然后返回 `202`。相同 `(clientId, deliveryId)` 且 account、peer、payload 完全相同的重试返回带 `duplicate: true` 的 `200`；相同 id 但 body 不同返回 `409 delivery_conflict`。

接受的 payload tag 是 `session-create`、`session-select`、`session-rename`、`session-fork`、`session-cancel`、`model-select`、`permission-select`、`message`、`command`、`question-answer`、`approval-answer`、`subagent-followup`、`subagent-interrupt` 和 `session-export`。

`session-create` 绝不接受客户端提供的 Session id。网关会在 Host 创建之前把 id 保存在 inbox 中，并在重试时复用它。`message` 可以省略 `sessionId`，以使用该 peer 的 active Session；如果不存在，网关会在固定 cwd 创建一个。`command` 可以省略 `sessionId` 但只能使用已有的 active Session，不会创建 Session。

`message` 复用 Session Controller 的 content part。支持的 gateway block 是文本、使用 Host 支持的光栅媒体类型且经过 base64 编码的 `image`、已完成的 `upload`、已完成的 `file`，以及命名 skill 引用。Image upload 会被解码为现有 image prompt part；file upload 会先复制到固定 gateway cwd 中 `.dsh-external-gateway/inbox/<sessionId>/` 下，再变成安全路径提示。Inline image byte 由 Session Controller 校验并提升到持久 attachment storage；Host adapter 会把 skill 引用确定性序列化为现有 skill 调用语法，而不是任意 command。Message mode 默认是 `queue`，在 Session Controller 支持时可以是 `steer`。

`POST /v1/uploads` 接收 `{accountId, peerId, kind, filename, contentType, size, sha256?}`，并返回归属于当前 peer 的 `uploadId`、4 MiB `chunkSize` 和 `totalParts`。文件上限是 100 MiB，图片上限是 20 MiB。`PUT /v1/uploads/:uploadId/parts/:partNumber` 接收一个原始分片；相同 byte 的重试返回 `duplicate: true`，同一分片的不同 byte 返回 `409 upload_part_conflict`。`POST /v1/uploads/:uploadId/complete` 会在让文件可用于 `message` 前校验全部分片、声明的大小和可选的整个文件 SHA-256。

`session-select`、`session-rename`、`session-fork`、`session-cancel`、`model-select`、`permission-select`、`subagent-followup`、`subagent-interrupt` 和 `session-export` 要求 Session 属于当前 peer。模型选择限制为 Session model catalog。权限选择通过现有 permission preset service。Subagent 操作要求 child 属于所寻址的 root Session。

`command` 执行已注册的 Session-level command，不发送 model message。credentials、settings、workspace mutation、plugin、动态 Cordis 和 Agent preset 编辑等 Host 管理命令会被拒绝。未知 command 返回 command result，而不是普通 model message。

`question-answer` 携带 interaction id 和结构化 `AskUserQuestionAnswer` value。`question` 和 `approval` event 都带绝对 `expiresAt`，客户端到时删除其待决 interaction。`question` event 可以带有 `intent: {"kind":"plan-review","approve":"<option-label>"}`，让客户端在不改变答案编码的情况下渲染 plan review。`approval-answer` 携带 interaction id，且只能是 `allowed-once` 或 `rejected`。Interaction 必须仍然有效、属于所寻址的 Session 和 peer，并且没有超时；否则请求返回 `404 not_found` 或 `409 interaction_unavailable`。

`session-export` 创建 artifact，并通过事件流报告。Artifact bytes 通过检查归属的 artifact endpoint 获取。

## 事件与确认

客户端通过以下接口消费持久化事件：

```http
GET /v1/events?after=<exclusive-sequence>&limit=<n>&waitMs=<milliseconds>
POST /v1/events/ack
Content-Type: application/json

{"upToSequence": 42}
```

事件按 client 拥有严格递增的 sequence，带有目标 `accountId`、`peerId`，以及适用时的 `sessionId` 和可选 `causedByDeliveryId`。没有入站 mutation 原因的事件省略该字段，但仍进入同一个 outbox。

事件 payload tag 是 `delivery-completed`、`delivery-failed`、`session-created`、`session-selected`、`session-updated`、`session-event`、`assistant-final`、`question`、`approval`、`interaction-expired`、`subagent-started`、`subagent-finished`、`artifact-ready` 和 `turn-failed`。

只有 root Agent 提交 `turn/end` 后才生成 `assistant-final`。只有网关拥有的 root Agent 才会生成 `question` 和 `approval`；其他 Agent 的事件交给正常 consumer。内部 Cordis 事件在成为 `session-event` payload 前会经过明确 allowlist 过滤。

Gateway 会保存已经复制到 outbox 的最后一个 Session event sequence。启动时，它会重放此后持久存在的 Session-log event；因此 projection 期间的崩溃可能导致 event 重复，但不会静默遗漏已经 commit 的 event。

`after` 是排他的。Poll 超时返回 `200` 和空的 `events` 数组。一个认证 client 只能有一个活动长轮询；另一个请求收到 `409 poll_in_progress`。断开的请求会取消等待。`ack` 接受零或已发布的最高连续 sequence。缺口、未来 sequence 或超过持久 outbox 的 sequence 返回 `409 invalid_ack`。重复已经应用的 ack 返回 `200`。

网关先持久化 acknowledgement，再删除 row。客户端只能在对应外部效果成功后发送 ack。如果 sender 在外部效果成功但 ack 前崩溃，事件会再次投递；客户端必须接受重复事件。

## 投递语义与错误

Inbox 和 outbox 提供至少一次投递。Host 已准入输入但 inbox row 尚未标记完成时发生崩溃，mutation 可能重复。外部 sender 成功但 outbox ack 尚未完成时发生崩溃，事件可能重复。协议不承诺 exactly-once。

Worker 对同一 client/account/peer conversation 串行处理，对不同 conversation 允许并发。启动后和 outbox ack 释放背压后都会恢复 pending inbox row。未确认事件达到 `maxOutbox` 时，新的 mutation 返回 `503 outbox_backpressure`，直到 client 确认事件。

成功 mutation 在 inbox 状态变成 `completed` 前先产生 `delivery-completed` 事件。失败 mutation 在 inbox 状态变成 `failed` 前先产生 `delivery-failed` 事件。已完成 inbox id 保留配置的时间；未确认 outbox event 不按时间删除。

常见响应码是：新准入 delivery 为 `202`；查询、事件页、ack、upload metadata 和幂等重放为 `200`；新 upload 为 `201`；JSON、schema 或无效 upload metadata 错误为 `400`；认证错误为 `401`；account、peer 或 command 不允许为 `403`；未拥有资源为 `404`；delivery 或分片冲突、不完整 upload、interaction 过期、poll 冲突或 ack 无效为 `409`；body、分片或文本超限为 `413`；mutation 非 JSON 为 `415`；outbox 背压为 `503`。

## 版本

`/v1` 前缀标识本线协议词汇。新增事件或 payload variant 需要客户端兼容性协同更新和明确的 schema 变更。现有客户端必须拒绝未知字段和未知操作 tag，而不是把它们转发给模型。
