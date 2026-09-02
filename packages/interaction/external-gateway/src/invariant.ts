/** Package-owned invariant companion for the External Gateway. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-external-gateway'

/** Cordis companion plugin name. */
export const name = 'external-gateway-invariant'
/** The invariant registry must be available before registration. */
export const inject = ['invariants']

/**
 * The storage-domain schemas and sequence checks are executed at their owning
 * durable boundary; this package has no second mutable event stream to audit.
 */
const install: InvariantInstaller = (_ctx: Context) => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

