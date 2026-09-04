# Agent Note: Desktop installer resolves from npm

Status: implemented

English | [中文](2026-09-04-desktop-installer-registry-dependency.zh.md)

## Problem

The desktop composition mounts `@sjhmars/plugin-install` in every packaged application. A `file:` dependency and a pack-time sibling lookup make an external repository path part of the build input, so a standalone Harness checkout cannot install or pack even when the same package version is public.

## Decision

`@deepseek-ai/dsh-desktop-app` pins the published `@sjhmars/plugin-install` package to exact version `0.3.1` as a production dependency. The shared lockfile records the registry artifact and integrity. `pnpm deploy --prod` stages the ordinary production closure, and `fillMissingProductionDeps` handles any production package that deploy omits. The pack has no installer-specific source-copy path.

`check-pack-plugins` resolves the installer manifest through the desktop bundle's installed dependencies. The graph check therefore follows the installer's `pnpm` production dependency without reading a repository outside the workspace.

## Alternatives considered

**Keep the sibling checkout.** That layout gives local plugin edits immediate effect, but makes installation and desktop packaging depend on an unrelated repository at one fixed path.

**Resolve the installed package and retain an explicit installer copy.** The generic production-dependency repair already stages omitted packages and their dependencies. A second path would give one package separate deployment behavior without a separate requirement.

**Use a semver range.** The installer evolves in a separate repository and consumes pre-release Harness peers. An exact version keeps each plugin upgrade coupled to a reviewed manifest and lockfile update.

## Consequences

A clean checkout resolves the installer from the configured npm registry or package-manager cache and requires no adjacent plugin repository. Each installer release must be published before the desktop dependency and lockfile can adopt it. The Settings tab, `desktop` profile ownership, and packaged runtime behavior are unchanged.
