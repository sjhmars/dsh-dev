# Agent Note: Exa as the default Web search provider

Status: implemented

English | [中文](2026-09-02-exa-default-web-search.zh.md)

## Problem

Every base-backed profile needs one installed and selected search provider before `web_search` can work. A profile-local Exa insertion configures only one machine and can collide with a later shared default. The distributed base must carry the provider choice while keeping credentials outside packages and generated profiles.

## Decision

`@deepseek-ai/dsh-base` depends on and mounts `@deepseek-ai/dsh-web-search-exa`, and its `web` row selects `searchProvider: exa`. Every profile template that composes the shared base, including `web`, `external-gateway`, `headless`, `sdk`, and `acp`, therefore installs and selects Exa without a profile patch or a separate plugin installation. `sdk-minimal` remains a standalone composition outside this decision. This provider choice supersedes the DeepSeek-specific parts of the [default Web search decision](2026-07-31-web-default-search.md), whose shared-base placement remains current.

The Exa provider reads `EXA_API_KEY` from the trusted launch environment when its row has no literal key. A fresh installation needs that credential but no other search configuration. The repository and generated profile templates never carry a literal Exa key.

The base uses `dsh-tool-web`'s provider-neutral 30-second search budget. Exa returns citeable sources with highlight snippets and publication dates but no provider-generated answer, so the stable `web_search` output omits `content` and keeps the same `sources` and `truncated` fields.

## Alternatives considered

**Keep DeepSeek as the shared default and add Exa in each profile.** Rejected because new machines would need a second installation or configuration step and profile-local insertions could diverge or duplicate the shared row.

**Mount both search providers in the base and select Exa.** Rejected because the unused DeepSeek search package would remain in every installation without providing fallback; provider selection is explicit and does not fail over.

**Store an Exa key in the bundle or profile template.** Rejected because credentials must not ship in source, packages, generated profiles, or snapshots. Each installation supplies `EXA_API_KEY` through its launch environment.

**Use Perplexity as the shared default.** Rejected because the selected product behavior is result-oriented search without an additional generated answer. Perplexity adds a model-generated `content` field and its own token budget.

## Consequences

Updating the installed distribution changes every base-backed profile to Exa on its next process start; an already running process keeps its settled plugin tree. Existing user patch layers still win and must remove any redundant `web-search-exa` insertion before adopting the new base. Search cannot run until `EXA_API_KEY` is present, and the current Models settings page does not manage that credential. The base composition test pins the selected provider and packaged dependency, while the Web search snapshot drives the real Exa adapter against a local `/search` fixture and pins the normalized durable result.
