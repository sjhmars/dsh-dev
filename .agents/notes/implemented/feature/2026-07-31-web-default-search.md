# Agent Note: Default Web search in shipped compositions

Status: implemented

English | [中文](2026-07-31-web-default-search.zh.md)

## Problem

The harness had a complete Web capability family—provider registry, DeepSeek/Exa/Perplexity search providers, local fetch, stable model tools, and structured result presentation—but the shipped `dsh web` composition mounted none of it. The model could not discover current information unless a deployment supplied a custom overlay. Merely mounting the existing DeepSeek provider would not complete the WebUI path: the Models page stores `DEEPSEEK_API_KEY` through `ctx.credentials`, while the search provider froze only the process environment at plugin load, so a key entered or rotated in the running UI would not reach search.

## Decision

`dsh-base` explicitly mounts `dsh-web` with selected search and fetch providers, their provider packages, and `dsh-tool-web` with `fetch: false`. The shared base therefore keeps only `web_search` visible unless a product preset enables fetch; the shipped Web presets do so. Explicit provider ids keep selection independent of registration order and leave personal or `--patch` overlays able to replace or disable the rows. The [Exa default decision](2026-09-02-exa-default-web-search.md) owns the selected search provider and credential requirement. The [Web capability seam decision](../architecture/2026-06-24-web-capability-seam.md) owns the public-fetch security policy and Web preset default.

The default mount does not create a Web-specific permission policy. `web_search` and enabled `web_fetch` calls execute outside the shell/filesystem sandbox and approval presets, following `dsh-tool-web`'s existing contract. The HTTP provider restricts fetches to validated public destinations, but it does not constrain public data egress. The shipped `workspace-write` default governs file mutations only; a restricted-network product stance requires a `tools/pre-execute` policy or capability-specific network confinement rather than implying that filesystem access mode governs Web calls.

## Alternatives considered

**Mount only `dsh-tool-web`.** Rejected because stable schemas without registered providers would make every default call fail; enablement and backend availability are deliberately separate, but a shipped default must supply its intended implementations.

**Keep Web tools in `web.cordis.yml`.** Rejected because it preserves an unexplained tool-roster difference between TUI and Web/headless. The rows are not surface-specific, so `base.cordis.yml` is their one home; the [tool-roster decision](2026-07-31-even-out-shipped-tool-rosters.md) records the shared composition.

**Enable fetch on every shared-base surface.** Rejected because the shared base serves products with different network postures. It mounts the public-only provider but keeps the tool opt-in; the shipped Web presets deliberately enable it, while another product can leave it hidden or add stricter network policy.

## Consequences

Native model requests on every shared-base surface carry the `web_search` schema and search guidance; Web/headless PTC mode exposes the same search capability beneath `run_code`. The shipped Web presets additionally expose `web_fetch` with public-address enforcement and no per-call approval. The Web snapshot lane boots the shipped tree, drives a replayed `web_search` call through the selected real provider against a local fixture, asserts the durable structured result, and pins the settled browser presentation. Composition smokes pin the shared search roster and per-preset fetch choices.
