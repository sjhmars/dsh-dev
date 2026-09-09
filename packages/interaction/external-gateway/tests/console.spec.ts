import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installGatewayConsole, observeGatewayExecution } from '../src/console.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('gateway console', () => {
  it('prints owned session progress and provider failures without message bodies', async () => {
    const output: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('gateway-console'))
    const foreign = ctx.sessions.create(SessionId('foreign-console'))
    const logger = installGatewayConsole(ctx, { enabled: true, maxChars: 2000 })
    observeGatewayExecution(ctx, id => id === session.id, logger)
    try {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: {
        kind: 'error', error: { code: 'AUTH', message: 'HTTP 401 api_key=secret-value', status: 401 },
      } })
      foreign.append('turn/start', { turn: 1 })
      logger.error('后台任务失败', new Error('Bearer hidden-token\nHTTP 401'))
      const text = output.join('')
      expect(text).toContain('开始处理 sessionId=gateway-console turn=1')
      expect(text).toContain('模型步骤开始')
      expect(text).toContain('执行失败')
      expect(text).toContain('code=AUTH')
      expect(text).toContain('HTTP 401')
      expect(text).not.toContain('secret-value')
      expect(text).not.toContain('hidden-token')
      expect(text).not.toContain('foreign-console')
      output.length = 0
      await ctx.fiber.dispose()
      logger.info('disposed')
      expect(output).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('supports disabled output and ignores unrelated logger namespaces', async () => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const ctx = new Context()
    try {
      const disabled = installGatewayConsole(ctx, { enabled: false, maxChars: 100 })
      disabled.info('disabled')
      expect(output).not.toHaveBeenCalled()
      installGatewayConsole(ctx, { enabled: true, maxChars: 100 })
      ctx.logger('other-plugin').error('private data')
      expect(output).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('redacts URLs and token patterns and bounds each log body', async () => {
    const output: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const ctx = new Context()
    try {
      const logger = installGatewayConsole(ctx, { enabled: true, maxChars: 120 })
      logger.error('https://host/path?token=private sk-testsecret ' + 'ab'.repeat(32))
      expect(output.join('')).not.toContain('private')
      expect(output.join('')).not.toContain('sk-testsecret')
      expect(output.join('')).not.toContain('ab'.repeat(32))
      logger.info('x'.repeat(500))
      expect(output.at(-1)).toMatch(/x{120}\n$/u)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
