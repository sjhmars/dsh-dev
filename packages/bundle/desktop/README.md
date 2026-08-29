# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

The dsh desktop-surface bundle: the desktop patch layer over [`dsh-web-app`](../web-app/README.md) plus the runtime glue plugin. It disables the transport-only rows (`webserver`, `web-runtime`, `web-startup`, `client-hmr`) and the adaptive directory picker (which resolves its interaction from the webserver bind), remounts `connection` transport-free (the IPC bridge replaces its `/api` route and WebSocket downlinks, while its browser half must stay in the boot graph), and mounts the desktop carrier rows — `desktop-startup` (provides `desktopRuntime`: the built frontend dist index), `desktop-runtime` (the `app:desktop-surface` prompt section, the `DSH_WEB_MODE` shell variable, and the Electron-backed `ctx.directoryPicker`), and the pinned native directory-picker surface. The whole browser roster stays exactly as the Web surface composed it; the Electron app owns the IPC bridge wiring, which lives in `dsh-client-connection` and `apps/desktop`.

## Plugin

| Row | Package | Role |
|---|---|---|
| `desktop-startup` | `@deepseek-ai/dsh-desktop-app/startup` | Provides `desktopRuntime` (`distIndex` resolved through the frontend package exports). |
| `desktop-runtime` | `@deepseek-ai/dsh-desktop-app` | Model-visible orientation, the shell variable, and the Electron directory-picker service; no server, no URL. |
| `directory-picker-surface` | `@deepseek-ai/dsh-client-ui-directory-picker-native` | Pinned native surface occupying ui-workspace's directory-flow hole (the Web profile mounts it dynamically from its adaptive chooser). |
| `plugin-install` | `@sjhmars/plugin-install` | Settings → Plugins tab that runs `dsh plugin --profile desktop add` (npm package name only). The browser `web` profile is a separate directory. |

## Model Experience

### Prompt text

#### What the model sees

When `surfaceContext` is on, one `app:desktop-surface` section states that the user interacts through the desktop client, that no local HTTP server exists (no other page can reach the session), and that client changes require a rebuild and relaunch.

#### Token effect

One fixed system-prompt section per request; data-independent.

#### KV Cache effect

Append-stable: the section text does not vary per session, so the reusable request prefix is unaffected.

## Known Limitations and Deferred Work

- **No client-plugin HMR**: the desktop window rebuilds instead of hot-reloading client bundles.
- **The OS chooser cannot be aborted**: Electron provides no way to close its open directory dialog programmatically. An aborted `pickDirectory` request returns `null`, but the dialog stays open for the operator to dismiss.
- **Transport-only rows stay disabled**: the `connection` row runs without any bind (its node half skips registration when no `webServer` exists); re-enabling `webserver`/`web-runtime` while the desktop carrier is active would re-introduce the HTTP surface this layer exists to remove.
