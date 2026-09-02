import { describe, expect, it } from 'vitest'
import {
  gatewayDeliverySchema,
  gatewayEventPayloadSchema,
  gatewayPayloadSchema,
  gatewaySessionOwnershipSchema,
  gatewayUploadInitSchema,
} from '../src/schema.ts'

describe('External Gateway wire schemas', () => {
  it('rejects unknown fields, including location and client identity fields', () => {
    expect(() => gatewayDeliverySchema.parse({
      deliveryId: 'delivery',
      accountId: 'account',
      peerId: 'peer',
      clientId: 'spoofed',
      payload: { type: 'message', content: [{ type: 'text', text: 'hello' }] },
    })).toThrow()
    expect(() => gatewayPayloadSchema.parse({ type: 'session-create', sessionId: 'client-chosen' })).toThrow()
    expect(() => gatewayPayloadSchema.parse({
      type: 'message',
      cwd: 'outside-gateway',
      content: [{ type: 'text', text: 'hello' }],
    })).toThrow()
  })

  it('accepts supported mutations and restores opaque Session id branding', () => {
    const parsed = gatewayDeliverySchema.parse({
      deliveryId: 'delivery',
      accountId: 'account',
      peerId: 'peer',
      payload: {
        type: 'model-select',
        sessionId: 'session-1',
        selection: { provider: 'deepseek', model: 'reasoner' },
      },
    })
    expect(parsed.payload.type).toBe('model-select')
    expect(parsed.payload.sessionId).toBe('session-1')
  })

  it('accepts encoded images and rejects the removed attachment-reference format', () => {
    expect(gatewayPayloadSchema.parse({
      type: 'message',
      content: [{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'image.png' }],
    })).toMatchObject({ type: 'message' })
    expect(() => gatewayPayloadSchema.parse({
      type: 'message',
      content: [{ type: 'attachment', artifactId: 'artifact-1' }],
    })).toThrow()
  })

  it('carries plan-review presentation intent and resumable upload metadata', () => {
    const parsed = gatewayPayloadSchema.parse({
      type: 'message',
      content: [{ type: 'upload', uploadId: 'upload-1' }],
    })
    expect(parsed).toMatchObject({ content: [{ type: 'upload', uploadId: 'upload-1' }] })
    const init = gatewayUploadInitSchema.parse({
      accountId: 'account',
      peerId: 'peer',
      kind: 'file',
      filename: '../plan.md',
      contentType: 'text/markdown',
      size: 4_194_304,
    })
    expect(init.kind).toBe('file')
    expect(gatewayEventPayloadSchema.parse({
      type: 'question',
      sessionId: 'session-1',
      interactionId: 'interaction',
      expiresAt: 600_000,
      questions: [{
        id: 'question-1',
        question: 'Review the plan?',
        detail: '# Plan',
        options: [{ label: 'Approve' }, { label: 'Decline' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })).toMatchObject({ questions: [{ intent: { kind: 'plan-review', approve: 'Approve' } }] })
  })

  it('keeps durable ownership status aligned with the schema', () => {
    expect(gatewaySessionOwnershipSchema.parse({
      clientId: 'client',
      accountId: 'account',
      peerId: 'peer',
      sessionId: 'session-1',
      cwd: 'gateway-cwd',
      createdAt: 1,
      status: 'pending',
      active: false,
    }).status).toBe('pending')
  })
})
