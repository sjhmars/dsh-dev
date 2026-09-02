import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { ExternalGatewayHttp, type ExternalGatewayHttpCarrier } from '../src/http.ts'
import { externalGatewayDomainSpec, ExternalGatewayStore } from '../src/storage.ts'
import { ExternalGatewayWorker } from '../src/worker.ts'
import type { ExternalGatewayConfig, ExternalGatewayRuntime } from '../src/types.ts'

const TOKEN = 'ab'.repeat(32)

interface Harness {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  const domain = await facility.open(externalGatewayDomainSpec)
  const store = new ExternalGatewayStore({ domain, fixedCwd: 'gateway-cwd' })
  const runtime: ExternalGatewayRuntime = {
    startupCwd: 'gateway-cwd',
    dispatch: async request => ({ sessionId: request.reservedSessionId, result: { accepted: true } }),
    query: async () => ({ kind: 'json', value: {} }),
    subscribe: () => () => {},
    replay: async () => {},
  }
  const worker = new ExternalGatewayWorker({ store, runtime, startupCwd: 'gateway-cwd' })
  const routes: Array<Parameters<ExternalGatewayHttpCarrier['register']>[0]> = []
  const carrier: ExternalGatewayHttpCarrier = {
    register: route => {
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
    maxBodyBytes: 32_768,
    maxTextBytes: 8_192,
    maxEvents: 20,
    maxPollMs: 50,
    completedRetentionMs: 1_000,
    maxOutbox: 100,
    interactionTimeoutMs: 1_000,
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
    void Promise.resolve(route.handler(request, response)).catch(error => {
      response.writeHead(500).end(String(error))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      dispose()
      await worker.close()
      server.close()
      await once(server, 'close')
      await domain.close()
      await backend.close()
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

describe('ExternalGatewayHttp', () => {
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
