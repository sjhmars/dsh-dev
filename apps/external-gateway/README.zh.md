# @deepseek-ai/dsh-external-gateway-deployment

[English](README.md) | 中文

## 概述

External Gateway 应用是 DSH 机器网关面向部署的一方目录。它定义应用身份、启动命令、回环监听器和冒烟预期，不增加另一个可执行程序。唯一启动器仍是 `dsh` CLI，profile 仍通过 `dsh --profile external-gateway` 启动。

## 启动应用

通过已安装的 `dsh` 命令运行应用：

```sh
dsh --profile external-gateway
```

应用监听 `127.0.0.1:18765`。VPS 客户端连接前，请在该监听器前放置加密隧道或 TLS 终止。Bearer Token 只认证客户端，不会加密传输。

## 回环冒烟

[`application.json`](application.json) 中的应用描述记录健康检查端点、仅回环绑定和浏览器路由预期。冒烟运行必须确认本机可以访问 `/healthz`，并确认浏览器的 `/api`、`/api/remote.mux` 和前端路由没有暴露。

## 归属

本目录负责面向部署的应用身份、使用说明和回环冒烟语义。[`@deepseek-ai/dsh-external-gateway`](../../packages/interaction/external-gateway/README.zh.md) 负责协议校验、认证、Session 访问和可靠投递。[`@deepseek-ai/dsh-external-gateway-app`](../../packages/bundle/external-gateway-app/README.zh.md) 负责组合这些服务的静态 profile patch。协议词汇只有一个归属，位于 [`PROTOCOL.md`](../../packages/interaction/external-gateway/PROTOCOL.md)。

应用包没有 `bin` 字段。不要通过导入包入口启动运行时，也不要增加第二个 Node 可执行程序。

## 进一步探索

- [`dsh` CLI](../cli/README.zh.md)——启动器语法与 profile 初始化。
- [`external-gateway` 协议包](../../packages/interaction/external-gateway/README.zh.md)——已认证的 `/v1` 行为。
- [`external-gateway-app` bundle](../../packages/bundle/external-gateway-app/README.zh.md)——Host 组合与浏览器表层隔离。

## 已知限制与延期工作

- profile 只监听回环地址；跨机器访问需要加密隧道或 TLS。
- 本应用目录不提供浏览器控制台、VPS 桥接、二维码绑定或 iLink 适配器。
- DSH profile 及其 bundle 仍是运行时来源；本包只发布部署描述。

## 开发备注

应用描述保持小而明确，避免部署文档和冒烟检查成为协议或 profile patch 的第二个归属。
