/**
 * The desktop-startup row: provides `desktopRuntime` — the desktop carrier's
 * bind-free facts (built frontend dist index). No flags, no server bind:
 * the Electron main process already owns the window lifecycle.
 * @module @deepseek-ai/dsh-desktop-app/startup
 */

import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'

export const name = 'desktop-startup'

/** Runtime service key the desktop rows and the app's IPC wiring read. */
export const DESKTOP_RUNTIME_SERVICE = 'desktopRuntime'

/** Bind-free desktop facts provided before the runtime row mounts. */
export interface DesktopRuntimeValues {
  /** Absolute path of the built frontend index.html. */
  distIndex: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopRuntime?: DesktopRuntimeValues
  }
}

/** Dist location is workspace knowledge of this bundle: resolved through the frontend package exports, not configured. */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  } catch {
    /* v8 ignore next 2 -- reachable only on a checkout without a built dist; the test tree builds it */
    throw new Error('desktop-app: frontend dist not built; run pnpm run build from the repository root first')
  }
}

/**
 * Provide the desktop runtime facts.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.provide(DESKTOP_RUNTIME_SERVICE, { distIndex: resolveDistIndex() } satisfies DesktopRuntimeValues)
}
