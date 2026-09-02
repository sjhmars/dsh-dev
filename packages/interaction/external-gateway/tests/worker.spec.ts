import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { GatewayClientId, GatewayDeliveryId } from '../src/brand.ts'
import { externalGatewayDomainSpec, ExternalGatewayStore } from '../src/storage.ts'
import { ExternalGatewayWorker } from '../src/worker.ts'
import type { ExternalGatewayRuntime, GatewayDelivery } from '../src/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

const client = GatewayClientId('worker-client')
const account = 'account'
const peer = 'peer'

interface Harness {
  readonly store: ExternalGatewayStore
  readonly close: () => Promise<void>
}

async function openStore(maxOutbox?: number): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend()
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  const domain = await facility.open(externalGatewayDomainSpec)
  return {
    store: new ExternalGatewayStore({ domain, fixedCwd: 'gateway-cwd', ...(maxOutbox === undefined ? {} : { maxOutbox }) }),
    close: async () => { await domain.close(); await backend.close() },
  }
}

function createDelivery(id: string): GatewayDelivery {
  return {
    deliveryId: GatewayDeliveryId(id),
    accountId: account,
    peerId: peer,
    payload: { type: 'session-create' },
  }
}

function runtime(dispatch: ExternalGatewayRuntime['dispatch']): ExternalGatewayRuntime {
  return {
    startupCwd: 'gateway-cwd',
    dispatch,
    query: async () => ({ kind: 'json', value: {} }),
    subscribe: () => () => {},
    replay: async () => {},
  }
}

describe('ExternalGatewayWorker', () => {
  it('replays Session events once and persists the projection cursor', async () => {
    const harness = await openStore()
    const event = {
      clientId: client,
      accountId: account,
      peerId: peer,
      sessionId: SessionId('session-replay'),
      sourceSequence: 7,
      payload: { type: 'turn-failed' as const, sessionId: SessionId('session-replay'), message: 'failed' },
    }
    const makeRuntime = (): ExternalGatewayRuntime => {
      let listener: ((value: typeof event) => Promise<void>) | undefined
      return {
        startupCwd: 'gateway-cwd',
        dispatch: async () => ({}),
        query: async () => ({ kind: 'json', value: {} }),
        subscribe: next => { listener = next; return () => { listener = undefined } },
        replay: async () => { if (listener !== undefined) await listener(event) },
      }
    }
    const first = new ExternalGatewayWorker({ store: harness.store, runtime: makeRuntime(), startupCwd: 'gateway-cwd' })
    await first.start()
    await first.close()
    const second = new ExternalGatewayWorker({ store: harness.store, runtime: makeRuntime(), startupCwd: 'gateway-cwd' })
    try {
      await second.start()
      expect(harness.store.listEvents(client, 0, 10).events).toHaveLength(1)
      expect(harness.store.projectedSequence(event.sessionId)).toBe(7)
    } finally {
      await second.close()
      await harness.close()
    }
  })

  it('persists completion and mutation events before completing the inbox row', async () => {
    const harness = await openStore()
    const dispatch = vi.fn(async request => ({
      sessionId: request.reservedSessionId ?? SessionId('runtime-session'),
      result: { accepted: true },
    }))
    const worker = new ExternalGatewayWorker({ store: harness.store, runtime: runtime(dispatch), startupCwd: 'gateway-cwd' })
    try {
      const accepted = await harness.store.acceptDelivery(client, createDelivery('create'))
      await worker.start()
      await vi.waitFor(() => expect(harness.store.getDelivery(client, accepted.record.deliveryId)?.status).toBe('completed'))
      expect(harness.store.listEvents(client, 0, 10).events.map(event => event.payload.type))
        .toEqual(['delivery-completed', 'session-created'])
      expect(dispatch).toHaveBeenCalledOnce()
    } finally {
      await worker.close()
      await harness.close()
    }
  })

  it('keeps a delivery pending when shutdown aborts an in-flight dispatch', async () => {
    const harness = await openStore()
    const dispatch = vi.fn((_request, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('dispatch aborted')), { once: true })
    }))
    const worker = new ExternalGatewayWorker({ store: harness.store, runtime: runtime(dispatch), startupCwd: 'gateway-cwd' })
    const accepted = await harness.store.acceptDelivery(client, createDelivery('pending'))
    await worker.start()
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
    await worker.close()
    try {
      expect(harness.store.getDelivery(client, accepted.record.deliveryId)).toMatchObject({ status: 'pending', attempts: 1 })
    } finally {
      await harness.close()
    }
  })

  it('emits a durable failure before marking a dispatch failed', async () => {
    const harness = await openStore()
    const dispatch = vi.fn(async () => { throw new Error('runtime unavailable') })
    const worker = new ExternalGatewayWorker({ store: harness.store, runtime: runtime(dispatch), startupCwd: 'gateway-cwd' })
    try {
      const accepted = await harness.store.acceptDelivery(client, createDelivery('failed'))
      await worker.start()
      await vi.waitFor(() => expect(harness.store.getDelivery(client, accepted.record.deliveryId)?.status).toBe('failed'))
      expect(harness.store.listEvents(client, 0, 10).events.map(event => event.payload.type)).toEqual(['delivery-failed'])
    } finally {
      await worker.close()
      await harness.close()
    }
  })

  it('resumes a pending delivery after acknowledgement frees outbox capacity', async () => {
    const harness = await openStore(2)
    const dispatch = vi.fn(async request => ({
      sessionId: request.reservedSessionId ?? SessionId('runtime-session'),
      result: { accepted: true },
    }))
    const worker = new ExternalGatewayWorker({ store: harness.store, runtime: runtime(dispatch), startupCwd: 'gateway-cwd' })
    try {
      await harness.store.appendEvent(client, { accountId: account, peerId: peer }, {
        type: 'turn-failed',
        sessionId: SessionId('older-session'),
        message: 'older event',
      })
      const accepted = await harness.store.acceptDelivery(client, createDelivery('backpressure'))
      await worker.start()
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(harness.store.getDelivery(client, accepted.record.deliveryId)?.status).toBe('pending'))
      expect(harness.store.listEvents(client, 0, 10).events).toHaveLength(2)
      await harness.store.acknowledge(client, 2)
      await worker.resumePending()
      await vi.waitFor(() => expect(harness.store.getDelivery(client, accepted.record.deliveryId)?.status).toBe('completed'))
      expect(dispatch).toHaveBeenCalledTimes(2)
    } finally {
      await worker.close()
      await harness.close()
    }
  })
})
