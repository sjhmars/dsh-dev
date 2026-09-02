---
description: "The loopback HTTP gateway profile layer: reliable external deliveries over the shared DSH Host, without a browser GUI."
kind: "package-bundle"
---

# @deepseek-ai/dsh-external-gateway-app

English | [中文](README.zh.md)

## Summary

Run `dsh --profile external-gateway` to serve the DSH external protocol on a loopback HTTP listener. This layer keeps the Web bundle's Host controllers and per-session Agent presets, then removes the browser transport, frontend, and UI rows. It adds an isolated WebServer for `@deepseek-ai/dsh-external-gateway` and routes that package's `external_gateway` records to SQLite. Choose it for a machine client such as a future VPS adapter; it does not provide a browser page or a second executable.

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

Use this layer when another service needs the DSH external protocol while the DSH process stays local to the machine. The profile owns the listener and the protocol package owns authentication, delivery, and event behavior.

### Start the shipped profile

```sh
dsh --profile external-gateway
```

The profile listens on `127.0.0.1:18765`. A successful start leaves the browser surface disabled and exposes no root Web `/api` or browser asset route. Put an encrypted tunnel or a TLS reverse proxy in front of the loopback listener before using a client on another machine.

### Add the layer to a custom profile

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-external-gateway-app
dsh plugin --profile <name> remove @deepseek-ai/dsh-external-gateway-app
```

The add operation installs the package's `dsh.bundle.patch` layer into the selected profile. The profile must also compose `dsh-base` and `dsh-web-app`; the layer does not duplicate their Agent, Session, or Host controller rows.

### What you get

The layer keeps the Host Session Controller, Agent preset roster, model providers, tools, permissions, skills, and subagent services supplied by the preceding bundles. It disables browser-only rows and gives the WebServer and external-gateway entries one shared private `webServer` realm. The gateway package receives the inherited storage-domain service, while only `external_gateway` is routed to the added SQLite backend.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is a configuration-only patch. It replaces the Web transport rows with explicit disabled entries, preserves the Host rows that do not require browser transport, and adds the SQLite backend plus two sibling entries with the same `isolate.webServer` label. They inherit the core Agent and storage services, so the protocol package can use the existing Session and tool assembly without reaching the browser `/api` carrier.

Patch entries replace a targeted row's complete configuration. The `storage-domain` entry therefore restates the shared JSON default and adds the `external_gateway: sqlite` route. The isolated WebServer fixes the loopback host and port in the shipped layer.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Disables the browser surface, routes the gateway domain, and mounts the isolated server and protocol package |
| [`src/index.ts`](src/index.ts) | Empty bundle entry; the patch document owns the application composition |
| [`src/invariant.ts`](src/invariant.ts) | Package invariant companion with no bundle-owned runtime relation |
| [`tests/external-gateway-app.spec.ts`](tests/external-gateway-app.spec.ts) | Manifest, disabled-row, storage-route, and isolated-server declarations |

### Invariant ownership

The companion registers an empty installer because this package owns a static patch list only. The external-gateway plugin, WebServer, storage backend, and Host controllers own the runtime relations created by their rows.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for the shared profile layer, the Web composition that this patch narrows, and the protocol implementation.

- [dsh-base](../base/README.md) — shared Agent, model, tool, Session, policy, and storage rows.
- [dsh-web-app](../web-app/README.md) — Host controllers and Agent preset composition reused by this profile.
- [external-gateway](../../interaction/external-gateway/README.md) — the protocol package that owns HTTP behavior and durable delivery.
- [app-boot profile section](../../boot/app-boot/README.md) — bundle order and patch replacement semantics.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Agent presets and Host services inherited from the preceding bundles. This bundle adds no model-facing prompt, tool, or schema of its own.

### Token effect

Zero additional request tokens from the bundle itself.

### KV Cache effect

No bundle-owned prompt prefix changes the cache. The selected Agent preset and the external-gateway package own any model-visible content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The listener is loopback-only** — clients on another machine need an encrypted tunnel or TLS termination; a bearer token does not encrypt HTTP.
- **The bundle has no browser surface** — the root page, frontend assets, HMR, browser modules, and browser UI rows are disabled by design.
- **The preceding Web bundle is required** — this patch reuses its Host controller and Agent preset rows and is not a standalone base replacement.
- **The external protocol owns its own limits** — delivery retention, event backlog, authentication, and allowed operations are configured by `@deepseek-ai/dsh-external-gateway`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
