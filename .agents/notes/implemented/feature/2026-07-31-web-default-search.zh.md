# Agent Note: 已交付组合中的默认 Web 搜索

Status: implemented

[English](2026-07-31-web-default-search.md) | 中文

## 问题

该 harness 已具备完整的 Web 能力体系：提供方注册表、DeepSeek、Exa 和 Perplexity 搜索提供方、本地抓取、稳定的面向模型工具，以及结构化结果呈现，但已交付的 `dsh web` 组合没有挂载其中任何一项。除非部署提供自定义覆盖层，否则模型无法发现最新信息。仅挂载现有 DeepSeek 提供方仍无法打通 WebUI 链路：Models 页面通过 `ctx.credentials` 存储 `DEEPSEEK_API_KEY`，而搜索提供方只会在插件加载时固定读取进程环境，因此在运行中的 UI 输入或轮换的密钥无法用于搜索。

## 决策

`dsh-base` 明确挂载 `dsh-web`、选定的搜索与抓取提供方及其提供方包，并以 `fetch: false` 挂载 `dsh-tool-web`。因此，共享 base 只会暴露 `web_search`，除非产品 preset 启用抓取；已交付的 Web preset 会启用抓取。显式提供方 id 使选择不受注册顺序影响，同时个人覆盖层或 `--patch` 覆盖层仍可替换或禁用这些配置项。[Exa 默认决策](2026-09-02-exa-default-web-search.zh.md)负责选定搜索提供方与凭据要求。[Web 能力 seam 决策](../architecture/2026-06-24-web-capability-seam.zh.md)负责公开抓取安全策略与 Web preset 默认值。

默认挂载不会创建 Web 专用权限策略。`web_search` 与已启用的 `web_fetch` 调用会在 bash／文件系统沙箱及审批 preset 之外执行，并遵循 `dsh-tool-web` 的现有约定。HTTP 提供方把抓取限制到已验证的公开目的地址，但不限制公开数据出站。已交付的 `workspace-write` 默认值只管辖文件修改；若产品采取受限网络策略，就需要添加 `tools/pre-execute` 策略或按能力限制网络访问，而不能暗示文件系统访问模式会管辖 Web 调用。

## 考虑过的替代方案

**仅挂载 `dsh-tool-web`。** 不予采纳：稳定的 schema 如果没有已注册提供方，每次默认调用都会失败。启用状态与后端可用性刻意分离，但已交付的默认配置必须提供其预期实现。

**将 Web 工具保留在 `web.cordis.yml` 中。** 不予采纳：这会保留 TUI 与 Web／无头界面之间无法解释的工具清单差异。这些配置行并非界面特有，因此其唯一归属是 `base.cordis.yml`；[工具清单决策](2026-07-31-even-out-shipped-tool-rosters.zh.md)记录了这一共享组合。

**在每个共享 base surface 上启用抓取。** 不予采纳：共享 base 服务于网络策略不同的产品。它会挂载仅限公网的提供方，但保持工具按需启用；已交付的 Web preset 会有意启用该工具，其他产品则可以继续隐藏它或添加更严格的网络策略。

## 后果

每个共享 base surface 的原生模型请求都会携带 `web_search` schema 与搜索指引；Web／无头 PTC 模式通过 `run_code` 公开相同的搜索能力。已交付的 Web preset 还会暴露 `web_fetch`，实施公开地址强制校验且无需逐次审批。Web 快照通道会启动已交付配置树，使用本地 fixture（测试前置数据），经由选定的真实提供方驱动一次回放的 `web_search` 调用，断言持久化的结构化结果，并固定最终浏览器呈现。组合冒烟测试会固定共享搜索清单与各 preset 的抓取选择。
