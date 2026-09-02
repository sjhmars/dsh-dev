import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GATEWAY_TOKEN_LENGTH,
  bearerTokenOf,
  hasValidBearerToken,
  loadOrCreateGatewayToken,
} from '../src/token.ts'

const temporaryDirectories: string[] = []

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-external-gateway-'))
  temporaryDirectories.push(directory)
  return join(directory, 'nested', 'gateway.token')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function request(authorization: string | string[] | undefined): IncomingMessage {
  return { headersDistinct: authorization === undefined ? {} : { authorization: Array.isArray(authorization) ? authorization : [authorization] } } as unknown as IncomingMessage
}

describe('loadOrCreateGatewayToken', () => {
  it('generates once and keeps the same token across reloads', async () => {
    const path = await temporaryPath()
    const first = await loadOrCreateGatewayToken(path)
    const second = await loadOrCreateGatewayToken(path)
    expect(first.path).toBe(path)
    expect(first.value).toMatch(new RegExp(`^[a-f0-9]{${String(GATEWAY_TOKEN_LENGTH)}}$`))
    expect(second.value).toBe(first.value)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(await readFile(path, 'utf8')).toBe(`${first.value}\n`)
  })

  it('rejects a token file with the wrong format', async () => {
    const path = await temporaryPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not-a-token\n', { mode: 0o600 })
    await expect(loadOrCreateGatewayToken(path)).rejects.toThrow(/exactly 64 lowercase hexadecimal/iu)
  })
})

describe('bearer authentication', () => {
  it('requires one correctly formatted bearer header and compares it safely', () => {
    const token = 'a'.repeat(GATEWAY_TOKEN_LENGTH)
    expect(bearerTokenOf(request(`Bearer ${token}`))).toBe(token)
    expect(hasValidBearerToken(request(`Bearer ${token}`), token)).toBe(true)
    expect(hasValidBearerToken(request(`Bearer ${'b'.repeat(GATEWAY_TOKEN_LENGTH)}`), token)).toBe(false)
    expect(bearerTokenOf(request([`Bearer ${token}`, `Bearer ${token}`]))).toBeUndefined()
    expect(bearerTokenOf(request(`bearer ${token}`))).toBeUndefined()
    expect(bearerTokenOf(request(undefined))).toBeUndefined()
  })
})
