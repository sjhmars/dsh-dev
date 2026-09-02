import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import {
  ExternalGatewayStore,
  ExternalGatewayStoreError,
  externalGatewayDomainSpec,
} from '../src/storage.ts'
import { GatewayClientId, GatewayDeliveryId } from '../src/brand.ts'
import { MAX_GATEWAY_IMAGE_BYTES, MAX_GATEWAY_UPLOAD_BYTES } from '../src/schema.ts'
import type { GatewayDelivery, GatewayPeerIdentity } from '../src/types.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

const client = GatewayClientId('test-client')
const peer: GatewayPeerIdentity = { clientId: client, accountId: 'account', peerId: 'peer' }
const otherPeer: GatewayPeerIdentity = { clientId: client, accountId: 'account', peerId: 'other-peer' }

interface Harness {
  readonly store: ExternalGatewayStore
  readonly domain: Awaited<ReturnType<DomainFacility['open']>>
  readonly backend: MemoryStorageBackend
}

async function openStore(
  pool = new MemoryMediaPool(),
  options: { readonly maxOutbox?: number; readonly uploadDirectory?: string; readonly fixedCwd?: string } = {},
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  const domain = await facility.open(externalGatewayDomainSpec)
  return {
    store: new ExternalGatewayStore({ domain, ...options, fixedCwd: options.fixedCwd ?? 'gateway-cwd' }),
    domain,
    backend,
  }
}

async function closeStore(harness: Harness): Promise<void> {
  await harness.domain.close()
  await harness.backend.close()
}

function messageDelivery(id: string, message = 'hello'): GatewayDelivery {
  return {
    deliveryId: GatewayDeliveryId(id),
    accountId: 'account',
    peerId: 'peer',
    payload: { type: 'message', content: [{ type: 'text', text: message }] },
  }
}

function createDelivery(id: string): GatewayDelivery {
  return {
    deliveryId: GatewayDeliveryId(id),
    accountId: 'account',
    peerId: 'peer',
    payload: { type: 'session-create' },
  }
}

describe('ExternalGatewayStore inbox', () => {
  it('deduplicates an identical delivery and rejects a content conflict', async () => {
    const harness = await openStore()
    try {
      const first = await harness.store.acceptDelivery(client, messageDelivery('one'))
      const replay = await harness.store.acceptDelivery(client, messageDelivery('one'))
      expect(first.duplicate).toBe(false)
      expect(replay).toMatchObject({ duplicate: true, record: { deliveryId: 'one', status: 'pending' } })
      await expect(harness.store.acceptDelivery(client, messageDelivery('one', 'different')))
        .rejects.toMatchObject({ code: 'delivery-conflict' })
    } finally {
      await closeStore(harness)
    }
  })

  it('reserves a create id in the inbox before ownership and reuses it after a crash', async () => {
    const pool = new MemoryMediaPool()
    let writes = 0
    pool.consumeInjectedFailure = () => {
      writes += 1
      if (writes === 3) {
        pool.consumeInjectedFailure = () => {}
        throw new Error('simulated ownership write crash')
      }
    }
    const first = await openStore(pool)
    const delivery = await first.store.acceptDelivery(client, createDelivery('create-one'))
    await expect(first.store.reserveSessionForDelivery(client, delivery.record.deliveryId)).rejects.toThrow('simulated ownership write crash')
    const reserved = first.store.getDelivery(client, delivery.record.deliveryId)
    expect(reserved?.reservedSessionId).toBeDefined()
    const reservedId = reserved?.reservedSessionId
    await closeStore(first)

    const second = await openStore(pool)
    try {
      const retried = await second.store.reserveSessionForDelivery(client, delivery.record.deliveryId)
      expect(retried.sessionId).toBe(reservedId)
      expect(second.store.ownsSession(peer, reservedId as SessionId)).toBe(true)
    } finally {
      await closeStore(second)
    }
  })

  it('always allocates a fresh Session for session-create while auto messages reuse active', async () => {
    const harness = await openStore()
    try {
      const first = await harness.store.acceptDelivery(client, createDelivery('create-one'))
      const firstReserved = await harness.store.reserveSessionForDelivery(client, first.record.deliveryId)
      const second = await harness.store.acceptDelivery(client, createDelivery('create-two'))
      const secondReserved = await harness.store.reserveSessionForDelivery(client, second.record.deliveryId)
      expect(secondReserved.sessionId).not.toBe(firstReserved.sessionId)

      const message = await harness.store.acceptDelivery(client, messageDelivery('message-one'))
      const messageReserved = await harness.store.reserveSessionForDelivery(client, message.record.deliveryId)
      expect(messageReserved.sessionId).toBe(secondReserved.sessionId)
    } finally {
      await closeStore(harness)
    }
  })

  it('applies backlog admission inside the serialized mutation queue', async () => {
    const harness = await openStore(new MemoryMediaPool(), { maxOutbox: 1 })
    try {
      await harness.store.appendEvent(client, peer, { type: 'turn-failed', sessionId: SessionId('session-1'), message: 'pending' })
      const result = await Promise.allSettled([
        harness.store.acceptDelivery(client, messageDelivery('one')),
        harness.store.acceptDelivery(client, messageDelivery('two')),
      ])
      expect(result.every(item => item.status === 'rejected')).toBe(true)
      expect(result.map(item => item.status === 'rejected' && (item.reason as ExternalGatewayStoreError).code))
        .toEqual(['outbox-backpressure', 'outbox-backpressure'])
    } finally {
      await closeStore(harness)
    }
  })
})

describe('ExternalGatewayStore ownership and outbox', () => {
  it('does not let another peer select or observe a Session', async () => {
    const harness = await openStore()
    try {
      const sessionId = SessionId('owned-session')
      await expect(harness.store.claimSession(peer, sessionId)).resolves.toBe(true)
      expect(harness.store.ownsSession(peer, sessionId)).toBe(true)
      expect(harness.store.ownsSession(otherPeer, sessionId)).toBe(false)
      expect(harness.store.listSessions(otherPeer)).toEqual([])
      await expect(harness.store.setActiveSession(otherPeer, sessionId)).rejects.toMatchObject({ code: 'session-not-owned' })
      expect(harness.store.ownerOfSession(sessionId)).toEqual(peer)
    } finally {
      await closeStore(harness)
    }
  })

  it('recovers a sequence when outbox is durable but client state was not written', async () => {
    const pool = new MemoryMediaPool()
    let writes = 0
    pool.consumeInjectedFailure = () => {
      writes += 1
      if (writes === 2) {
        pool.consumeInjectedFailure = () => {}
        throw new Error('simulated client cursor crash')
      }
    }
    const first = await openStore(pool)
    await expect(first.store.appendEvent(client, peer, {
      type: 'turn-failed', sessionId: SessionId('session-1'), message: 'durable event',
    })).rejects.toThrow('simulated client cursor crash')
    await closeStore(first)

    const second = await openStore(pool)
    try {
      expect(second.store.listEvents(client, 0, 10).events).toHaveLength(1)
      await expect(second.store.acknowledge(client, 1)).resolves.toMatchObject({ upToSequence: 1, removed: 1 })
      expect(second.store.listEvents(client, 0, 10).events).toEqual([])
    } finally {
      await closeStore(second)
    }
  })

  it('ignores and cleans rows left behind after an acknowledged cursor commit', async () => {
    const harness = await openStore()
    try {
      await harness.store.appendEvent(client, peer, {
        type: 'turn-failed', sessionId: SessionId('session-1'), message: 'acknowledged',
      })
      const clients = harness.domain.table('clients')
      await clients.put(JSON.stringify(client), { clientId: client, nextSequence: 2, acknowledgedSequence: 1 })
      expect(harness.store.countOutstanding(client)).toBe(0)
      expect(harness.store.listEvents(client, 0, 10).events).toEqual([])
      await expect(harness.store.acknowledge(client, 1)).resolves.toMatchObject({ removed: 1 })
      expect([...harness.domain.table('outbox').entries()]).toHaveLength(0)
    } finally {
      await closeStore(harness)
    }
  })

  it('waits for a new event and rejects a second concurrent poll', async () => {
    const harness = await openStore()
    try {
      const waiting = harness.store.waitForEvents(client, 0, 10, 500)
      await expect(harness.store.waitForEvents(client, 0, 10, 100)).rejects.toMatchObject({ code: 'poll-in-progress' })
      await harness.store.appendEvent(client, peer, {
        type: 'turn-failed', sessionId: SessionId('session-1'), message: 'wake',
      })
      await expect(waiting).resolves.toMatchObject({ events: [{ sequence: 1 }] })
    } finally {
      await closeStore(harness)
    }
  })
})

describe('ExternalGatewayStore uploads', () => {
  it('applies separate image and file upload limits before accepting metadata', async () => {
    const harness = await openStore()
    try {
      await expect(harness.store.createUpload(client, {
        accountId: 'account', peerId: 'peer', kind: 'image', filename: 'large.png',
        contentType: 'image/png', size: MAX_GATEWAY_IMAGE_BYTES + 1,
      })).rejects.toMatchObject({ code: 'upload-too-large', details: { maxBytes: MAX_GATEWAY_IMAGE_BYTES } })
      await expect(harness.store.createUpload(client, {
        accountId: 'account', peerId: 'peer', kind: 'file', filename: 'large.bin',
        contentType: 'application/octet-stream', size: MAX_GATEWAY_UPLOAD_BYTES + 1,
      })).rejects.toMatchObject({ code: 'upload-too-large', details: { maxBytes: MAX_GATEWAY_UPLOAD_BYTES } })
    } finally {
      await closeStore(harness)
    }
  })

  it('persists fixed-size parts, makes retries idempotent, and enforces owner scope', async () => {
    const uploadDirectory = await mkdtemp(join(tmpdir(), 'dsh-external-gateway-'))
    const harness = await openStore(new MemoryMediaPool(), { uploadDirectory })
    try {
      const firstBytes = Buffer.alloc(4 * 1024 * 1024, 7)
      const lastBytes = Buffer.from('ok')
      const whole = Buffer.concat([firstBytes, lastBytes])
      const digest = createHash('sha256').update(whole).digest('hex')
      const started = await harness.store.createUpload(client, {
        accountId: 'account',
        peerId: 'peer',
        kind: 'file',
        filename: 'CON.txt',
        contentType: 'text/plain',
        size: whole.byteLength,
        sha256: digest,
      })
      expect(started.record.filename).toBe('_CON.txt')
      expect(started.record.totalParts).toBe(2)
      const first = await harness.store.putUploadPart(peer, started.record.uploadId, 0, firstBytes)
      expect(first.duplicate).toBe(false)
      await expect(harness.store.putUploadPart(peer, started.record.uploadId, 0, Buffer.alloc(firstBytes.byteLength, 8)))
        .rejects.toMatchObject({ code: 'upload-part-conflict' })
      await expect(harness.store.putUploadPart(otherPeer, started.record.uploadId, 0, firstBytes))
        .rejects.toMatchObject({ code: 'upload-not-found' })
      const retry = await harness.store.putUploadPart(peer, started.record.uploadId, 0, firstBytes)
      expect(retry.duplicate).toBe(true)
      await expect(harness.store.completeUpload(peer, started.record.uploadId)).rejects.toMatchObject({ code: 'upload-incomplete' })
      await harness.store.putUploadPart(peer, started.record.uploadId, 1, lastBytes)
      const completed = await harness.store.completeUpload(peer, started.record.uploadId)
      expect(completed.record.status).toBe('completed')
      expect(completed.record.sha256).toBe(digest)
      await expect(harness.store.readUpload(peer, started.record.uploadId)).resolves.toMatchObject({ bytes: whole })
      await expect(harness.store.completeUpload(peer, started.record.uploadId)).resolves.toMatchObject({ record: { status: 'completed' } })
    } finally {
      await closeStore(harness)
      await rm(uploadDirectory, { recursive: true, force: true })
    }
  })

  it('copies completed files into the receiving Session inbox under the fixed cwd', async () => {
    const fixedCwd = await mkdtemp(join(tmpdir(), 'dsh-external-gateway-cwd-'))
    const uploadDirectory = await mkdtemp(join(tmpdir(), 'dsh-external-gateway-upload-'))
    const harness = await openStore(new MemoryMediaPool(), { fixedCwd, uploadDirectory })
    try {
      const bytes = Buffer.from('gateway inbox')
      const started = await harness.store.createUpload(client, {
        accountId: 'account',
        peerId: 'peer',
        kind: 'file',
        filename: '../report.txt',
        contentType: 'text/plain',
        size: bytes.byteLength,
      })
      await harness.store.putUploadPart(peer, started.record.uploadId, 0, bytes)
      await harness.store.completeUpload(peer, started.record.uploadId)
      const path = await harness.store.materializeUploadFile(peer, started.record.uploadId, SessionId('session-inbox'))
      expect(path).toContain(join('.dsh-external-gateway', 'inbox', 'session-inbox'))
      await expect(readFile(path, 'utf8')).resolves.toBe('gateway inbox')
    } finally {
      await closeStore(harness)
      await rm(fixedCwd, { recursive: true, force: true })
      await rm(uploadDirectory, { recursive: true, force: true })
    }
  })
})
