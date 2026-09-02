/**
 * Authenticated, durable `/v1` HTTP gateway for non-browser DSH clients.
 *
 * This package adapts the existing Host Session services and owns protocol parsing, persistence,
 * token loading, and delivery scheduling; it never mounts the browser API.
 * @module @deepseek-ai/dsh-external-gateway
 */

import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ExternalGatewayHttp } from './http.ts'
import { externalGatewayDomainSpec, ExternalGatewayStore } from './storage.ts'
import { loadOrCreateGatewayToken } from './token.ts'
import { ExternalGatewayWorker } from './worker.ts'
import type { ExternalGatewayConfig } from './types.ts'
import { ExternalGatewayHostRuntime } from './host-runtime.ts'
import { MAX_GATEWAY_IMAGE_BYTES, MAX_GATEWAY_UPLOAD_BYTES } from './schema.ts'

export type * from './types.ts'
export {
  gatewayAckSchema,
  gatewayDeliverySchema,
  gatewayEventPayloadSchema,
  gatewayPayloadSchema,
  gatewayRecordSchemas,
  gatewayUploadCompleteSchema,
  gatewayUploadInitSchema,
  gatewayUploadRecordSchema,
  GATEWAY_UPLOAD_CHUNK_BYTES,
  MAX_CONTENT_BLOCKS,
  MAX_GATEWAY_IMAGE_BYTES,
  MAX_GATEWAY_UPLOAD_BYTES,
  MAX_ID_LENGTH,
  MAX_QUESTION_ANSWERS,
  MAX_TEXT_LENGTH,
  MAX_UPLOAD_FILENAME_BYTES,
  opaqueStringSchema,
  safeIntegerSchema,
  sessionIdSchema,
} from './schema.ts'
export { GatewayClientId, GatewayDeliveryId, GatewayEventId, GatewayInteractionId, GatewayUploadId } from './brand.ts'
export {
  externalGatewayDomainSpec,
  ExternalGatewayStore,
  ExternalGatewayStoreError,
  canonicalJson,
  dispatchRequestOf,
  sanitizeGatewayFilename,
} from './storage.ts'
export type {
  AcceptedGatewayDelivery,
  ExternalGatewayDomain,
  ExternalGatewayPeer,
  ExternalGatewayStoreErrorCode,
  ExternalGatewayStoreOptions,
  GatewayAckResult,
  GatewayEventPage,
  GatewayUploadCompletionResult,
  GatewayUploadPartResult,
} from './storage.ts'
export { ExternalGatewayWorker } from './worker.ts'
export type { ExternalGatewayWorkerOptions, ExternalGatewayWorkerState } from './worker.ts'
export { ExternalGatewayHttp, HttpInputError } from './http.ts'
export type { ExternalGatewayHttpCarrier, ExternalGatewayHttpOptions, GatewayHttpError } from './http.ts'
export { loadOrCreateGatewayToken, bearerTokenOf, hasValidBearerToken } from './token.ts'
export type { GatewayToken } from './token.ts'
export { GatewaySessionRuntime, GatewaySessionRuntimeError } from './session-runtime.ts'
export { ExternalGatewayHostRuntime, ExternalGatewayHostRuntimeError } from './host-runtime.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable external protocol service. */
    externalGateway: ExternalGatewayService
  }
}

/** External Gateway service configuration. */
export type Config = Omit<ExternalGatewayConfig, 'startupCwd'> & { readonly startupCwd: string }

const DEFAULT_MAX_BODY_BYTES = 2_000_000
const DEFAULT_MAX_TEXT_BYTES = 1_000_000
const DEFAULT_MAX_EVENTS = 100
const DEFAULT_MAX_POLL_MS = 30_000
const DEFAULT_COMPLETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_MAX_OUTBOX = 10_000
const DEFAULT_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_STARTUP_CWD = process.cwd()
const DEFAULT_TOKEN_FILE = join(resolveDshHome(), 'profiles', 'external-gateway', 'weixin-mouth.token')
const DEFAULT_ARTIFACT_DIRECTORY = join(resolveDshHome(), 'profiles', 'external-gateway', 'artifacts')

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`external gateway ${name} must be a positive safe integer`)
  return value
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`external gateway ${name} must be a non-negative safe integer`)
  return value
}

/**
 * Cordis service mounting the durable store, worker, token verifier, and
 * loopback HTTP routes.
 */
export class ExternalGatewayService extends Service {
  /** Required Host capabilities reused from the Web Host assembly. */
  static inject = [
    'agents', 'commands', 'permissionPresets', 'sessionController',
    'sessionSkillCatalog', 'storageDomain', 'subagents', 'webServer',
  ]

  /** Validated deployment configuration. */
  static Config: z<Config> = z.object({
    tokenFile: z.string().min(1).default(DEFAULT_TOKEN_FILE),
    artifactDirectory: z.string().min(1).default(DEFAULT_ARTIFACT_DIRECTORY),
    clientId: z.string().min(1).default('weixin-mouth'),
    accountIds: z.array(z.string()).default([]),
    peerIds: z.array(z.string()).default([]),
    maxBodyBytes: z.natural().min(1).default(DEFAULT_MAX_BODY_BYTES),
    maxTextBytes: z.natural().min(1).default(DEFAULT_MAX_TEXT_BYTES),
    maxEvents: z.natural().min(1).default(DEFAULT_MAX_EVENTS),
    maxPollMs: z.natural().default(DEFAULT_MAX_POLL_MS),
    completedRetentionMs: z.natural().default(DEFAULT_COMPLETED_RETENTION_MS),
    maxOutbox: z.natural().min(1).default(DEFAULT_MAX_OUTBOX),
    interactionTimeoutMs: z.natural().min(1).default(DEFAULT_INTERACTION_TIMEOUT_MS),
    maxUploadBytes: z.natural().min(1).default(MAX_GATEWAY_UPLOAD_BYTES),
    maxImageBytes: z.natural().min(1).default(MAX_GATEWAY_IMAGE_BYTES),
    startupCwd: z.string().min(1).default(DEFAULT_STARTUP_CWD),
  })

  private store: ExternalGatewayStore | undefined
  private tokenPath: string | undefined
  private disposeRoutes: (() => void) | undefined

  /**
   * @param ctx - Cordis context containing the Web Host capability assembly.
   * @param config - Validated External Gateway policy.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'externalGateway')
  }

  /** Loaded token file path, available for diagnostics without revealing its value. */
  get loadedTokenPath(): string | undefined {
    return this.tokenPath
  }

  /** Durable store mounted by this service after initialization. */
  get gatewayStore(): ExternalGatewayStore | undefined {
    return this.store
  }

  /** Start protocol routes after the durable domain and Host adapter are ready. */
  protected async [Service.init](): Promise<void> {
    const startupCwd = resolve(this.config.startupCwd)
    const domain = await this.ctx.storageDomain.open(externalGatewayDomainSpec)
    try {
      const store = new ExternalGatewayStore({
        domain,
        fixedCwd: startupCwd,
        artifactDirectory: this.config.artifactDirectory,
        completedRetentionMs: nonNegativeSafeInteger(this.config.completedRetentionMs, 'completedRetentionMs'),
        maxOutbox: positiveSafeInteger(this.config.maxOutbox, 'maxOutbox'),
        maxUploadBytes: positiveSafeInteger(this.config.maxUploadBytes, 'maxUploadBytes'),
        maxImageBytes: positiveSafeInteger(this.config.maxImageBytes, 'maxImageBytes'),
      })
      const runtime = new ExternalGatewayHostRuntime(
        this.ctx,
        store,
        startupCwd,
        positiveSafeInteger(this.config.interactionTimeoutMs, 'interactionTimeoutMs'),
      )
      const token = await loadOrCreateGatewayToken(this.config.tokenFile)
      const worker = new ExternalGatewayWorker({
        store,
        runtime,
        startupCwd,
        onError: error => this.ctx.logger.error(error instanceof Error ? error : new Error(String(error))),
      })
      const http = new ExternalGatewayHttp({
        carrier: this.ctx.webServer,
        store,
        worker,
        runtime,
        token: token.value,
        config: this.config,
      })
      this.store = store
      this.tokenPath = token.path
      this.disposeRoutes = http.register()
      await worker.start()
      this.ctx.effect(() => async () => {
        this.disposeRoutes?.()
        this.disposeRoutes = undefined
        await worker.close()
        this.store = undefined
        this.tokenPath = undefined
        await domain.close()
      }, 'externalGateway')
    } catch (error) {
      await domain.close()
      throw error
    }
  }
}

/** Cordis plugin name. */
export const name = 'external-gateway'

/** Required service names for plugin activation. */
export const inject = ExternalGatewayService.inject

export default ExternalGatewayService
