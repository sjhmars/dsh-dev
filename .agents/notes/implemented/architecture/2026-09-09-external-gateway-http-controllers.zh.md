# Agent Note: 拆分外部网关 HTTP 控制器

Status: implemented

[English](2026-09-09-external-gateway-http-controllers.md) | 中文

## 问题

单个 HTTP 类混合了路由注册、传输辅助函数和不同资源的处理方法。追踪一个接口需要同时浏览其他接口实现。

## 决策

[路由注册器](../../../../packages/interaction/external-gateway/src/http.ts) 将[接口适配器](../../../../packages/interaction/external-gateway/src/http/routes.ts) 挂载到已有的隔离 WebServer。控制器只接收所需的存储、worker 和运行时依赖；方法接收已校验请求 DTO 并返回明确类型的响应 DTO。[协议模块](../../../../packages/interaction/external-gateway/src/protocol/) 负责查询参数与正文解析，以及显式的记录到响应投影。共用 HTTP 传输层负责 Node 请求、URL 解析、认证、取消和 JSON 编码。worker、运行时及存储保留业务执行和持久化职责；HTTP 请求不决定数据库事务的生命周期。

## 考虑过的替代方案

**单个控制器类。** 文件数量较少，但不利于维护者定位各资源的接口入口。

**新框架或通用控制器父类。** Cordis 已负责应用组装，具体控制器不需要第二套路由器、装饰器系统或继承层次。

## 影响

拆分增加内部模块，不改变路由、协议字段、包的公共导出、调度或事务语义。真实回环 HTTP 测试覆盖路由分发、认证、JSON 和二进制响应、正文限制及路由释放。模型可见内容和 Session 记录格式均不改变。

[raw-body 决策](../simplification/2026-09-09-external-gateway-raw-body.zh.md) 仍独立适用；有界字节读取位于共用 HTTP 请求模块。Session 查询投影保留运行时的 JSON/字节结果联合类型，不另建第二套模型目录或对话记录 schema。
