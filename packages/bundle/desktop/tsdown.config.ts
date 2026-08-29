import { defineConfig } from 'tsdown'

/**
 * Host bundle over the root workspace layout: same entries, with `electron`
 * pinned external. electron is a devDependency (types only), and tsdown
 * bundles devDependencies by default — inlining the electron shim would
 * break the lazy `import('electron')` the picker relies on at runtime.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/startup.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: ['electron'],
})