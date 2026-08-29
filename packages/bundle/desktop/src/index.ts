/**
 * @deepseek-ai/dsh-desktop-app — the desktop runtime row: model-visible
 * orientation plus the shell variable naming this surface's mode. The
 * desktop carrier itself is transport-only (the Electron app owns the IPC
 * wiring), so this row owns what the model and shells need to know: that
 * this session runs under the desktop client, with no local HTTP surface.
 * It also mounts the desktop profile's directory picker — Electron's OS
 * chooser — as `ctx.directoryPicker`, replacing the web row's adaptive
 * chooser (which needs a webserver to resolve its interaction).
 * @module @deepseek-ai/dsh-desktop-app
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-system-prompt'
import DesktopDirectoryPicker from './picker.ts'

export const name = 'desktop-app'

/** Services required before the desktop runtime can mount. */
export const inject = ['desktopRuntime']

/** Plugin config: composed deployment settings. */
export interface Config {
  /**
   * Register the model-visible surface context (the `app:desktop-surface`
   * prompt section and the `DSH_WEB_MODE` shell variable).
   */
  surfaceContext: boolean
}

export const Config: z<Config> = z.object({
  surfaceContext: z.boolean().default(true),
})

/** Environment variable naming this surface's mode for shells under the session. */
const DSH_WEB_MODE = 'DSH_WEB_MODE' as const

/** Model-visible orientation for sessions created through the desktop client. */
function desktopSurfacePrompt(): string {
  return 'You are interacting with the user through the DeepSeek Harness desktop client. '
    + 'When the user refers to "this window", "this client", or "this app" without naming another target, they mean this desktop client. '
    + 'There is no local HTTP server: the window communicates with the host through an in-process bridge, so no other page can reach this session. '
    + 'Changes to the client require rebuilding it (`pnpm run desktop:dev`) and relaunching the window.'
}

/**
 * Mount the desktop runtime: the surface prompt section, the shell variable,
 * and the Electron directory picker service. No server, no URL, no static
 * serving — the Electron main process owns the renderer channel end to end.
 * @param ctx - plugin context carrying desktopRuntime.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // The picker replaces the web profile's adaptive chooser row (which reads
  // the webserver bind to resolve its interaction and cannot activate here).
  ctx.plugin(DesktopDirectoryPicker)
  if (!config.surfaceContext) return
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'app:desktop-surface',
      order: -98,
      text: () => desktopSurfacePrompt(),
    })
  })
  ctx.inject(['shellEnv'], (runtimeCtx) => {
    runtimeCtx.shellEnv.register({
      name: 'desktop-runtime',
      variables: {
        [DSH_WEB_MODE]: { description: 'Surface mode of the DeepSeek Harness client serving this session.' },
      },
      resolve: () => ({ [DSH_WEB_MODE]: 'desktop' }),
    })
  })
}
