# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

Local desktop client over the DeepSeek Harness: **the Electron main process is the dsh host itself**. It boots the web composition in-process (base + web-app + the [`dsh-desktop-app`](../../packages/bundle/desktop/README.md) patch layer), serves the same built frontend dist the browser uses over a privileged local `app://` scheme with the boot manifest injected, and bridges every renderer request over Electron IPC. There is **no HTTP listener anywhere** — the Web GUI's features (plan mode, model selection, approvals, ask_user_question, commands, settings, workspaces) run exactly as in the browser, and stay in sync with the Web product.

## Architecture

| Piece | Role |
|---|---|
| `electron/main.ts` | Boots the host tree (three bundle patch layers over the empty root in [`cordis.yml`](cordis.yml), plus the same shipped agent-preset overlay the CLI applies), serves `app://` from the frontend dist, creates the window, owns teardown |
| `electron/boot.ts` | Electron-free host boot: profile machinery plus the shipped preset root (`packages/preset/agent-presets/presets` in a checkout; `resources/agent-presets` in a packaged build). User-authored presets remain under `$DSH_HOME/.agent-presets`. |
| `electron/bridge.ts` | Binds the transport-agnostic gateway (`DesktopBridge` from `@deepseek-ai/dsh-client-connection/desktop`) to `ipcMain` and the window |
| `electron/preload.mts` | Exposes the typed `window.desktopBridge` transport only — no raw ipcRenderer |
| `electron/protocol.ts` | Traversal-guarded dist path mapping (pure, tested) |
| `packages/bundle/desktop` | The desktop patch layer: disables the transport-only rows, remounts `connection` transport-free, mounts `desktop-startup`/`desktop-runtime` (dist resolution, `DSH_WEB_MODE`, desktop surface prompt, Electron directory picker) |
| Renderer | The shared `@deepseek-ai/dsh-web-frontend` dist; `DesktopApiClient` (in `dsh-client-connection`) carries fetch and the two event streams over the bridge |

## Running

```sh
pnpm run build            # repo artifacts (lib/ for the workspace packages)
pnpm run desktop:dev      # build main + web dist, then launch Electron
```

Dev boots the composition from the repository (bundle patches resolved through the installed packages, source launch for the app). The window shows the exact Web GUI; sessions and settings live in the shared harness home.

Further plugins go into the **`desktop` profile** (`~/.dsh/profiles/desktop`), the same directory as `dsh plugin --profile desktop add`. The browser's `web` profile is a separate directory — a plugin added with `--profile web` does not appear in this window. The in-box Settings → Plugins tab writes `desktop` only.

The hidden native title bar retains the Windows minimize, maximize, and close interaction states in a compact 30px overlay. AppFrame uses that height as a first grid row: the sidebar spans both rows and gains the title-row space without moving its bottom-pinned settings seat, while conversation and details remain below the controls. The Electron preload owns a fixed drag region across the title row and stops before the native controls, so window movement does not depend on the shared Web layout rendering first. The row uses `--dsw-specific-sidebar-fill`, so it follows the sidebar across light, dark, and overridden themes.

## Packaging

`pnpm run desktop:pack` builds the Electron main and the web dist, deploys the production closure with `pnpm deploy` into a temporary directory outside the workspace, then runs electron-builder against that tree (NSIS installer + portable). The host composition ships as production dependencies under `resources/app` (not asar: Cordis loads plugins as ESM files, and Windows profile junctions cannot target asar paths — [packed peers](../../.agents/notes/implemented/bug-fix/2026-08-28-desktop-pack-esm-peers-outside-asar.md)). The production closure includes the published `@sjhmars/plugin-install` package pinned by `dsh-desktop-app`; packaging does not require an adjacent plugin repository. A clean Windows machine needs neither Node nor a repository checkout. The agent-presets package's `presets` directory copies into `extraResources` as the read-only system roster; user-authored presets stay under `$DSH_HOME/.agent-presets`. Electron-builder obtains the Electron runtime itself (cached download). On Windows, rebuilding `node-pty` for Electron requires the Visual Studio individual component **MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs**. The throwaway deploy keeps electron-builder's pnpm collector off the workspace `pnpm list` that otherwise exhausts Windows file handles ([isolation](../../.agents/notes/implemented/process/2026-08-27-desktop-pack-isolated-pnpm-deploy.md)).

## Security posture

Two carriers, two fences — the browser's HTTP/WS path and its Host/Origin/`sec-fetch-site` fence stay untouched:

- **Desktop carrier:** no HTTP. The IPC bridge is the trust boundary — reaching it requires being this app's own window, which equals the browser carrier's loopback caller, so privileged methods are reachable directly.
- The equivalence's preconditions: `contextIsolation: true`, `nodeIntegration: false`, a whitelist-only `contextBridge` (no raw ipcRenderer), and a window that loads only this app's local dist (CSP `'self'`, external navigation and new windows denied; the ESM preload requires `sandbox: false`). **Introducing remote content into the window would require restoring a network-level fence first.**

## Known Limitations and Deferred Work

- **No live client-plugin HMR** in the desktop window (the web dev watcher is a separate process); rebuild + relaunch picks changes up.
- **Single window, single machine**: no multi-window workspace sync, no code signing or auto-update yet.
- **Directory picker parity**: the desktop uses the native picker the host composes (`directory-picker-auto`), same as the web surface on desktop platforms.
