import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ApiSessionNotFound } from '@deepseek-ai/dsh-api-session-controller'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as brandSessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentCatalog,
  SubagentPromptReceipt,
} from '@deepseek-ai/dsh-subagent'
import type { PromptContentPart, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  GatewaySessionRuntime,
  GatewaySessionRuntimeError,
  type GatewayPeer,
  type GatewaySessionOwnership,
  type GatewaySessionServices,
} from '../src/session-runtime.ts'

const fixedCwd = resolve('gateway-workspace')
const peer: GatewayPeer = { clientId: 'weixin-mouth', accountId: 'account', peerId: 'peer' }
const otherPeer: GatewayPeer = { clientId: 'weixin-mouth', accountId: 'account', peerId: 'other-peer' }
const signal = new AbortController().signal

interface CreateArguments {
  readonly sessionId: SessionId
  readonly cwd: string
  readonly agentPreset?: string
}

interface ForkArguments {
  readonly sessionId: SessionId
  readonly atSeq?: number
}

interface SessionLocation extends SessionHeader {
  readonly isUngrouped: boolean
}

interface Harness {
  readonly runtime: GatewaySessionRuntime
  readonly controller: {
    readonly create: ReturnType<typeof vi.fn>
    readonly inspect: ReturnType<typeof vi.fn>
    readonly selectModel: ReturnType<typeof vi.fn>
    readonly rename: ReturnType<typeof vi.fn>
    readonly fork: ReturnType<typeof vi.fn>
    readonly prompt: ReturnType<typeof vi.fn>
    readonly cancel: ReturnType<typeof vi.fn>
    readonly resolveAgent: ReturnType<typeof vi.fn>
  }
  readonly commands: { readonly execute: ReturnType<typeof vi.fn> }
  readonly permission: { readonly set: ReturnType<typeof vi.fn> }
  readonly skills: { readonly list: ReturnType<typeof vi.fn> }
  readonly subagents: {
    readonly remoteExportList: ReturnType<typeof vi.fn>
    readonly prompt: ReturnType<typeof vi.fn>
    readonly interruptByParent: ReturnType<typeof vi.fn>
  }
  readonly ownership: GatewaySessionOwnership
  readonly locations: Map<SessionId, SessionLocation>
  readonly agents: Map<SessionId, Agent>
  readonly interactions: Set<string>
}

function header(sessionId: SessionId, cwd = fixedCwd, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id: sessionId, createdAt: 1, cwd, ...extra }
}

function agentFor(sessionId: SessionId, location: SessionHeader): Agent {
  const session = { id: sessionId, header: location, events: [] } as unknown as Session
  return { id: sessionId, session } as unknown as Agent
}

function keyOf(value: GatewayPeer): string {
  return `${value.clientId}\u0000${value.accountId}\u0000${value.peerId}`
}

function interactionKey(value: GatewayPeer, sessionId: SessionId, interactionId: string, kind: string): string {
  return `${keyOf(value)}\u0000${sessionId}\u0000${kind}\u0000${interactionId}`
}

function harness(options: {
  readonly forkUngrouped?: boolean
  readonly interactionOwnership?: boolean
} = {}): Harness {
  const locations = new Map<SessionId, SessionLocation>()
  const agents = new Map<SessionId, Agent>()
  const owners = new Map<SessionId, string>()
  const active = new Map<string, SessionId>()
  const ungrouped = new Map<SessionId, boolean>()
  const interactions = new Set<string>()
  let createFailure: Error | undefined

  const addSession = (sessionId: SessionId, location: SessionLocation): void => {
    locations.set(sessionId, location)
    ungrouped.set(sessionId, location.isUngrouped)
    agents.set(sessionId, agentFor(sessionId, location))
  }

  const controller = {
    create: vi.fn(async (request: CreateArguments) => {
      if (createFailure !== undefined) {
        const failure = createFailure
        createFailure = undefined
        throw failure
      }
      const location = {
        ...header(request.sessionId, request.cwd, request.agentPreset === undefined
          ? {}
          : { agentPreset: request.agentPreset }),
        isUngrouped: true,
      }
      addSession(request.sessionId, location)
      return {
        sessionId: request.sessionId,
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
      }
    }),
    inspect: vi.fn(async (sessionId: SessionId) => {
      const location = locations.get(sessionId)
      if (location === undefined) {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      return { meta: location, events: [] }
    }),
    selectModel: vi.fn(async (request: {
      readonly sessionId: SessionId
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: string
    }) => ({
      selected: {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      },
    })),
    rename: vi.fn(async (request: { readonly title: string }) => ({ title: request.title, seq: 3 })),
    fork: vi.fn(async (request: ForkArguments) => {
      const childSessionId = brandSessionId(`${request.sessionId}-fork`)
      const source = locations.get(request.sessionId)
      const location = {
        ...header(childSessionId, source?.cwd ?? fixedCwd, { parentSession: request.sessionId }),
        isUngrouped: options.forkUngrouped ?? true,
      }
      addSession(childSessionId, location)
      return { sessionId: childSessionId }
    }),
    prompt: vi.fn(async () => ({ accepted: true as const })),
    cancel: vi.fn(async () => ({ accepted: true as const })),
    resolveAgent: vi.fn(async (sessionId: SessionId) => {
      const agent = agents.get(sessionId)
      return agent === undefined
        ? { error: new Error(`missing agent ${sessionId}`) }
        : { agent }
    }),
  }
  const commands = {
    execute: vi.fn(async (): Promise<CommandExecution> => ({
      commandId: 'command-id' as CommandExecution['commandId'],
      result: { kind: 'success', text: 'done' },
    })),
  }
  const permission = { set: vi.fn() }
  const skills = { list: vi.fn(async () => ({ skills: [] })) }
  const catalog: SubagentCatalog = { entries: [], parentAvailable: true }
  const subagents = {
    remoteExportList: vi.fn(async (): Promise<SubagentCatalog> => catalog),
    prompt: vi.fn(async (): Promise<SubagentPromptReceipt> => ({
      messageId: 'message-id' as SubagentPromptReceipt['messageId'],
    })),
    interruptByParent: vi.fn(async () => ({ accepted: true as const })),
  }
  const ownership: GatewaySessionOwnership = {
    ownsSession: vi.fn(async (value: GatewayPeer, sessionId: SessionId) => owners.get(sessionId) === keyOf(value)),
    claimSession: vi.fn(async (value: GatewayPeer, sessionId: SessionId) => {
      const existing = owners.get(sessionId)
      if (existing === undefined) {
        owners.set(sessionId, keyOf(value))
        return true
      }
      return existing === keyOf(value)
    }),
    activeSession: vi.fn(async (value: GatewayPeer) => active.get(keyOf(value))),
    setActiveSession: vi.fn(async (value: GatewayPeer, sessionId: SessionId | undefined) => {
      if (sessionId === undefined) active.delete(keyOf(value))
      else active.set(keyOf(value), sessionId)
    }),
    isUngrouped: vi.fn(async (_value: GatewayPeer, sessionId: SessionId) => ungrouped.get(sessionId) === true),
    ownsSubagent: vi.fn(async (
      value: GatewayPeer,
      parentSessionId: SessionId,
      childSessionId: SessionId,
    ) => owners.get(childSessionId) === keyOf(value)
      && locations.get(childSessionId)?.parentSession === parentSessionId
      && locations.get(childSessionId)?.origin === 'subagent'),
    ...(options.interactionOwnership === false ? {} : {
      ownsInteraction: vi.fn(async (value: GatewayPeer, sessionId: SessionId, interactionId: string, kind: string) => interactions.has(
        interactionKey(value, sessionId, interactionId, kind),
      )),
    }),
  }
  const services: GatewaySessionServices = {
    sessionController: controller as GatewaySessionServices['sessionController'],
    commands,
    permissionPresets: permission,
    skills,
    subagents: subagents as GatewaySessionServices['subagents'],
  }
  const runtime = new GatewaySessionRuntime({ services, ownership, fixedCwd })
  return {
    runtime,
    controller,
    commands,
    permission,
    skills,
    subagents,
    ownership,
    locations,
    agents,
    interactions,
  }
}

function requestId(value: string): SessionRequestId {
  return value as SessionRequestId
}

describe('GatewaySessionRuntime', () => {
  it('keeps a pre-created ownership reservation when Host creation fails', async () => {
    const h = harness()
    const sessionId = brandSessionId('retryable-session')
    h.controller.create.mockRejectedValueOnce(new Error('Host unavailable'))

    await expect(h.runtime.create(peer, { sessionId })).rejects.toThrow('Host unavailable')
    expect(h.ownership.claimSession).toHaveBeenCalledWith(peer, sessionId)
    await expect(h.ownership.ownsSession(peer, sessionId)).resolves.toBe(true)
    expect(h.ownership.setActiveSession).not.toHaveBeenCalled()

    await expect(h.runtime.create(peer, { sessionId })).resolves.toEqual({ sessionId })
    expect(h.controller.create).toHaveBeenLastCalledWith({ sessionId, cwd: fixedCwd })
    expect(h.ownership.setActiveSession).toHaveBeenLastCalledWith(peer, sessionId)
  })

  it('does not adopt a Host Session that has no matching peer reservation', async () => {
    const h = harness()
    const existing = brandSessionId('local-web-session')
    h.locations.set(existing, { ...header(existing), isUngrouped: true })

    await expect(h.runtime.create(peer, { sessionId: existing })).rejects.toMatchObject({
      code: 'session-reservation-failed',
    })
    expect(h.controller.create).not.toHaveBeenCalled()
  })

  it('rejects location fields and enforces fixed cwd plus ungrouped Sessions', async () => {
    const h = harness()
    await expect(h.runtime.create(peer, {
      cwd: 'outside',
    } as unknown as Parameters<GatewaySessionRuntime['create']>[1])).rejects.toMatchObject({
      code: 'invalid-location',
    })

    const sessionId = (await h.runtime.create(peer, {})).sessionId
    const location = h.locations.get(sessionId)
    if (location === undefined) throw new Error('test Session was not created')
    h.locations.set(sessionId, { ...location, cwd: resolve('other-workspace') })
    await expect(h.runtime.select(peer, { sessionId })).rejects.toMatchObject({
      code: 'session-location-invalid',
    })

    const forkHarness = harness({ forkUngrouped: false })
    const source = (await forkHarness.runtime.create(peer, {})).sessionId
    await expect(forkHarness.runtime.fork(peer, { sessionId: source })).rejects.toMatchObject({
      code: 'session-location-invalid',
    })
  })

  it('routes model, permission, prompt, command, cancel and skill operations', async () => {
    const h = harness()
    const sessionId = (await h.runtime.create(peer, { agentPreset: 'default' })).sessionId
    const content: PromptContentPart[] = [{ type: 'text', text: 'hello' }]

    await expect(h.runtime.selectModel(peer, {
      sessionId, provider: 'deepseek', model: 'chat', reasoningEffort: 'high',
    })).resolves.toEqual({
      selected: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' },
    })
    await expect(h.runtime.setPermission(peer, { sessionId, preset: 'workspace-write' }))
      .resolves.toEqual({ sessionId, preset: 'workspace-write' })
    expect(h.permission.set).toHaveBeenCalledWith(h.agents.get(sessionId)?.session, 'workspace-write')

    await expect(h.runtime.rename(peer, { sessionId, title: 'Renamed' })).resolves.toEqual({ title: 'Renamed', seq: 3 })
    await expect(h.runtime.message(peer, {
      sessionId, requestId: requestId('request-1'), mode: 'queue', content,
    }, signal)).resolves.toEqual({ accepted: true })
    expect(h.controller.prompt).toHaveBeenCalledWith({
      sessionId, requestId: requestId('request-1'), mode: 'queue', content,
    }, signal)

    await expect(h.runtime.command(peer, { sessionId, line: '/plan inspect' }, signal))
      .resolves.toMatchObject({ result: { kind: 'success', text: 'done' } })
    expect(h.commands.execute).toHaveBeenCalledWith(h.agents.get(sessionId), '/plan inspect', [], signal)
    await expect(h.runtime.command(peer, { sessionId, line: '/settings' }, signal)).rejects.toMatchObject({
      code: 'command-not-allowed',
    })
    expect(h.commands.execute).toHaveBeenCalledTimes(1)

    await expect(h.runtime.cancel(peer, sessionId)).resolves.toEqual({ accepted: true })
    await expect(h.runtime.listSkills(peer, sessionId, signal)).resolves.toEqual({ skills: [] })
    expect(h.skills.list).toHaveBeenCalledWith({ sessionId }, signal)
  })

  it('auto-creates an active Session for a message without a target', async () => {
    const h = harness()
    await expect(h.runtime.message(peer, {
      requestId: requestId('auto-request'), content: [{ type: 'text', text: 'hello' }],
    }, signal)).resolves.toEqual({ accepted: true })

    const active = await h.ownership.activeSession(peer)
    expect(active).toBeDefined()
    expect(h.controller.prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: active, mode: 'queue', requestId: requestId('auto-request'),
    }), signal)
  })

  it('does not create a Session when a command has no active target', async () => {
    const h = harness()
    await expect(h.runtime.command(peer, { line: '/plan inspect' }, signal)).rejects.toMatchObject({
      code: 'session-not-owned',
    })
    expect(h.controller.create).not.toHaveBeenCalled()
    expect(h.commands.execute).not.toHaveBeenCalled()
  })

  it('keeps Session operations peer-scoped and activates fork results', async () => {
    const h = harness()
    const sessionId = (await h.runtime.create(peer, {})).sessionId
    await expect(h.runtime.select(otherPeer, { sessionId })).rejects.toMatchObject({ code: 'session-not-owned' })
    await expect(h.runtime.rename(otherPeer, { sessionId, title: 'nope' })).rejects.toMatchObject({ code: 'session-not-owned' })

    const forked = await h.runtime.fork(peer, { sessionId, atSeq: 4 })
    expect(forked.sessionId).toBe(brandSessionId(`${sessionId}-fork`))
    await expect(h.ownership.activeSession(peer)).resolves.toBe(forked.sessionId)
    expect(h.controller.fork).toHaveBeenCalledWith({ sessionId, atSeq: 4 })
  })

  it('checks direct subagent ownership before follow-up and interrupt', async () => {
    const h = harness()
    const parentSessionId = (await h.runtime.create(peer, {})).sessionId
    const childSessionId = brandSessionId('subagent-child')
    h.locations.set(childSessionId, {
      ...header(childSessionId, fixedCwd, { parentSession: parentSessionId, origin: 'subagent' }),
      isUngrouped: true,
    })
    await h.ownership.claimSession(peer, childSessionId)
    const content: ContentBlock[] = []

    await expect(h.runtime.listSubagents(peer, parentSessionId, signal)).resolves.toEqual({
      entries: [], parentAvailable: true,
    })
    await expect(h.runtime.followupSubagent(peer, {
      parentSessionId, childSessionId, requestId: requestId('subagent-request'), content,
    }, signal)).resolves.toEqual({ messageId: 'message-id' })
    expect(h.subagents.prompt).toHaveBeenCalledWith({
      parentSessionId, childSessionId, requestId: requestId('subagent-request'), mode: 'continuable', content,
    }, signal)
    await expect(h.runtime.interruptSubagent(peer, { parentSessionId, childSessionId }))
      .resolves.toEqual({ accepted: true })
    expect(h.subagents.interruptByParent).toHaveBeenCalledWith(childSessionId, parentSessionId, 'continuable')

    const foreignChild = brandSessionId('foreign-child')
    h.locations.set(foreignChild, {
      ...header(foreignChild, fixedCwd, { parentSession: parentSessionId, origin: 'subagent' }),
      isUngrouped: true,
    })
    await expect(h.runtime.interruptSubagent(peer, {
      parentSessionId, childSessionId: foreignChild,
    })).rejects.toMatchObject({ code: 'subagent-not-owned' })
  })

  it('requires live interaction ownership and rejects subagent Agents as roots', async () => {
    const h = harness()
    const sessionId = (await h.runtime.create(peer, {})).sessionId
    const questionId = 'question-1'
    const approvalId = 'approval-1'
    h.interactions.add(interactionKey(peer, sessionId, questionId, 'question'))
    h.interactions.add(interactionKey(peer, sessionId, approvalId, 'approval'))

    await expect(h.runtime.assertQuestionScope(peer, {
      sessionId, interactionId: questionId, answer: { answers: [] },
    })).resolves.toBeUndefined()
    await expect(h.runtime.assertApprovalScope(peer, {
      sessionId, interactionId: approvalId, outcome: 'rejected',
    })).resolves.toBeUndefined()
    await expect(h.runtime.assertQuestionScope(peer, {
      sessionId, interactionId: 'expired', answer: { answers: [] },
    })).rejects.toMatchObject({ code: 'interaction-not-owned' })

    const root = h.agents.get(sessionId)
    if (root === undefined) throw new Error('test Agent was not created')
    await expect(h.runtime.ownsRootInteractionAgent(peer, sessionId, root)).resolves.toBe(true)
    const childSessionId = brandSessionId('root-check-child')
    const child = agentFor(childSessionId, header(childSessionId, fixedCwd, { origin: 'subagent' }))
    await expect(h.runtime.ownsRootInteractionAgent(peer, sessionId, child)).resolves.toBe(false)

    const unavailable = harness({ interactionOwnership: false })
    const unavailableSessionId = (await unavailable.runtime.create(peer, {})).sessionId
    await expect(unavailable.runtime.assertQuestionScope(peer, {
      sessionId: unavailableSessionId, interactionId: questionId, answer: { answers: [] },
    })).rejects.toMatchObject({ code: 'interaction-scope-unavailable' })
  })

  it('reports ownership failures with stable runtime error codes', async () => {
    const h = harness()
    const unknown = brandSessionId('unknown')
    await expect(h.runtime.select(peer, { sessionId: unknown })).rejects.toBeInstanceOf(GatewaySessionRuntimeError)
    await expect(h.runtime.select(peer, { sessionId: unknown })).rejects.toMatchObject({
      code: 'session-not-owned', details: { sessionId: unknown },
    })
  })
})
