# 微信嘴巴 + 本机收网关

自用方案。实现按文末顺序；未要求前不 push `dsh-dev`。

## 结构

```text
微信好友
  → 腾讯 iLink Bot API（扫码登录 token，存在 VPS）
    → VPS 嘴巴（独立仓 H:\weixin-mouth）
      → FRP（只映 127.0.0.1）
        → 家里收网关（本仓 dsh 插件）
          → 父 Agent（/plan、子工种）
```

- Harness 只在家里常驻，不把 `dsh web` 的 `/api` 挂公网。
- 嘴巴在 VPS，**不是** dsh 插件；家里收指令的那一层才是插件。
- 不用 ACP，不用现成 JSON-RPC SDK（stdio，且没有命令）。
- 子工种由父 Agent 进程内派出，不直接跟微信说话。
- 官方 OpenClaw 微信插件只作 iLink 对照，不当生产引擎。

## 两把钥匙

1. **iLink token：** 扫码后腾讯发的，存在 VPS 嘴巴本地，只用来 `getupdates` / `sendmessage`。
2. **网关口令：** 自己生成一长串，**两边各存一个文件**（和 FRP 的 `frp.token` 一样），内容相同。请求头 `Authorization: Bearer <文件内容>`。文件没有或为空则启动失败。不进 git。第一期**不过期**、不用环境变量、不用 Redis。

`peerId` 来自腾讯消息里的发送者 id（如 `from_user_id`），对应家里哪段父 Agent 会话；白名单比的也是它。授权 IP / 安全组是另一回事，后配。

## 私有协议

契约先写在 `H:\weixin-mouth\PROTOCOL.md`，本仓收网关按同一份实现。家里听 `127.0.0.1:18765`（仅 loopback）。

- `POST /v1/message`：`peerId` + `text` → `followup`
- `POST /v1/command`：`peerId` + `name` + `rawInput` → `ctx.commands.execute`（第一期：`plan`）
- `POST /v1/answer`：`peerId` + `questionId` + 选项 → 解开提问 / 工具审批
- `GET /v1/events?peerId=`：推助手终稿、待批准问题

约定：一用户一会话；只回已提交助手正文；`/plan` 由家里命令执行，嘴巴不要自己消化；第一期无图片。

## 本仓

新包建议 `packages/channel/weixin-gateway`。口令从本机 token 文件读。按 `peerId` 复用或 `agents.create`。注册唯一的 `userQuestions` provider（此 profile 不要同时挂 Web 提问器）。网关拥有的 Agent 要能回答 `approval/request`。新 profile `weixin`：叠 `dsh-base`（已有 commands、plan-mode）+ 本插件 + 本机 LLM/pwsh，不挂 webserver。先 curl 打通再接微信。

## 嘴巴仓 `H:\weixin-mouth`

独立 Git，以后再 push。Node 小服务，不依赖 `@deepseek-ai/*`。对照官方 iLink 客户端（MIT），不要 import `openclaw/plugin-sdk`。配置：白名单、`http://127.0.0.1:18765`、网关 token 文件路径。第一期单账号、仅私聊文字。

## FRP 与安全组（后配）

网关端口映到 VPS 的 `127.0.0.1`，禁止 `0.0.0.0`。现有远程桌面：VPS 开 **7000**；本机 visitor 的 **15900** 已是 `127.0.0.1`，安全组不要开 15900、不要开 18765。入站以后再收 22+7000，授权 IP 填家里公网出口，不是服务器 IP、不是局域网 IP。SSH 密码登录后改密钥。

## 以后网页（不做第一期）

登录用户放 VPS（JWT/SQLite；人多再考虑 Redis）。家里只做 `userId`/`peerId` → 会话映射。固定口令泄漏有风险，通道必须 loopback；短票以后再说。

## 明确不做（第一期）

图片、群聊、多账号、OpenClaw 当脑子、公网暴露 Harness `/api`、口令过期、Redis 用户表。

## 落地顺序

1. 嘴巴仓 `PROTOCOL.md`（可与本仓插件并行起草）。
2. 本仓收网关 + `weixin` profile，curl 测 message / plan / answer。
3. 初始化 `H:\weixin-mouth`，接 iLink + 调家里。
4. 本机 FRP 环回联调，再上 VPS。
5. 真微信：只放行自己的号，走通聊天和 `/plan` 批准。
