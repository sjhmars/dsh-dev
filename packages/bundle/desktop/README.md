---
description: "The desktop GUI bundle for dsh: Electron IPC transport, the native directory picker, desktop model context, and the built frontend entry point."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

## Summary

This package turns the Web GUI composition into the desktop surface without opening a local HTTP server. It disables the Web transport rows, keeps the browser-side client roster, replaces API and stream traffic with the Electron IPC bridge, provides the built frontend entry point, and mounts the native directory picker. Choose it for the packaged desktop client; use [`dsh-web-app`](../web-app/README.md) when the interface must be reachable in a browser.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Electron application loads this bundle through the `desktop` profile. The `desktop-startup` row resolves the built frontend `index.html`; startup fails with a build instruction when that artifact is absent. The runtime row registers desktop model context, exposes `DSH_WEB_MODE=desktop` to managed shells, and provides Electron's OS directory chooser as `ctx.directoryPicker`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `surfaceContext` | `true` | Register the `app:desktop-surface` prompt section and `DSH_WEB_MODE` shell variable. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-desktop-app) lists the accepted field and its source declaration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch layers over `dsh-web-app`. It disables `webserver`, `web-runtime`, `web-startup`, `client-hmr`, and the adaptive directory picker; remounts `connection` without an HTTP bind; then inserts the desktop startup, runtime, native directory-picker, and plugin-install rows. The Electron application owns IPC bridge wiring in `dsh-client-connection` and `apps/desktop`.

### Plugin rows

| Row | Package | Role |
|---|---|---|
| `desktop-startup` | `@deepseek-ai/dsh-desktop-app/startup` | Provides `desktopRuntime.distIndex` through the frontend package exports. |
| `desktop-runtime` | `@deepseek-ai/dsh-desktop-app` | Registers desktop context, the shell variable, and the Electron directory-picker service. |
| `directory-picker-surface` | `@deepseek-ai/dsh-client-ui-directory-picker-native` | Supplies the native directory-picker UI in the workspace slot. |
| `plugin-install` | `@sjhmars/plugin-install` | Adds npm packages to the separate desktop profile. |

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Replaces the Web transport rows with the desktop carrier rows. |
| [`src/startup.ts`](src/startup.ts) | Resolves and provides the built frontend entry point. |
| [`src/index.ts`](src/index.ts) | Registers desktop model context, the shell variable, and directory picker. |
| [`src/picker.ts`](src/picker.ts) | Adapts Electron's directory dialog to `ctx.directoryPicker`. |
| [`src/invariant.ts`](src/invariant.ts) | Declares the empty runtime invariant companion. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop application](../../../apps/desktop/README.md) — Electron process and IPC bridge ownership.
- [Web bundle](../web-app/README.md) — the browser surface this patch specializes.
- [Client connection](../../client/connection/README.md) — browser and desktop transport selection.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-desktop-app) — exhaustive configuration reference.

-----

<a id="model-experience"></a>
## Model Experience

### Desktop-surface context

#### What the model sees

When `surfaceContext` is enabled, one `app:desktop-surface` section identifies the desktop client, explains references to this window or app, states that no local HTTP server exists, and says that client changes require a rebuild and relaunch. Managed shells also receive `DSH_WEB_MODE=desktop`.

#### Token effect

One fixed system-prompt section and one managed-environment variable per request; both are data-independent.

#### KV Cache effect

The section text is stable across sessions, so it does not invalidate the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The frontend must be built** — a source checkout needs `pnpm run build`; startup stops when the exported frontend entry point is absent.
- **Client plugins do not hot-reload** — client changes require rebuilding and relaunching the desktop window.
- **The OS chooser cannot be closed programmatically** — an aborted `pickDirectory` request returns `null`, but the operator must dismiss an already-open dialog.
- **Web transport rows must remain disabled** — enabling `webserver` or `web-runtime` reintroduces the HTTP surface that the desktop carrier removes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
