# Agent Note: Separate external gateway HTTP controllers

Status: implemented

English | [中文](2026-09-09-external-gateway-http-controllers.zh.md)

## Problem

A single HTTP class mixes route registration, transport helpers, and handlers for unrelated resources. Following one endpoint requires scanning other endpoint implementations.

## Decision

The [route registrar](../../../../packages/interaction/external-gateway/src/http.ts) mounts [endpoint adapters](../../../../packages/interaction/external-gateway/src/http/routes.ts) on the existing isolated WebServer. Controllers receive only their required store, worker, and runtime dependencies; methods accept validated request DTOs and return typed response DTOs. The [protocol modules](../../../../packages/interaction/external-gateway/src/protocol/) own query/body parsing and explicit record-to-response projections. Shared HTTP transport owns Node requests, URL parsing, authentication, cancellation, and JSON encoding. The worker, runtime, and storage retain business execution and persistence ownership; HTTP requests do not define database transaction lifetimes.

## Alternatives considered

**One controller class.** It minimizes files but obscures the resource-specific entry points requested by maintainers.

**A new framework or generic controller superclass.** Cordis already assembles the application, and concrete controllers need no second router, decorator system, or inheritance hierarchy.

## Consequences

The split adds internal modules without changing routes, protocol fields, public package exports, scheduling, or transaction semantics. Real loopback HTTP tests cover route dispatch, authentication, JSON and binary responses, body limits, and route disposal. No model-visible content or recorded Session format changes.

The [raw-body decision](../simplification/2026-09-09-external-gateway-raw-body.md) remains independently applicable; bounded byte reads live in the shared HTTP request module. Session query projections retain the runtime's JSON/bytes result union rather than inventing a second model catalog or transcript schema.
