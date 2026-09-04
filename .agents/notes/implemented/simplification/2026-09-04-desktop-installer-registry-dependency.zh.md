# Agent Note: 桌面安装器从 npm 解析

Status: implemented

[English](2026-09-04-desktop-installer-registry-dependency.md) | 中文

## Problem

桌面组合在每个打包应用中挂载 `@sjhmars/plugin-install`。`file:` 依赖和打包时的同级目录查找把外部仓库路径变成构建输入，因此即使相同版本已经公开，独立的 Harness checkout 仍无法安装或打包。

## Decision

`@deepseek-ai/dsh-desktop-app` 把已发布的 `@sjhmars/plugin-install` 包固定为精确版本 `0.3.1` 的生产依赖。共享 lockfile 记录注册表产物及 integrity。`pnpm deploy --prod` 暂存普通生产闭包，`fillMissingProductionDeps` 处理 deploy 漏掉的生产包。打包流程没有安装器专用的源码复制路径。

`check-pack-plugins` 通过桌面 bundle 已安装的依赖解析安装器 manifest。依赖图检查因而可以跟随安装器的 `pnpm` 生产依赖，无需读取 workspace 之外的仓库。

## Alternatives considered

**保留同级 checkout。** 该布局让本地插件修改立即生效，但安装和桌面打包会依赖固定路径上的无关仓库。

**解析已安装包并保留显式安装器复制。** 通用生产依赖修复已经暂存遗漏包及其依赖。第二条路径会让一个包在没有独立需求的情况下获得不同的部署行为。

**使用 semver 范围。** 安装器在独立仓库中演进，并消费 Harness 的预发布 peer。精确版本让每次插件升级与经过审查的 manifest 和 lockfile 更新保持同步。

## Consequences

干净的 checkout 从已配置的 npm 注册表或包管理器缓存解析安装器，不要求相邻的插件仓库。每个安装器版本必须先发布，桌面依赖和 lockfile 才能采用它。设置页、`desktop` profile 所有权和打包后的运行时行为保持不变。
