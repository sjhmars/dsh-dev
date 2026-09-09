import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { ExternalGatewayHttp, type ExternalGatewayHttpCarrier } from '../src/http.ts'
import { GATEWAY_UPLOAD_CHUNK_BYTES, MAX_GATEWAY_IMAGE_BYTES, MAX_GATEWAY_UPLOAD_BYTES } from '../src/schema.ts'
import { externalGatewayDomainSpec, ExternalGatewayStore } from '../src/storage.ts'
import { ExternalGatewayWorker } from '../src/worker.ts'
import type { ExternalGatewayConfig, ExternalGatewayRuntime } from '../src/types.ts'

const TOKEN = 'ab'.repeat(32)

interface Harness {
  readonly baseUrl: string
  readonly unmount: () => void
  readonly close: () => Promise<void>
}

async function harness(
  maxBodyBytes = 32_768,
  query: ExternalGatewayRuntime['query'] = async () => ({ kind: 'json', value: {} }),
): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-gateway-http-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  const domain = await facility.open(externalGatewayDomainSpec)
  const store = new ExternalGatewayStore({ domain, fixedCwd: cwd })
  const runtime: ExternalGatewayRuntime = {
    startupCwd: cwd,
    dispatch: async request => ({
      ...(request.reservedSessionId === undefined ? {} : { sessionId: request.reservedSessionId }),
      result: { accepted: true },
    }),
    query,
    subscribe: () => () => {},
    replay: async () => {},
  }
  const worker = new ExternalGatewayWorker({ store, runtime, startupCwd: cwd })
  const routes: Array<Parameters<ExternalGatewayHttpCarrier['register']>[0]> = []
  const carrier: ExternalGatewayHttpCarrier = {
    register: (route) => {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  }
  const config: ExternalGatewayConfig = {
    tokenFile: 'unused',
    artifactDirectory: 'unused',
    clientId: 'weixin-mouth',
    accountIds: ['account'],
    peerIds: ['peer'],
    maxBodyBytes,
    maxTextBytes: 8_192,
    maxEvents: 20,
    maxPollMs: 50,
    completedRetentionMs: 1_000,
    maxOutbox: 100,
    interactionTimeoutMs: 1_000,
    maxUploadBytes: MAX_GATEWAY_UPLOAD_BYTES,
    maxImageBytes: MAX_GATEWAY_IMAGE_BYTES,
  }
  const http = new ExternalGatewayHttp({ carrier, store, worker, runtime, token: TOKEN, config })
  const dispose = http.register()
  await worker.start()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://gateway').pathname
    const route = routes.find(candidate => candidate.kind === 'exact'
      ? candidate.path === path
      : path === candidate.path || path.startsWith(`${candidate.path}/`))
    if (route === undefined) {
      response.writeHead(404).end()
      return
    }
    void Promise.resolve(route.handler(request, response)).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    unmount: dispose,
    close: async () => {
      dispose()
      await worker.close()
      server.close()
      await once(server, 'close')
      await domain.close()
      await backend.close()
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

const open: Harness[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map(item => item.close()))
})

function auth(): HeadersInit {
  return { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
}

// 使用真实 HTTP 分块传输，不让 fetch 自动补充 Content-Length。
async function sendBody(
  url: string,
  method: 'POST' | 'PUT',
  chunks: readonly Buffer[],
  length?: number,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': method === 'PUT' ? 'application/octet-stream' : 'application/json',
        ...(length === undefined ? { 'transfer-encoding': 'chunked' } : { 'content-length': length }),
      },
    }, (response) => {
      const parts: Buffer[] = []
      response.on('data', (chunk: Buffer) => parts.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown })
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    outgoing.on('error', reject)
    for (const chunk of chunks) outgoing.write(chunk)
    outgoing.end()
  })
}

describe('ExternalGatewayHttp', () => {
  it('统一适配层保留长轮询与确认的响应字段', async () => {
    const app = await harness(); open.push(app)
    const events = await fetch(`${app.baseUrl}/v1/events?after=0&limit=1&waitMs=0`, { headers: auth() })
    expect(events.status).toBe(200)
    expect(await events.json()).toEqual({ events: [], nextSequence: 0 })
    const ack = await fetch(`${app.baseUrl}/v1/events/ack`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ upToSequence: 0 }),
    })
    expect(ack.status).toBe(200)
    expect(await ack.json()).toEqual({ upToSequence: 0, removed: 0 })
  })

  it.each(['after=-1', 'after=1.5', 'limit=21', 'waitMs=51'])('统一协议解析拒绝非法查询 %s', async (query) => {
    const app = await harness(); open.push(app)
    const response = await fetch(`${app.baseUrl}/v1/events?${query}`, { headers: auth() })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_query' })
  })

  it('上传响应使用公开 DTO，不暴露存储路径和归属记录', async () => {
    const app = await harness(); open.push(app)
    const init = await fetch(`${app.baseUrl}/v1/uploads`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        uploadId: 'dto-upload', accountId: 'account', peerId: 'peer', kind: 'file',
        filename: 'a.txt', contentType: 'text/plain', size: 1,
      }),
    })
    const receipt: unknown = await init.json()
    expect(init.status).toBe(201)
    expect(receipt).toEqual({
      uploadId: 'dto-upload', status: 'pending', kind: 'file', filename: 'a.txt',
      contentType: 'text/plain', size: 1, chunkSize: GATEWAY_UPLOAD_CHUNK_BYTES,
      totalParts: 1, receivedParts: [], content: { type: 'upload', uploadId: 'dto-upload' },
    })
    const list = await fetch(`${app.baseUrl}/v1/uploads?accountId=account&peerId=peer`, { headers: auth() })
    expect(await list.json()).toEqual({ uploads: [receipt] })
  })

  it('分离的查询控制器保留身份、JSON 和文件响应', async () => {
    const query = vi.fn<ExternalGatewayRuntime['query']>(async request => request.operation === 'artifact'
      ? { kind: 'bytes', body: Buffer.from('exported'), contentType: 'text/plain', filename: 'session.txt' }
      : { kind: 'json', value: { sessions: [] } })
    const app = await harness(32_768, query); open.push(app)
    const response = await fetch(`${app.baseUrl}/v1/sessions?accountId=account&peerId=peer`, { headers: auth() })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessions: [] })
    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'weixin-mouth', accountId: 'account', peerId: 'peer', operation: 'sessions',
    }), expect.any(AbortSignal))
    const artifact = await fetch(`${app.baseUrl}/v1/artifacts/export-1?accountId=account&peerId=peer`, { headers: auth() })
    expect(artifact.status).toBe(200)
    expect(artifact.headers.get('content-disposition')).toBe('attachment; filename="session.txt"')
    expect(await artifact.text()).toBe('exported')
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'artifact', artifactId: 'export-1' }), expect.any(AbortSignal))
    query.mockClear()
    const denied = await fetch(`${app.baseUrl}/v1/artifacts/export-1?accountId=account&peerId=other`, { headers: auth() })
    expect(denied.status).toBe(403)
    expect(query).not.toHaveBeenCalled()
  })

  it('卸载时移除全部控制器路由，重复释放无副作用', async () => {
    const app = await harness(); open.push(app)
    app.unmount()
    app.unmount()
    for (const path of ['/healthz', '/v1/deliveries', '/v1/events', '/v1/events/ack', '/v1/uploads', '/v1/uploads/id', '/v1/sessions', '/v1/artifacts/id']) {
      expect((await fetch(`${app.baseUrl}${path}`, { headers: auth() })).status).toBe(404)
    }
  })

  it.each(['/v1/deliveries', '/v1/events/ack', '/v1/uploads'])('拒绝 %s 的空正文和非法 JSON', async (path) => {
    const app = await harness(); open.push(app)
    for (const body of ['', '{']) {
      const result = await sendBody(`${app.baseUrl}${path}`, 'POST', [Buffer.from(body)])
      expect(result).toMatchObject({ status: 400, body: { error: 'invalid_json' } })
    }
  })

  it.each([false, true])('JSON 超限返回 413，后续请求仍可处理；声明长度=%s', async (declared) => {
    const app = await harness(64); open.push(app)
    const chunks = [Buffer.alloc(32, ' '), Buffer.alloc(33, ' ')]
    const result = await sendBody(`${app.baseUrl}/v1/deliveries`, 'POST', chunks, declared ? 65 : undefined)
    expect(result).toMatchObject({ status: 413, body: { error: 'body_too_large' } })
    expect((await fetch(`${app.baseUrl}/healthz`)).status).toBe(200)
  })

  it.each([0, -1])('按 UTF-8 字节限制消息，分块可截断中文编码；预算偏移=%s', async (offset) => {
    const bytes = Buffer.from(JSON.stringify({
      deliveryId: 'utf8', accountId: 'account', peerId: 'peer',
      payload: { type: 'message', content: [{ type: 'text', text: '中文' }] },
    }))
    const app = await harness(bytes.length + offset); open.push(app)
    const split = bytes.indexOf(Buffer.from('中')) + 1
    const result = await sendBody(`${app.baseUrl}/v1/deliveries`, 'POST', [bytes.subarray(0, split), bytes.subarray(split)])
    expect(result.status).toBe(offset === 0 ? 202 : 413)
    if (offset !== 0) expect(result.body).toMatchObject({ error: 'body_too_large' })
  })

  it.each([false, true])('上传分块支持完整 4 MiB，超限返回专用错误；声明长度=%s', async (declared) => {
    const app = await harness(); open.push(app)
    const init = await fetch(`${app.baseUrl}/v1/uploads`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        uploadId: 'binary', accountId: 'account', peerId: 'peer',
        kind: 'file', filename: 'binary.dat', contentType: 'application/octet-stream', size: GATEWAY_UPLOAD_CHUNK_BYTES,
      }),
    })
    expect(init.status).toBe(201)
    const url = `${app.baseUrl}/v1/uploads/binary/parts/0?accountId=account&peerId=peer`
    const bytes = Buffer.alloc(GATEWAY_UPLOAD_CHUNK_BYTES, 0x80)
    const accepted = await sendBody(url, 'PUT', [bytes], declared ? bytes.length : undefined)
    expect(accepted.status).toBe(200)
    const rejected = await sendBody(url, 'PUT', [bytes, Buffer.from([0])], declared ? bytes.length + 1 : undefined)
    expect(rejected).toMatchObject({ status: 413, body: { error: 'upload_part_too_large' } })
  })

  it.each([false, true])('上传完成允许空正文，但拒绝非法和超限 JSON；声明长度=%s', async (declared) => {
    const app = await harness(); open.push(app)
    const init = await fetch(`${app.baseUrl}/v1/uploads`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        uploadId: 'optional', accountId: 'account', peerId: 'peer',
        kind: 'file', filename: 'small.bin', contentType: 'application/octet-stream', size: 3,
      }),
    })
    expect(init.status).toBe(201)
    const address = '?accountId=account&peerId=peer'
    expect((await sendBody(`${app.baseUrl}/v1/uploads/optional/parts/0${address}`, 'PUT', [Buffer.from([0, 128, 255])])).status).toBe(200)
    const url = `${app.baseUrl}/v1/uploads/optional/complete${address}`
    expect(await sendBody(url, 'POST', [Buffer.from('{')])).toMatchObject({ status: 400, body: { error: 'invalid_json' } })
    expect(await sendBody(url, 'POST', [Buffer.alloc(32_769, ' ')])).toMatchObject({ status: 413, body: { error: 'body_too_large' } })
    expect((await sendBody(url, 'POST', [], declared ? 0 : undefined)).status).toBe(200)
    const downloaded = await fetch(`${app.baseUrl}/v1/uploads/optional/content${address}`, { headers: auth() })
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(Buffer.from([0, 128, 255]))
  })

  it('keeps health public and rejects missing machine authentication', async () => {
    const app = await harness(); open.push(app)
    expect(await (await fetch(`${app.baseUrl}/healthz`)).json()).toEqual({ status: 'ok' })
    const response = await fetch(`${app.baseUrl}/v1/events?after=0&waitMs=0&limit=1`)
    expect(response.status).toBe(401)
  })

  it('admits, deduplicates, and conflicts durable deliveries', async () => {
    const app = await harness(); open.push(app)
    const body = {
      deliveryId: 'delivery-1', accountId: 'account', peerId: 'peer',
      payload: { type: 'message', content: [{ type: 'text', text: 'hello' }] },
    }
    const first = await fetch(`${app.baseUrl}/v1/deliveries`, { method: 'POST', headers: auth(), body: JSON.stringify(body) })
    expect(first.status).toBe(202)
    const duplicate = await fetch(`${app.baseUrl}/v1/deliveries`, { method: 'POST', headers: auth(), body: JSON.stringify(body) })
    expect(duplicate.status).toBe(200)
    const conflict = await fetch(`${app.baseUrl}/v1/deliveries`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ ...body, payload: { type: 'session-create' } }),
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'delivery_conflict' })
  })

  it('enforces peer allowlists and hides unowned Session ids', async () => {
    const app = await harness(); open.push(app)
    const forbidden = await fetch(`${app.baseUrl}/v1/deliveries`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        deliveryId: 'delivery-2', accountId: 'account', peerId: 'other', payload: { type: 'session-create' },
      }),
    })
    expect(forbidden.status).toBe(403)
    const hidden = await fetch(`${app.baseUrl}/v1/sessions/guessed?accountId=account&peerId=peer`, { headers: auth() })
    expect(hidden.status).toBe(404)
  })
})
