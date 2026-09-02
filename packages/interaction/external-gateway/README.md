---
description: "Authenticated, durable HTTP protocol for peer-scoped DSH Sessions used by VPS bridges and future Web BFF clients."
kind: "package-reference"
---

# @deepseek-ai/dsh-external-gateway

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-external-gateway` exposes one versioned `/v1` HTTP protocol for external clients such as the VPS `weixin-mouth` bridge and a future Web BFF. It keeps the DSH Host local, does not load a browser UI, and never registers the existing browser `/api` or `/api/remote.mux` routes.

The package owns protocol validation, bearer-token authentication, peer-scoped Session ownership, durable inbox deliveries, durable outbox events, sequence cursors, and the worker that hands admitted mutations to an injected Session runtime. Agent loops, Session logs, tools, credentials, and storage backends remain owned by their existing packages.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Protocol](#protocol)
- [Persistence and delivery](#persistence-and-delivery)
- [Security invariants](#security-invariants)
- [Known limitations and deferred work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose the package in a Host-only profile. Open `externalGatewayDomainSpec` through `ctx.storageDomain`, construct an `ExternalGatewayStore`, create the Session runtime adapter, and pass both to `ExternalGatewayWorker` and `ExternalGatewayHttp`. The application bundle owns this composition; the package itself does not start a Node server or add a package bin.

The HTTP carrier only needs the `register(route)` method provided by the isolated Host WebServer realm. Registering the gateway routes on the browser WebServer would violate the profile's transport isolation invariant.

The protocol authority is [PROTOCOL.md](PROTOCOL.md). Clients must use the same delivery and event rules rather than reading the Host's internal controllers or browser Remote API.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `tokenFile` | `$DSH_HOME/profiles/external-gateway/weixin-mouth.token` | Stable owner-only machine credential. |
| `artifactDirectory` | `$DSH_HOME/profiles/external-gateway/artifacts` | Owner-private Session export storage. |
| `clientId` | `weixin-mouth` | Identity derived after the configured token matches. |
| `accountIds`, `peerIds` | empty | Optional credential-level allowlists. |
| `maxBodyBytes` | application-defined | Maximum physical JSON request size. |
| `maxTextBytes` | application-defined | Maximum UTF-8 size of one request string. |
| `maxEvents` | application-defined | Maximum events returned by one poll. |
| `maxPollMs` | application-defined | Maximum long-poll wait. |
| `maxOutbox` | `10,000` | Maximum unacknowledged events for one client. |
| `completedRetentionMs` | `30 days` | Retention for completed inbox rows. |
| `interactionTimeoutMs` | application-defined | Lifetime of a question or approval interaction. |
| `maxUploadBytes` | `100 MiB` | Maximum completed file upload size. |
| `maxImageBytes` | `20 MiB` | Maximum completed image upload size. |

The bundle, not this plugin, fixes the isolated WebServer at `127.0.0.1:18765`. The profile supplies the fixed startup cwd. It is recorded for ownership checks and is not accepted in a request body.

<a id="protocol"></a>
## Protocol

Protected routes require `Authorization: Bearer <token>` and JSON content for mutation requests. The server derives `clientId`, allowed accounts, and allowed peers from the matched credential; a request cannot declare or override those values.

`POST /v1/deliveries` admits Session creation, selection, rename, fork, cancellation, model and permission selection, messages, session commands, interaction answers, subagent control, and Session export. The operation is durable before a new delivery receives `202`; retrying an identical `(clientId, deliveryId)` is idempotent.

`GET /v1/events` reads the client outbox after an exclusive sequence cursor. `POST /v1/events/ack` accepts only the highest contiguous sequence that the client has received. Events remain durable until acknowledgement, so clients must persist their cursor and retry sends after transport failure.

Read-only Session projections are exposed through `GET /v1/sessions`, its Session subpaths, and `GET /v1/artifacts/:artifactId`. Every projection applies peer ownership before reading; a foreign or guessed Session is reported as not found.

`POST /v1/uploads` starts an authenticated, peer-owned upload. Clients send raw 4 MiB parts to `/v1/uploads/:uploadId/parts/:partNumber`, retry an identical part safely, and commit all parts through `/complete`; metadata and completed bytes persist below the fixed gateway cwd.

Completed image uploads can be referenced by a later message and are promoted through the existing Session Controller. Completed file uploads are copied to `.dsh-external-gateway/inbox/<sessionId>/` below the fixed cwd and become a safe path prompt, so the existing model and tools can read them without changing the shared Session message model.

See [PROTOCOL.md](PROTOCOL.md) for the complete payload and event vocabulary.

<a id="persistence-and-delivery"></a>
## Persistence and delivery

The `external_gateway` storage domain contains inbox deliveries, peer-owned Session reservations, active-peer mappings, interactions, upload metadata and part state, Session projection cursors, artifact metadata, client cursors, and outbox events. Upload and export bytes use owner-private files. Domain writes are schema-validated at reopen, and a version mismatch fails startup instead of silently migrating data.

The worker serializes deliveries for one client/account/peer conversation and allows different conversations to run independently. A crash after the runtime accepts a mutation but before the inbox row is completed can repeat the mutation; this is intentional at-least-once behavior. The worker writes completion or failure events before changing the inbox state, so a completed delivery cannot hide its only result.

Session creation reserves an explicit Session id in the inbox before the runtime creates it. A retry therefore reuses the same id after a partial write or process restart instead of minting an unrelated second Session.

Allowlisted Session events are copied into the outbox with a durable per-Session cursor. Startup replays events after that cursor, so a crash between the Session log commit and the outbox write may duplicate a projection but does not silently lose it.

<a id="security-invariants"></a>
## Security invariants

The generated bearer token is stored in an owner-only file and is stable across restarts. The token is not placed in a URL, cookie, profile file, request body, or environment variable. Cross-machine use still requires encrypted FRP, SSH, WireGuard, or TLS transport.

Gateway Sessions are ungrouped and use the profile startup cwd. The protocol has no `cwd`, `workspaceId`, credentials, global settings, plugin, dynamic Cordis, or Agent-preset mutation operation. Session, interaction, and subagent identifiers are checked against the authenticated peer before Host access.

<a id="known-limitations-and-deferred-work"></a>
## Known limitations and deferred work

- The first client is the single-account VPS `weixin-mouth` bridge; its iLink cursor, `context_token`, QR binding, and FRP service live in a separate repository.
- The package does not provide exactly-once semantics. Clients and the Host must tolerate duplicate mutation or event delivery during a crash window.
- A complete Web console still needs a BFF adapter for richer history, files, settings, and model management; it must continue to use this protocol rather than expose the browser API.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`ExternalGatewayRuntime` is the package seam for the existing Session Controller, command, permission, skill, and subagent services. The application profile is responsible for supplying those services; this package supplies the protocol and durable delivery machinery.

</details>
