# Agent Note: Desktop client hosts the Web composition in-process over an IPC bridge — no SDK, no HTTP listener

Status: implemented

English | [中文](2026-08-14-desktop-client-over-sdk.zh.md)

## Problem

A standalone desktop client needs the full Web GUI feature set — plan mode, model selection, approvals, ask_user_question, commands, settings — without a browser. Shipping a second protocol (the SDK route) would fork the product: every host-side capability would need re-plumbing across the wire, forever trailing the Web surface. Wrapping `dsh web` in a window keeps feature parity but keeps a local HTTP listener, which the repository's own desktop plan already rejects.

## Decision

**The Electron main process is the dsh host.** `apps/desktop/electron/main.ts` boots the web composition in-process through `@deepseek-ai/dsh-app-boot`'s `boot()`: the three bundle patch layers — base, web-app, and the new `dsh-desktop-app` — over an empty root config, exactly the acp-demo boot pattern. The desktop patch layer disables the transport-only rows (`webserver`, `web-runtime`, `web-startup`, `client-hmr`) and remounts `connection` transport-free: its node half now treats `webServer` as optional (immediate-or-inject registration, the same pattern as the modules change), so the row registers nothing without one while its browser half — the boot-graph row that provides `ctx.connection` in the renderer — stays composed. The patch also mounts `desktop-startup` (provides `desktopRuntime` with the dist index) plus `desktop-runtime` (the `app:desktop-surface` prompt section and `DSH_WEB_MODE`). No HTTP listener exists anywhere in the tree.

**One renderer, two carriers.** The window loads the shared `@deepseek-ai/dsh-web-frontend` dist over a privileged local `app://` scheme (module scripts cannot load over `file://`), with `window.__DSH_BOOT__` injected by reusing `injectBootManifest` from the modules node half. The connection client picks its carrier at construction: `window.desktopBridge` present → `DesktopApiClient`, otherwise the existing `WebApiClient` — one line in `dsh-client-connection/src/client/index.ts`, so the browser path is untouched.

**The bridge reuses the transport-agnostic gateway.** `DesktopBridge` (new node-half module in `dsh-client-connection`, exported as `./desktop`) dispatches fetch-shaped requests through `toFetchHandler(apiProxy)` and pumps `api.events.mux/host` into an injected sink; the Electron app owns the `ipcMain`/`webContents` wiring. Response bodies stream as base64 chunks; event frames keep the WebSocket carrier's `ServerRequest` shape and the same client-side schema validation. Plugin bundles reach the renderer through `ClientModuleRegistry.bundleText(id)`: the shell loads them via same-origin `<script src>` (a script element never crosses the bridge), so the app's `app://` protocol serves `/plugins/<id>/client.js` (and `.map`) with the same path vocabulary and no-cache semantics as the Web host's route. The renderer's raw `globalThis.fetch` calls (the logical RPC channel under `/api` that the typert gateway's `remote.*` namespaces ride — `rpc.ts` stays untouched) are answered by the same protocol handler, which forwards `/api` to the in-process gateway; the bridge's own fetch channel carries the api client's unary requests.

**The modules node half drops its hard webServer dependency.** `inject` becomes `['loader']`; the `/plugins` route and the index tap register inside `ctx.inject(['webServer'], …)`, so a composition without a web server keeps the graph and bundle faces without HTTP routes. Web registration semantics are unchanged.

**The directory picker pins the native interaction on Electron's own dialog.** The web profile's adaptive chooser row resolves native-vs-browse from the webserver bind, so the desktop patch disables it; `desktop-runtime` registers `ctx.directoryPicker` itself with a `native` capability backed by a lazy `import('electron')` → `dialog.showOpenDialog` (no koffi child process, whose native addon ABI would not match Electron's), and the patch pins the `dsh-client-ui-directory-picker-native` surface row so ui-workspace's directory flow keeps its hole occupant. Electron cannot programmatically close an open chooser: an aborted `pickDirectory` returns `null` while the dialog stays open for the operator.

**The desktop boot mirrors the CLI's deployment overlays.** Besides the profile layers, `bootDesktopHost` applies the same overlay `composeProfile` does for the shipped agent-preset root: unpackaged, `{ path: <apps>/cli/config/agent-presets, trust: 'system' }`; packaged, `{ path: join(process.resourcesPath, 'agent-presets'), trust: 'system' }` after pack copies that CLI directory into extraResources ([presets extraResources](2026-08-28-desktop-presets-extraresources-plugin-install.md)). Without a system root the desktop roster would contain only the user's `$DSH_HOME/.agent-presets` and `session.create` would fail on the default preset.

**Trust model.** The bridge is the fence: only this app's own window reaches it (contextBridge whitelist, local-only content), which equals the browser carrier's loopback caller — privileged methods need no Host check on the desktop carrier. The equivalence's preconditions (CSP `'self'`, navigation/window-open denied, `sandbox: false` only because the preload is ESM) are recorded in `apps/desktop/README.md` as the condition under which remote content would require restoring a network-level fence.

**打包对着一次性 `pnpm deploy` 树运行 electron-builder。** 整套宿主组合作为生产依赖放在 `resources/app`（`asar: false`：插件是独立 ESM 文件，[打包 peer](../bug-fix/2026-08-28-desktop-pack-esm-peers-outside-asar.md)），无需 pkg 单文件可执行、无需 `python/sdk-runtime` deploy-root。`desktop:pack` 构建 Electron 主进程与 web 产物，把 `@deepseek-ai/dsh-desktop` 的生产闭包 deploy 到 workspace 之外，再从该树产出 NSIS + portable 双目标，这样 electron-builder 的 pnpm collector 就不会列出每个 workspace 包（[隔离](../process/2026-08-27-desktop-pack-isolated-pnpm-deploy.md)）。

## Consequences

- Feature parity is structural: the desktop window renders the same dist the browser fetches, so every Web capability arrives automatically and stays in sync.
- The SDK-phase self-drawn UI (React renderer, object layer, SDK RuntimeManager) is removed — unreleased, no compatibility debt; the SDK and ACP packages are untouched.
- A loopback-equivalent trust model replaces the Host fence on the desktop carrier only; the browser fence code remains and the precondition is documented.
- Electron stays a workspace dev dependency (binary download on install, `pnpm-workspace.yaml` `allowBuilds`); the desktop bundle declares it as a devDependency for types and pins it external in its tsdown config so the lazy dialog import survives bundling.
- `host.pickDirectory` works over the Electron dialog; `listDirectory`/`createDirectory` return `directory-picker-unavailable`, exactly as any Web deployment with the native interaction pinned.
- **Shared-home hazard**: the desktop host and a concurrently running `dsh web` server are two processes over one `$DSH_HOME`, and the jsonl persistence takes no cross-process lock — attaching both to one session allocates seqs twice and corrupts the log (observed: a duplicated `agent/inbox/spliced` seq). Do not open the same session from both surfaces until the persistence seam gains inter-process exclusion.

## Alternatives considered

- **SDK transport with a self-drawn UI** — the first implementation; gave streaming and zero server changes, but every host capability (plan mode, approvals, model selection) would need re-plumbing across the wire, forever trailing the Web product.
- **Window over `dsh web`** — instant parity, but keeps a local HTTP listener and the "browser in a frame" shape the repository's documented desktop plan rejects.
- **pkg single-executable host exe** — unnecessary: the host runs inside the Electron main process, so the packaged app needs only the composition and dependencies under `resources/app`.
- **Runtime sniff via a boot flag instead of `window.desktopBridge`** — the preload-exposed transport object is the more direct signal: the carrier is exactly what the preload installs.
