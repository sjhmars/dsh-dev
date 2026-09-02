---
description: "Authoritative version 1 wire protocol for authenticated external DSH clients."
kind: "protocol"
---

# DSH External Gateway Protocol v1

English | [中文](PROTOCOL.zh.md)

This document is the authority for `@deepseek-ai/dsh-external-gateway` clients. `weixin-mouth` and a future Web BFF implement this protocol; they do not expose or depend on the DSH browser `/api` transport.

## Transport and authentication

The gateway listens on `127.0.0.1` in the supported `external-gateway` profile. Cross-machine clients use encrypted FRP, SSH, WireGuard, or TLS to reach that loopback service; a bearer token is not a transport encryption mechanism.

Every protected request carries `Authorization: Bearer <client-token>`. Mutation requests also carry `Content-Type: application/json`. Tokens are generated and persisted by the Host profile, remain stable across restarts, and are never accepted in URLs, cookies, request bodies, profile YAML, or environment variables.

The server derives `clientId`, account allowlists, peer allowlists, and operation scope from the matched token. `clientId`, account identity, and peer identity in a request body are rejected or ignored according to the endpoint; the body cannot expand the credential's scope.

`GET /healthz` is the only unauthenticated route. It returns `{ "status": "ok" }` and does not disclose version, configuration, credentials, or storage state.

## Addressing and JSON rules

The external identity tuple is `clientId + accountId + peerId`. The client supplies `accountId` and `peerId` only where this document says so; the server supplies `clientId` from authentication. Opaque ids are non-empty trimmed strings. Unknown object fields are rejected.

All sequence values are non-negative safe integers. IDs and text are bounded by the active profile limits. JSON values are finite JSON primitives, arrays, and objects; NaN, Infinity, binary values, and cyclic values are not protocol values.

Gateway Sessions are always ungrouped and always use the profile startup cwd. The protocol does not accept `cwd`, `workspaceId`, credentials, global settings, plugin or dynamic Cordis operations, or Agent-preset file edits.

## Query endpoints

Query endpoints are idempotent GET requests and do not enter the inbox.

| Request | Purpose |
|---|---|
| `GET /v1/sessions?accountId=<account>&peerId=<peer>` | List Sessions owned by this peer and return its active Session. |
| `GET /v1/sessions/:sessionId?accountId=<account>&peerId=<peer>` | Read one Session status, model, permissions, title, and projection. |
| `GET /v1/sessions/:sessionId/history?...` | Read paginated messages, tool calls, and tool results. |
| `GET /v1/sessions/:sessionId/models?...` | List models available to this Session. |
| `GET /v1/sessions/:sessionId/skills?...` | List skills available in this Session preset scope. |
| `GET /v1/sessions/:sessionId/subagents?...` | List subagents directly dispatched by this root Session. |
| `GET /v1/artifacts/:artifactId?accountId=<account>&peerId=<peer>` | Download a gateway-owned export artifact. |
| `GET /v1/uploads?accountId=<account>&peerId=<peer>` | List upload metadata owned by this peer. |
| `GET /v1/uploads/:uploadId?...` | Read one upload's status and received part numbers. |
| `GET /v1/uploads/:uploadId/content?...` | Download one completed upload after owner validation. |

Session and artifact reads apply ownership before loading a Host projection. A foreign, local-Web, other-client, or guessed Session id returns `404 not_found` without revealing whether it exists. Query cancellation follows the HTTP request lifetime.

## Reliable mutations

All state-changing operations use `POST /v1/deliveries` with this exact top-level vocabulary:

```json
{
  "deliveryId": "opaque-client-id",
  "accountId": "account",
  "peerId": "peer",
  "payload": { "type": "message", "content": [{ "type": "text", "text": "hello" }] }
}
```

The server authenticates and validates the request, checks account and peer allowlists, writes the inbox row, and then returns `202`. Retrying the same `(clientId, deliveryId)` with identical account, peer, and payload returns `200` with `duplicate: true`; a different body for that id returns `409 delivery_conflict`.

The accepted payload tags are `session-create`, `session-select`, `session-rename`, `session-fork`, `session-cancel`, `model-select`, `permission-select`, `message`, `command`, `question-answer`, `approval-answer`, `subagent-followup`, `subagent-interrupt`, and `session-export`.

`session-create` never accepts a client-provided Session id. The gateway reserves an id in the inbox before Host creation and reuses it across retries. `message` may omit `sessionId` to use the peer's active Session; if none exists, the gateway creates one in the fixed cwd. `command` may omit `sessionId` only to use an existing active Session and does not create a Session.

`message` reuses the Session Controller's content parts. Supported gateway blocks are text, a base64-encoded `image` with one of the Host-supported raster media types, a completed `upload`, a completed `file`, and a named skill reference. An image upload is decoded into the existing image prompt part; a file upload is copied to `.dsh-external-gateway/inbox/<sessionId>/` beneath the fixed gateway cwd before it becomes a safe path prompt. Inline image bytes are validated and promoted by the Session Controller, while a skill reference is serialized to the existing skill invocation syntax rather than an arbitrary command. Message mode defaults to `queue` and may be `steer` where the Session Controller supports it.

`POST /v1/uploads` accepts `{accountId, peerId, kind, filename, contentType, size, sha256?}` and returns an owner-scoped `uploadId`, a 4 MiB `chunkSize`, and `totalParts`. Files are limited to 100 MiB and images to 20 MiB. `PUT /v1/uploads/:uploadId/parts/:partNumber` accepts one raw part; a retry with identical bytes returns `duplicate: true`, while different bytes for the same part return `409 upload_part_conflict`. `POST /v1/uploads/:uploadId/complete` verifies every part, the declared size, and the optional whole-file SHA-256 before making the file usable by `message`.

`session-select`, `session-rename`, `session-fork`, `session-cancel`, `model-select`, `permission-select`, `subagent-followup`, `subagent-interrupt`, and `session-export` require an owned Session. Model selection is limited to the Session model catalog. Permission selection uses the existing permission preset service. Subagent operations require a child belonging to the addressed root Session.

`command` executes a registered Session-level command without sending a model message. Host-management commands for credentials, settings, workspace mutation, plugins, dynamic Cordis, and Agent-preset editing are denied. An unknown command is a command result, not an ordinary model message.

`question-answer` carries the interaction id and structured `AskUserQuestionAnswer` values. `question` and `approval` events include their absolute `expiresAt`; clients delete their pending interaction when that time passes. A `question` event may include `intent: {"kind":"plan-review","approve":"<option-label>"}` so a client can render plan review without changing answer encoding. `approval-answer` carries the interaction id and only `allowed-once` or `rejected`. The interaction must still be live, belong to the addressed Session and peer, and be within its timeout; otherwise the request returns `404 not_found` or `409 interaction_unavailable`.

`session-export` creates an artifact and reports it through the event stream. Artifact bytes are fetched through the ownership-checked artifact endpoint.

## Events and acknowledgement

Clients consume durable events with:

```http
GET /v1/events?after=<exclusive-sequence>&limit=<n>&waitMs=<milliseconds>
POST /v1/events/ack
Content-Type: application/json

{"upToSequence": 42}
```

Events have a strictly increasing sequence per client, target `accountId` and `peerId`, the associated `sessionId` when applicable, and optional `causedByDeliveryId`. Events generated without an inbound mutation omit that field but use the same outbox.

The event payload tags are `delivery-completed`, `delivery-failed`, `session-created`, `session-selected`, `session-updated`, `session-event`, `assistant-final`, `question`, `approval`, `interaction-expired`, `subagent-started`, `subagent-finished`, `artifact-ready`, and `turn-failed`.

`assistant-final` is emitted only after the root Agent has committed `turn/end`. `question` and `approval` are emitted only for a gateway-owned root Agent; events from other Agents are delegated to their normal consumers. Internal Cordis events are filtered through an explicit allowlist before becoming `session-event` payloads.

The gateway stores the last Session event sequence copied to the outbox. On startup it replays later durable Session-log events; a crash during projection can therefore duplicate an event but cannot silently omit a committed event.

`after` is exclusive. A poll timeout returns `200` with an empty `events` array. One authenticated client may have one active long poll; another receives `409 poll_in_progress`. A disconnected request cancels its wait. `ack` accepts zero or the highest contiguous issued sequence. A gap, a future sequence, or a sequence beyond the durable outbox returns `409 invalid_ack`. Repeating an already applied ack returns `200`.

The gateway persists the acknowledgement before deleting rows. A client must send its ack only after the corresponding external effect succeeded. If a sender crashes after the effect but before the ack, the event is delivered again; clients must tolerate duplicates.

## Delivery semantics and errors

The inbox and outbox provide at-least-once delivery. A crash after Host input admission but before the inbox row is marked complete can repeat a mutation. A crash after an external sender succeeds but before the outbox ack can repeat an event. Exactly-once behavior is not promised.

The worker serializes one client/account/peer conversation and allows different conversations to run concurrently. It resumes pending inbox rows after startup and after an outbox ack releases backpressure. When unacknowledged events reach `maxOutbox`, new mutations return `503 outbox_backpressure` until the client acknowledges events.

Successful mutations expose a `delivery-completed` event before the inbox state changes to `completed`. Failed mutations expose `delivery-failed` before the inbox state changes to `failed`. Completed inbox ids are retained for the configured retention period; unacknowledged outbox events are not removed by time.

Common response codes are `202` for a newly admitted delivery, `200` for queries, event pages, acks, upload metadata, and idempotent replays, `201` for a new upload, `400` for malformed JSON, schema values, or invalid upload metadata, `401` for invalid authentication, `403` for a disallowed account, peer, or command, `404` for an unowned resource, `409` for delivery or part conflicts, incomplete uploads, interaction expiry, poll conflicts, or invalid acks, `413` for body, part, or text limits, `415` for a non-JSON mutation, and `503` for outbox backpressure.

## Versioning

The `/v1` prefix identifies this wire vocabulary. Additive event or payload variants require coordinated client compatibility updates and explicit schema changes. Existing clients must continue to reject unknown fields and unknown operation tags rather than forwarding them to a model.
