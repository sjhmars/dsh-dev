# Agent Note: External Gateway 控制台诊断

Status: implemented

[English](2026-09-09-external-gateway-console.md) | 中文

## Problem

无界面的网关没有浏览器日志查看器。Cordis 在没有终端 exporter 时只缓冲日志，而投递准入成功不能证明模型轮次成功。

## Decision

网关安装命名且由 scope 管理的 stderr exporter，只观察归属存储中 Session 的实时事件。启动、轮次和步骤进度、Agent 错误、失败轮次原因及投递失败无需额外 CLI 参数即可看到。控制台诊断不回放 outbox 历史，也不改变协议事件。

## Alternatives considered

**导出所有 Cordis logger。** 无关插件可能记录凭据、模型输入和工具数据。网关只导出专用诊断 logger。

**打印完整 Error 对象。** 模型提供方对象及 cause 可能包含请求头和正文。诊断只选取错误消息，屏蔽常见凭据格式和 URL，并限制输出长度。

## Consequences

logger 不创建另一份持久化日志。运维通过 stderr 控制收集，可以关闭控制台输出；分享前必须检查模型提供方的错误文本，因为格式屏蔽不能识别所有秘密。scope 释放会移除监听器和 exporter。包内控制台测试覆盖归属过滤、错误可见性、屏蔽、输出长度及释放行为。
