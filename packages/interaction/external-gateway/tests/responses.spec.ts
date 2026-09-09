import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { GatewayClientId, GatewayDeliveryId, GatewayEventId } from '../src/brand.ts'
import { eventsResponse } from '../src/protocol/responses.ts'
import type { GatewayOutboxRecord } from '../src/types.ts'

function eventRecord(): GatewayOutboxRecord {
  return {
    clientId: GatewayClientId('weixin-mouth'),
    sequence: 12,
    eventId: GatewayEventId('event-12'),
    accountId: 'account',
    peerId: 'peer',
    payload: { type: 'delivery-completed', deliveryId: GatewayDeliveryId('delivery-1') },
    createdAt: 1000,
    acknowledged: false,
  }
}

describe('event response fields', () => {
  it('omits absent optional fields and storage-only state without changing the input', () => {
    const record = Object.freeze(eventRecord())
    const response = eventsResponse({ events: [record], nextSequence: 12 })
    expect(response.nextSequence).toBe(12)
    expect(response.events).toEqual([{
      clientId: 'weixin-mouth',
      sequence: 12,
      eventId: 'event-12',
      accountId: 'account',
      peerId: 'peer',
      payload: { type: 'delivery-completed', deliveryId: 'delivery-1' },
      createdAt: 1000,
    }])
    expect(response.events[0]).not.toHaveProperty('sessionId')
    expect(response.events[0]).not.toHaveProperty('causedByDeliveryId')
    expect(response.events[0]).not.toHaveProperty('acknowledged')
    expect(record.acknowledged).toBe(false)
  })

  it('preserves present session and delivery references', () => {
    const record: GatewayOutboxRecord = {
      ...eventRecord(),
      sessionId: SessionId('session-1'),
      causedByDeliveryId: GatewayDeliveryId('delivery-1'),
    }
    const response = eventsResponse({ events: [record], nextSequence: 12 })
    expect(response.events[0]).toMatchObject({
      sessionId: 'session-1',
      causedByDeliveryId: 'delivery-1',
    })
    expect(response.events[0]).not.toBe(record)
  })
})
