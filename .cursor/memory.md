# 对话记忆（从 AiAgent 工作区迁入）

来源对话：Cursor 项目 `H:\pythonProject2\AiAgent`，transcript
`C:\Users\Administrator\.cursor\projects\h-pythonProject2-AiAgent\agent-transcripts\ca32fb7a-f0eb-4f7d-8b30-83cb2662dc90\ca32fb7a-f0eb-4f7d-8b30-83cb2662dc90.jsonl`

Cursor **不能**把原聊天窗口完整搬过来。本文件 + `.cursor/rules/local-product.mdc` 是给新工作区用的可恢复记忆。

## 用户要的最终产品

本地自用、不商业化、无界面的 Agent，给微信机器人当脑子：

- 入口：[OpenClaw 微信插件](https://github.com/Tencent/openclaw-weixin) / `@tencent-weixin/openclaw-weixin-cli`
- 主 Agent 当前台调度员；专用工种按提示词自动派出
- 扩展方式：加工种包（何时用 + 工具白名单 + 人设），不改引擎
- 炒股工种先做分析、不下单

形态（现行方案见 [plans/weixin-mouth-gateway.md](plans/weixin-mouth-gateway.md)）：

```text
微信消息
  → 腾讯 iLink（VPS 嘴巴 H:\weixin-mouth）
    → FRP 仅 127.0.0.1 + 本机 token 文件
      → 家里收网关插件
    → 主 Agent（调度员）
         ├─ 炒股分析（只读行情/新闻，给结论，不直接下单）
         ├─ 代码探索（只读仓库）
         ├─ 动手改文件（可选，白名单工具）
         └─ 以后再加
```

## 已拍板的技术选型

| 层 | 跟谁 |
|---|---|
| 发动机 | DeepSeek Harness（本仓 `H:\dsh-dev`） |
| 工种约束 | Claude 风格：命名 type、工具白名单双锁、`whenToUse` |
| 模型 | GPT 用 `dsh-llm-pi-ai`；不要拿默认 `dsh-llm-deepseek` 硬喂 GPT |
| Python Demo | 最多当微信/HTTP 薄外壳或对照学习 |
| `claude-code-main` | 学约束，不拿泄露仓当主仓 |

## 路径

| 路径 | 角色 |
|---|---|
| `H:\dsh-dev` | 自用 fork，在这里改产品 |
| `H:\deepseek-harness` | 官方源仓拷贝来源，origin 仍是官方，不要当生产 fork 改 |
| `H:\pythonProject2\AiAgent` | 学习项目 |
| `H:\pythonProject2\claude-code-main` | Claude 约束对照 |

拷仓约定：`H:\dsh-dev` 从 `H:\deepseek-harness` 拷出。HEAD `528c682e06`。远程已改为 `https://github.com/sjhmars/dsh-dev.git`，**尚未 push**。源仓冲突会一起过来。

## 接下来要做的产品工作

1. Windows：pwsh 组合，不要官方 `minimal.py` 的持久 bash PTY。
2. GPT：`@deepseek-ai/dsh-llm-pi-ai`。
3. 工种：`agent(type, prompt)`，preset 如 explore（只读）/ stock（分析）/ implement。
4. 微信：VPS 独立嘴巴 + 本仓收网关，见 `.cursor/plans/weixin-mouth-gateway.md`。不用 ACP / 现成 SDK，OpenClaw 插件只对照 iLink。
5. 人设学 Claude 条目但自己措辞，不要整段粘贴泄露 prompt。
6. 压缩用 Harness 自带 `compaction-basic` + tool-result-pruner。
