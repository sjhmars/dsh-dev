# Agent Note: Exa 作为默认 Web 搜索提供方

Status: implemented

[English](2026-09-02-exa-default-web-search.md) | 中文

## 问题

每个基于 base 的 profile 都需要安装并选定一个搜索提供方，`web_search` 才能工作。profile 本地插入 Exa 只能配置一台机器，还可能与后续共享默认值冲突。发行版 base 必须携带提供方选择，同时将凭据排除在软件包与生成的 profile 之外。

## 决策

`@deepseek-ai/dsh-base` 依赖并挂载 `@deepseek-ai/dsh-web-search-exa`，其 `web` 行选择 `searchProvider: exa`。因此，每个组合共享 base 的 profile 模板，包括 `web`、`external-gateway`、`headless`、`sdk` 和 `acp`，都无需 profile patch 或单独安装插件即可安装并选定 Exa。`sdk-minimal` 仍是本决策范围外的独立组合。该提供方选择取代了[默认 Web 搜索决策](2026-07-31-web-default-search.zh.md)中针对 DeepSeek 的部分，而其共享 base 归属仍然有效。

当 Exa 行没有配置字面量密钥时，提供方从受信任的启动环境读取 `EXA_API_KEY`。全新安装需要该凭据，但不需要其他搜索配置。仓库与生成的 profile 模板绝不携带 Exa 字面量密钥。

base 使用 `dsh-tool-web` 提供方无关的 30 秒搜索预算。Exa 返回带高亮摘要与发布日期的可引用来源，但不返回提供方生成的答案，因此稳定的 `web_search` 输出会省略 `content`，并保留相同的 `sources` 与 `truncated` 字段。

## 考虑过的替代方案

**保留 DeepSeek 作为共享默认值，并在每个 profile 中添加 Exa。** 不予采纳：新机器需要第二次安装或配置，而且 profile 本地插入可能相互偏离或与共享行重复。

**在 base 中同时挂载两个搜索提供方并选择 Exa。** 不予采纳：未使用的 DeepSeek 搜索包仍会进入每次安装，却不提供故障转移；提供方选择是显式的，不会自动回退。

**在 bundle 或 profile 模板中存储 Exa 密钥。** 不予采纳：凭据不得随源码、软件包、生成的 profile 或快照交付。每个安装通过启动环境提供 `EXA_API_KEY`。

**使用 Perplexity 作为共享默认值。** 不予采纳：选定的产品行为是没有额外生成答案、以结果为中心的搜索。Perplexity 会增加模型生成的 `content` 字段及其自身 token 预算。

## 后果

更新已安装发行版后，每个基于 base 的 profile 会在下次进程启动时改用 Exa；已运行进程保持已经落定的插件树。现有用户 patch 层仍然优先，采用新 base 前必须删除其中重复的 `web-search-exa` 插入。缺少 `EXA_API_KEY` 时搜索无法运行，而且当前 Models 设置页面不管理该凭据。base 组合测试固定选定的提供方与打包依赖，Web 搜索快照则针对本地 `/search` fixture 驱动真实 Exa adapter，并固定规范化后的持久结果。
