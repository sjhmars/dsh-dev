# Agent Note: 将网关正文读取交给 raw-body

Status: implemented

[English](2026-09-09-external-gateway-raw-body.md) | 中文

## 问题

外部网关需要对 JSON 和二进制请求流执行相同的字节限制，但三个读取函数重复了请求头检查、分块累积和拼接。读取逻辑分散后，可能仅拒绝声明长度超限，却遗漏分块传输或跨块 UTF-8 输入。

## 决策

[HTTP adapter](../../../../packages/interaction/external-gateway/src/http/request.ts) 使用 `raw-body` 负责流累积、预期长度校验和字节限制。这个直接依赖使用锁文件已有的 3.0.2 解析结果及传递依赖。适配层保留数值请求头校验、各路由的超限错误、JSON 解码及可选空正文语义。读取失败时恢复未销毁的请求流，丢弃剩余字节并让 HTTP 响应完成。

## 考虑过的替代方案

**Express body-parser 中间件。** 传输层提供 Node 请求及自主负责响应的处理器，不是 Express 应用。中间件组合会引入这些路由不需要的机制。

**单个手写公共读取函数。** 这能消除重复，但仍需自行维护流缓冲和长度限制。现有库已覆盖这些职责，符合[优先采用维护中依赖的原则](../process/2026-07-26-dependencies-over-hand-rolling.zh.md)。

## 影响

适配层仍负责认证、协议 schema 和错误名称。JSON 正文和上传分块仍是有界缓冲区，不会变成无界的整文件上传。原始字节不会自动解压缩。Session 事件和模型可见内容保持不变。

[HTTP 测试](../../../../packages/interaction/external-gateway/tests/http.spec.ts) 使用真实回环请求覆盖声明长度及分块传输超限、恰好达到字节上限、跨块 UTF-8、非法及必填空 JSON、上传完成的可选空正文，以及二进制上传下载一致性。这些传输用例不需要模型重放。
