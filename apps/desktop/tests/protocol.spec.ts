import { describe, expect, it } from 'vitest'
import { resolveDistPath, resolvePluginBundle } from '../electron/protocol.ts'

const distRoot = 'H:\\app\\dist'
const distIndex = 'H:\\app\\dist\\index.html'

describe('resolveDistPath', () => {
  it('maps the root and the index file to the index document', () => {
    expect(resolveDistPath(distRoot, distIndex, '/')).toEqual({ kind: 'index' })
    expect(resolveDistPath(distRoot, distIndex, '')).toEqual({ kind: 'index' })
    expect(resolveDistPath(distRoot, distIndex, '/index.html')).toEqual({ kind: 'index' })
  })

  it('maps assets inside the dist root', () => {
    expect(resolveDistPath(distRoot, distIndex, '/assets/app.js')).toEqual({
      kind: 'asset',
      path: 'H:\\app\\dist\\assets\\app.js',
    })
  })

  it('rejects traversal outside the dist root', () => {
    expect(resolveDistPath(distRoot, distIndex, '/../package.json')).toEqual({ kind: 'forbidden' })
    expect(resolveDistPath(distRoot, distIndex, '/..%2f..%2fpackage.json')).toEqual({ kind: 'forbidden' })
  })

  it('rejects malformed percent-encoding', () => {
    expect(resolveDistPath(distRoot, distIndex, '/%')).toEqual({ kind: 'bad' })
    expect(resolveDistPath(distRoot, distIndex, '/a%ZZ')).toEqual({ kind: 'bad' })
  })
})

describe('resolvePluginBundle', () => {
  it('classifies bundle and source-map requests, keeping scoped ids intact', () => {
    expect(resolvePluginBundle('/plugins/@deepseek-ai/dsh-api-remotes/client.js')).toEqual({
      kind: 'bundle',
      id: '@deepseek-ai/dsh-api-remotes',
      sourceMap: false,
    })
    expect(resolvePluginBundle('/plugins/@deepseek-ai/dsh-ui-tool/client.js.map')).toEqual({
      kind: 'bundle',
      id: '@deepseek-ai/dsh-ui-tool',
      sourceMap: true,
    })
  })

  it('rejects other /plugins paths and non-plugin paths', () => {
    expect(resolvePluginBundle('/plugins/events')).toEqual({ kind: 'unknown' })
    expect(resolvePluginBundle('/plugins/a/other.js')).toEqual({ kind: 'unknown' })
    expect(resolvePluginBundle('/assets/app.js')).toEqual({ kind: 'unknown' })
    expect(resolvePluginBundle('/%')).toEqual({ kind: 'unknown' })
  })
})
