/** Owner-only persistent bearer-token management for the External Gateway. */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** One loaded token and its redacted diagnostic fingerprint. */
export interface GatewayToken {
  /** Absolute token file path. */
  readonly path: string
  /** Raw bearer token kept in memory for request verification only. */
  readonly value: string
  /** First twelve hexadecimal characters of the SHA-256 digest. */
  readonly fingerprint: string
}

/** The fixed format emitted by {@link loadOrCreateGatewayToken}. */
export const GATEWAY_TOKEN_BYTES = 32
/** The raw token's hexadecimal character count. */
export const GATEWAY_TOKEN_LENGTH = GATEWAY_TOKEN_BYTES * 2

const TOKEN_RE = /^[a-f0-9]{64}$/u

/** Whether the current platform exposes POSIX permission bits. */
function hasPosixModes(): boolean {
  return process.platform !== 'win32'
}

/** Reject a path that is not an ordinary file or an owner-private directory. */
async function assertTokenPath(path: string): Promise<void> {
  const parent = resolve(path, '..')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentStat = await stat(parent)
  if (!parentStat.isDirectory()) throw new Error(`gateway token parent is not a directory: ${parent}`)
  if (hasPosixModes() && (parentStat.mode & 0o077) !== 0) {
    throw new Error(`gateway token parent must be owner-only: ${parent}`)
  }
  try {
    const fileStat = await lstat(path)
    if (fileStat.isSymbolicLink()) throw new Error(`gateway token path must not be a symbolic link: ${path}`)
    if (!fileStat.isFile()) throw new Error(`gateway token path must be a regular file: ${path}`)
    if (hasPosixModes() && (fileStat.mode & 0o077) !== 0) {
      throw new Error(`gateway token file must be owner-only: ${path}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Read and validate the exact persisted token representation. */
async function readToken(path: string): Promise<string> {
  await assertTokenPath(path)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`gateway token disappeared while loading: ${path}`)
    }
    throw error
  }
  const value = text.trim()
  if (!TOKEN_RE.test(value)) {
    throw new Error(`gateway token file must contain exactly ${String(GATEWAY_TOKEN_LENGTH)} lowercase hexadecimal characters`)
  }
  return value
}

/** Generate or load one persistent owner-only bearer token. */
export async function loadOrCreateGatewayToken(configuredPath: string): Promise<GatewayToken> {
  const path = resolve(configuredPath)
  await assertTokenPath(path)
  const value = await withFileLock(path, async () => {
    try {
      return await readToken(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
        && !(error instanceof Error && error.message.includes('disappeared while loading'))) throw error
    }
    const generated = randomBytes(GATEWAY_TOKEN_BYTES).toString('hex')
    await writeFileAtomic(path, `${generated}\n`, { mode: 0o600, dirMode: 0o700 })
    return generated
  }, { waitMs: 10_000 })
  return {
    path,
    value,
    fingerprint: createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12),
  }
}

/** Extract exactly one bearer token from a Node HTTP request. */
export function bearerTokenOf(request: IncomingMessage): string | undefined {
  const values = request.headersDistinct.authorization
  if (values === undefined || values.length !== 1) return undefined
  const value = values[0]
  if (value === undefined) return undefined
  const match = /^Bearer ([a-f0-9]{64})$/u.exec(value)
  return match?.[1]
}

/** Compare one request token to the loaded value without early-exit timing. */
export function hasValidBearerToken(request: IncomingMessage, expected: string): boolean {
  const actual = bearerTokenOf(request)
  if (actual === undefined) return false
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}
