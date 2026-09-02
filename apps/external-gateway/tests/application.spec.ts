import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

interface ApplicationDescription {
  readonly name: string
  readonly profile: string
  readonly launcher: readonly string[]
  readonly listener: {
    readonly host: string
    readonly port: number
    readonly protocol: string
  }
  readonly owns: readonly string[]
  readonly delegates: {
    readonly 'protocol-runtime': string
    readonly 'profile-patch': string
  }
  readonly smoke: {
    readonly health: string
    readonly 'browser-routes': string
    readonly 'network-bind': string
  }
}

const appRoot = resolve(import.meta.dirname, '..')

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(appRoot, name), 'utf8')) as T
}

describe('external-gateway application home', () => {
  it('has no executable and describes the shipped profile entry', () => {
    const manifest = readJson<{ bin?: unknown; files?: readonly string[] }>('package.json')
    const description = readJson<ApplicationDescription>('application.json')

    expect(manifest.bin).toBeUndefined()
    expect(manifest.files).toEqual(['application.json'])
    expect(description).toMatchObject({
      name: 'external-gateway',
      profile: 'external-gateway',
      launcher: ['dsh', '--profile', 'external-gateway'],
      listener: { host: '127.0.0.1', port: 18765, protocol: '/v1' },
      delegates: {
        'protocol-runtime': '@deepseek-ai/dsh-external-gateway',
        'profile-patch': '@deepseek-ai/dsh-external-gateway-app',
      },
      smoke: {
        health: '/healthz',
        'browser-routes': 'unreachable',
        'network-bind': 'loopback-only',
      },
    })
  })

  it('keeps the application description aligned with the dsh profile template', () => {
    const description = readJson<ApplicationDescription>('application.json')
    expect(PROFILE_TEMPLATES[description.profile]).toEqual({
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        '@deepseek-ai/dsh-external-gateway-app',
      ],
      patchReload: 'startup',
    })
  })
})
