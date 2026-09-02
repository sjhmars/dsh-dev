# Agent Note: External Gateway 机器协议

Status: implemented

[English](2026-08-31-external-gateway-machine-protocol.md) | 中文

## 问题

VPS 桥接与未来 Web BFF 需要可靠、按 peer 划分的 DSH Session 控制能力，但现有 Web 应用是带启动令牌 cookie 和完整 Host API 的浏览器传输。复用 `/api` 会把浏览器导向或宿主管理操作暴露给机器客户端；桥接若直接调用 Agent 内部能力，则会重复实现 Session 归属、投递恢复和交互请求。

## 决策

`dsh --profile external-gateway` 组合 `dsh-base`、`dsh-web-app` 与 `dsh-external-gateway-app`。新应用 bundle 保留成熟的 Host Agent、Session Controller、模型、权限、技能、命令与 subagent service，同时移除浏览器 connection、Remote API、frontend 和 UI row。隔离的 loopback WebServer realm 只在 `127.0.0.1:18765` 挂载 `@deepseek-ai/dsh-external-gateway`。

网关为固定的 `weixin-mouth` client 接收长期、仅 owner 可访问的 bearer token，并提供版本化 `/v1` 路由。客户端提供 account 和 peer 地址；认证提供 client identity。网关在 `external_gateway` SQLite domain 中持久化 peer 拥有的未分组 Session、peer active Session、去重 inbox delivery、client 序号 outbox event、interaction record、projection cursor、upload metadata 和分片状态与 export metadata。Upload 分片固定为 4 MiB，执行 owner 校验，并在固定 gateway cwd 下合成为文件；profile 配置默认 file upload 上限为 100 MiB、image upload 上限为 20 MiB，并可调整这些限制。已完成的 image 通过现有 Session Controller 解析；每个已完成的 file 在 Session model 接收前会复制到固定 cwd 下的 `.dsh-external-gateway/inbox/<sessionId>/`。VPS bridge 通过本协议发送 metadata 和 upload 分片，而不是把 blob 存进 iLink message state。每个网关 Session 使用 profile 启动 cwd。协议排除 cwd 与 Workspace 变更、credentials、settings、plugin、动态 Cordis 和 Agent preset 修改。

Mutation 采用至少一次语义。Worker 在调用 Host service 前持久化接收记录，并在完成 inbox row 前产生可持久化的完成或失败事件。客户端通过连续 outbox cursor 确认外部效果。经 allowlist 过滤的 Session-log projection 保存逐 Session cursor，并在启动时重放。Question 与 approval 只属于网关拥有的 root Agent；每个 interaction 都有绝对过期截止时间，取消、超时或进程重启后的回答都会过期。Question event 保留 `plan-review` presentation intent 及其具名批准选项，但不改变答案编码。

浏览器启动令牌与 cookie 规则仍由[浏览器启动令牌认证](2026-08-24-browser-token-authentication.zh.md)持有。未来 Web BFF 使用另一枚 gateway token 和同一机器协议；它不转发浏览器 cookie，也不发布浏览器 API。

## 验证

定向网关测试覆盖严格 wire 字段、image 和 upload content、4 MiB 分片重试与冲突、bearer 校验、delivery 冲突与恢复、归属、event 顺序与确认、背压、projection 重放、固定 cwd、命令、模型、权限、技能、subagent 和 bundle 组合，并覆盖 question 过期和 `plan-review` intent 传播。一次 source-profile loopback smoke 创建了 peer-owned Session，确认 `/api` 与 `/api/remote.mux` 返回 404，导出了 ZIP artifact，并确认了事件。

## 曾考虑的替代方案

**通过 tunnel 暴露浏览器 `/api`。** 它会让 VPS client 依赖浏览器 cookie，并把完整 Host API 暴露到原本只应具备 peer 作用域 Session 操作的位置。

**为桥接新建一套 Agent 或 Session runtime。** 这会重复生产 Agent 组装，并产生不兼容的 Session、工具和交互行为。

**使用直接同步的请求-响应协议。** 进程或网络失败会丢失结果，或让恢复与重复执行无法区分。持久 inbox 与需确认的 outbox 明确标出了重复窗口。

**每个机器 client 只有一个 Session，不携带 peer 地址。** 未来 Web BFF 之类的共享 client 就会混合不同用户的对话。peer 归属是每一次 Session 查询的一部分。

## 后果

网关是仅含 Host 的应用，而不是桌面或浏览器界面。它复用 DSH Session 能力，但刻意不授予宿主管理权限。实现客户端必须跨自身重启保留 delivery ID 与 event cursor，接受重复 mutation 或发送，并在 bearer token 之外使用加密传输。VPS iLink bridge、扫码绑定和 `context_token` 恢复已经实现；FRP 部署和 systemd service 管理仍属于运维工作。
