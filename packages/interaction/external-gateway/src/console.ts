/** 网关专用控制台诊断；不输出会话正文、工具参数或完整错误对象。 */
import type { Context, Logger } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 控制台输出开关与单条日志长度限制。 */
export interface GatewayConsoleOptions {
  /** 是否向 stderr 注册网关专用 exporter。 */
  readonly enabled: boolean
  /** 每条日志正文的最大字符数，不包含时间与等级前缀。 */
  readonly maxChars: number
}

function safeText(value: unknown, maxChars: number): string {
  let text = '未知错误'
  if (typeof value === 'string') text = value
  else if (value instanceof Error) text = value.message
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
  return text
    .replace(/https?:\/\/[^\s"<>]+/giu, '[URL]')
    .replace(/\bBearer\s+[^\s"',;]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|sk_)[a-z0-9_-]+/giu, '[REDACTED]')
    .replace(/\b[a-f0-9]{64}\b/giu, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/giu, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .slice(0, maxChars)
}

/**
 * 将网关命名日志输出到 stderr，exporter 随 Cordis scope 释放。
 * @param ctx - 网关所属上下文。
 * @param options - 输出开关和单条日志长度。
 * @returns 用于启动及后台失败诊断的命名 logger。
 */
export function installGatewayConsole(ctx: Context, options: GatewayConsoleOptions): Logger {
  const logger = ctx.logger('external-gateway-console')
  if (!options.enabled) return logger
  ctx.logger.exporter({
    export(message) {
      if (message.name !== 'external-gateway-console') return
      const parts: string[] = []
      for (const argument of message.args) {
        parts.push(safeText(argument, options.maxChars))
      }
      const body = parts.join(' ').slice(0, options.maxChars)
      process.stderr.write(`[${new Date(message.ts).toISOString()}] [external-gateway] [${message.type}] ${body}\n`)
    },
  })
  return logger
}

/**
 * 记录网关拥有的 Session 执行摘要；不从 outbox 回放，避免重启重复打印历史。
 * @param ctx - 提供实时 Session 与 Agent 事件的上下文。
 * @param ownsSession - 根据持久化归属判断 Session 是否属于网关。
 * @param logger - 网关控制台 logger。
 */
export function observeGatewayExecution(ctx: Context, ownsSession: (id: SessionId) => boolean, logger: Logger): void {
  ctx.on('session/event', (session, event) => {
    if (!ownsSession(session.id)) return
    const location = `sessionId=${session.id}`
    switch (event.type) {
      case 'turn/start':
        logger.info(`开始处理 ${location} turn=${event.data.turn}`)
        break
      case 'step/start':
        logger.info(`模型步骤开始 ${location} turn=${event.data.turn} step=${event.data.step}`)
        break
      case 'turn/end': {
        const reason = event.data.reason
        if (reason.kind === 'error') {
          let summary = `执行失败 ${location} turn=${event.data.turn} code=${reason.error.code}`
          if (reason.error.status !== undefined) {
            summary += ` status=${reason.error.status}`
          }
          logger.error(summary, reason.error.message)
        } else {
          logger.info(`处理结束 ${location} turn=${event.data.turn} reason=${reason.kind}`)
        }
        break
      }
      default:
        // Session 事件可由插件扩展；正文和工具数据不进入控制台。
        break
    }
  }, { global: true })
  ctx.on('agent/error', ({ agent, turn, step, error }) => {
    if (!ownsSession(agent.session.id)) return
    logger.error(`Agent 错误 sessionId=${agent.session.id} turn=${turn} step=${step}`, error)
  }, { global: true })
}
