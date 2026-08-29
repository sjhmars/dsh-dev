# Agent Note: Packed desktop ships Cordis peers on a real filesystem

Status: implemented

English | [中文](2026-08-28-desktop-pack-esm-peers-outside-asar.zh.md)

## Problem

A packed desktop exe crashed on launch with `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis'` from an `index.js` under `%TEMP%`. Cordis Loader imports every plugin as its own ESM file. `pnpm deploy --prod --config.auto-install-peers=false` omits `@deepseek-ai/cordis` and the other required peers of `dsh-app-boot` (`cordis-plugin-loader`, `include`, `group`): they are peers, not production dependencies of `@deepseek-ai/dsh-desktop`. tsdown inlines those packages into `lib/electron/main.js`, so the main process starts, then the first plugin `import '@deepseek-ai/cordis'` fails. An electron-builder asar archive makes Electron copy that plugin file to `%TEMP%` to evaluate ESM, so Node's package walk never sees `resources/app/node_modules`. Windows profile fallbacks are directory junctions and cannot target asar paths. The portable target extracts the whole app to `%TEMP%\<id>\` on each launch, which is the path in the crash dialog.

## Decision

`@deepseek-ai/dsh-desktop` lists `@deepseek-ai/cordis` as a production dependency, plus the shipped-preset packages that the official CLI bin lists but `dsh-base` / `dsh-web-app` do not (`dsh-persona`, `dsh-tool-ask-user`, `dsh-terminal`, `dsh-tool-cordis`, and the persistent shell tools). Pack's `fillMissingProductionDeps` also walks `peerDependencies` (skipping optional peers the same way it skips `optionalDependencies`) so required workspace peers such as `cordis-plugin-loader` land in the hoisted staging tree. `electron-builder.yml` sets `asar: false` so plugin files stay on a real directory tree next to `node_modules/@deepseek-ai/cordis`, and `healProfilesModuleFallback` junctions under `$DSH_HOME/profiles/node_modules` can point at them. `apps/desktop/tests/pack.spec.ts` asserts every bundle-patch and shipped-preset package name is in that production graph.

## Alternatives considered

**asarUnpack `node_modules/**` while keeping asar for `lib/`.** Unpacking modules is enough for Node's walk, but Windows junctions still cannot target an asar overlay path for `package.json` at `app.asar/package.json`. Disabling asar keeps the install anchor and every package directory on the same real tree.

**Leave peers to `pnpm deploy --config.auto-install-peers=true`.** That would pull optional peers the desktop composition disables (HMR) and still leave asar ESM extraction broken.

## Consequences

The previous packed `0.1.1-rc.1` artifacts that used asar and omitted cordis do not boot. Repack after this change. The [deploy isolation note](../process/2026-08-27-desktop-pack-isolated-pnpm-deploy.md) still owns the throwaway `pnpm deploy`; this note owns the peer walk and `asar: false`.
