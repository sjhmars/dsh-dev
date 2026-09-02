# Agent Note: External Gateway machine protocol

Status: implemented

English | [中文](2026-08-31-external-gateway-machine-protocol.zh.md)

## Problem

VPS bridges and a future Web BFF need durable, peer-scoped control of DSH Sessions, but the existing Web application is a browser transport with a launch-token cookie and the complete Host API. Reusing `/api` would expose browser-oriented or host-administration operations to a machine client, and a bridge that calls Agent internals directly would duplicate Session ownership, delivery recovery, and interactive requests.

## Decision

`dsh --profile external-gateway` composes `dsh-base`, `dsh-web-app`, and `dsh-external-gateway-app`. The new application bundle keeps the mature Host Agent, Session Controller, model, permission, skill, command, and subagent services while removing browser connection, Remote API, frontend, and UI rows. An isolated loopback WebServer realm mounts only `@deepseek-ai/dsh-external-gateway` on `127.0.0.1:18765`.

The gateway accepts a permanent owner-only bearer token for the fixed `weixin-mouth` client and exposes versioned `/v1` routes. Clients provide an account and peer address; authentication provides the client identity. The gateway persists peer-owned ungrouped Sessions, a peer active Session, deduplicated inbox deliveries, client-sequenced outbox events, interaction records, projection cursors, upload metadata and part state, and export metadata in the `external_gateway` SQLite domain. Upload parts are fixed at 4 MiB, use owner validation, and complete into files below the fixed gateway cwd; profile configuration defaults file uploads to 100 MiB and image uploads to 20 MiB and can adjust those limits. Completed images resolve through the existing Session Controller, while each completed file is copied to `.dsh-external-gateway/inbox/<sessionId>/` below the fixed cwd before the Session model receives it. The VPS bridge sends metadata and upload parts through this protocol rather than storing blobs in its iLink message state. Every gateway Session uses the profile startup cwd. The protocol excludes cwd and Workspace changes, credentials, settings, plugins, dynamic Cordis, and Agent-preset mutation.

Mutations are at least once. The worker persists admission before invoking Host services and emits a durable completion or failure event before completing its inbox row. Client effects are acknowledged through a contiguous outbox cursor. An allowlisted Session-log projection records its own per-Session cursor and is replayed at startup. Questions and approvals belong only to a gateway-owned root Agent; each interaction has an absolute expiry deadline, and answers after cancellation, timeout, or process restart are expired. Question events preserve the `plan-review` presentation intent and its named approval option without changing answer encoding.

The browser launch-token and cookie rules remain owned by [Browser launch-token authentication](2026-08-24-browser-token-authentication.md). A future Web BFF uses another gateway token and this same machine protocol; it does not forward the browser cookie or publish the browser API.

## Verification

Focused gateway tests cover strict wire fields, image and upload content, 4 MiB part retries and conflicts, bearer validation, delivery conflicts and recovery, ownership, event ordering and acknowledgement, backpressure, projection replay, fixed cwd, commands, models, permissions, skills, subagents, and bundle composition. They cover question expiry and `plan-review` intent propagation. A source-profile loopback smoke created a peer-owned Session, confirmed `/api` and `/api/remote.mux` return 404, exported a ZIP artifact, and acknowledged its events.

## Alternatives considered

**Expose the browser `/api` through the tunnel.** It would couple a VPS client to a browser cookie and make the full Host API reachable where only peer-scoped Session operations are intended.

**Create a separate Agent or Session runtime for the bridge.** It would duplicate the production Agent assembly and produce incompatible Session, tool, and interaction behavior.

**Use a direct synchronous request-response protocol.** A process or network failure would lose the result or make recovery indistinguishable from duplicate execution. The durable inbox and acknowledged outbox make the duplicate window explicit.

**Assign one Session to each machine client without a peer address.** A shared client such as a future Web BFF could then mix conversations from different users. Peer ownership is part of every Session lookup.

## Consequences

The gateway is a Host-only application, not a desktop or browser interface. It reuses DSH Session capabilities but intentionally does not grant host administration. Implementations must preserve delivery IDs and event cursors across their own restarts, tolerate duplicate mutations or sends, and use encrypted transport in addition to the bearer token. The VPS iLink bridge, QR binding, and `context_token` recovery are implemented; FRP deployment and systemd service management remain operational concerns.
