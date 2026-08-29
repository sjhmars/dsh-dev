import { defineConfig } from 'tsdown'

/**
 * The Electron main/preload bundle: ESM output under lib/electron (the
 * package.json main), electron pinned external (provided by the runtime),
 * everything else inlined into main.js / preload.mjs. The preload stays an
 * .mjs so Electron loads it as an ESM preload (sandbox must be off), which
 * the entryFileNames mapping pins (tsdown would otherwise append .js to the
 * keyed name).
 */
export default defineConfig({
  entry: {
    'electron/main': 'electron/main.ts',
    'electron/preload': 'electron/preload.mts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: ['electron'],
  outputOptions: {
    entryFileNames: (chunk) => {
      const name = (chunk as { name?: string }).name
      return name === 'electron/preload' ? 'electron/preload.mjs' : '[name].js'
    },
  },
})