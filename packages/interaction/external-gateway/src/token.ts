/** External Gateway 仅所有者可访问的持久化 Bearer Token 管理。 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** 已加载的 token 及其脱敏诊断指纹。 */
export interface GatewayToken {
  /** token 文件的绝对路径。 */
  readonly path: string
  /** 仅保存在内存中用于请求校验的原始 Bearer Token。 */
  readonly value: string
  /** SHA-256 摘要的前十二个十六进制字符。 */
  readonly fingerprint: string
}

/** {@link loadOrCreateGatewayToken} 生成的固定格式。 */
export const GATEWAY_TOKEN_BYTES = 32
/** 原始 token 的十六进制字符数。 */
export const GATEWAY_TOKEN_LENGTH = GATEWAY_TOKEN_BYTES * 2

const TOKEN_RE = /^[a-f0-9]{64}$/u

/** 当前平台是否提供 POSIX 权限位。 */
function hasPosixModes(): boolean {
  return process.platform !== 'win32'
}

/** 拒绝非普通文件或非所有者私有目录的路径。 */
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

/** 读取并校验持久化 token 的确切表示。 */
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

/** 生成或加载一个仅所有者可访问的持久化 Bearer Token。 */
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

/** 从 Node HTTP 请求中提取且仅提取一个 Bearer Token。 */
export function bearerTokenOf(request: IncomingMessage): string | undefined {
  const values = request.headersDistinct.authorization
  if (values === undefined || values.length !== 1) return undefined
  const value = values[0]
  if (value === undefined) return undefined
  const match = /^Bearer ([a-f0-9]{64})$/u.exec(value)
  return match?.[1]
}

/** 比较请求 token 与已加载的值，避免提前退出造成计时差异。 */
export function hasValidBearerToken(request: IncomingMessage, expected: string): boolean {
  const actual = bearerTokenOf(request)
  if (actual === undefined) return false
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}
