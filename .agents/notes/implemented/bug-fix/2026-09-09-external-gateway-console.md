# Agent Note: External Gateway console diagnostics

Status: implemented

English | [中文](2026-09-09-external-gateway-console.zh.md)

## Problem

A headless gateway has no browser log viewer. Cordis buffers log messages without a terminal exporter, and successful delivery admission does not establish that a model turn succeeded.

## Decision

The gateway installs a named, scope-owned stderr exporter and observes live events only for Sessions in its ownership store. Startup, turn and step progress, Agent errors, failed turn reasons, and delivery failures are visible without extra CLI arguments. Console diagnostics neither replay outbox history nor change protocol events.

## Alternatives considered

**Export every Cordis logger.** Unrelated plugins can log credentials, model input, and tool data. The gateway exports only its dedicated diagnostic logger.

**Print complete Error objects.** Provider objects and causes can contain headers and request bodies. Diagnostics select the error message, mask common credential patterns and URLs, and bound the output instead.

## Consequences

The logger does not create another durable log. Operators control collection through stderr, can disable console output, and must review provider error text before sharing it because pattern masking cannot recognize every secret. Scope disposal removes both listeners and the exporter. The package console tests cover ownership filtering, error visibility, masking, output limits, and disposal.
