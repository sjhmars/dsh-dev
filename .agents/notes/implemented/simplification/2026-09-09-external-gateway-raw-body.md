# Agent Note: Delegate gateway body reads to raw-body

Status: implemented

English | [中文](2026-09-09-external-gateway-raw-body.zh.md)

## Problem

The external gateway needs the same byte bound for JSON and binary request streams, but three readers duplicate header checks, chunk accumulation, and concatenation. Divergent readers can reject declared lengths while overlooking chunked bodies or split UTF-8 input.

## Decision

The [HTTP adapter](../../../../packages/interaction/external-gateway/src/http/request.ts) uses `raw-body` for stream accumulation, expected-length validation, and byte limits. Its direct dependency uses the existing 3.0.2 lockfile resolution and transitive dependencies. The adapter retains numeric header validation, route-specific oversize errors, JSON decoding, and optional empty-body semantics. A failed read resumes an undestroyed request to discard remaining bytes while the HTTP response finishes.

## Alternatives considered

**Express body-parser middleware.** The carrier exposes Node requests and response-owning handlers, not an Express application. Middleware composition adds machinery that these routes do not need.

**One handwritten shared reader.** This removes duplication but retains ownership of stream buffering and length enforcement. The existing library covers those responsibilities under the [maintained-dependency policy](../process/2026-07-26-dependencies-over-hand-rolling.md).

## Consequences

The adapter remains responsible for authentication, protocol schemas, and error names. JSON bodies and upload parts remain bounded buffers, not unbounded whole-file uploads. Raw bytes are not automatically decompressed. Session events and model-visible content remain unchanged.

The [HTTP tests](../../../../packages/interaction/external-gateway/tests/http.spec.ts) use real loopback requests to cover declared and chunked oversize bodies, exact byte limits, split UTF-8, malformed and required-empty JSON, optional-empty completion, and binary upload/download fidelity. These transport cases do not require a model replay.
