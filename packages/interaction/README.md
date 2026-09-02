---
description: "Package map for human collaboration and authenticated external Agent ingress: slash commands, approvals, permission presets, questions, and the reliable External Gateway protocol."
kind: "package-group"
---

# interaction/ — the human-collaboration plane

English | [中文](README.zh.md)

## Summary

The `interaction/` group is where a person or an authenticated external client collaborates with a running agent. It provides slash commands, one-shot approval decisions, named permission presets, the question/answer service an agent pauses on, and the durable External Gateway protocol for peer-owned Sessions. Interactive applications drive the command, approval, and question interfaces directly; automation uses ACP, while VPS adapters use External Gateway without receiving browser or host-administration access. The subsystem references and protocol document own the exhaustive contracts; this map points at each package and its neighbors.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package README and its subsystem reference own the exhaustive contracts.

| Package | Role | ctx key |
|---|---|---|
| [`commands/`](commands/README.md) | Lets users type slash commands that run directly against an agent without a model round trip | `ctx.commands` |
| [`user-approval/`](user-approval/README.md) | Asks composed answerers for one-shot allow/reject decisions and fails closed without one | `ctx.approval` |
| [`permission-presets/`](permission-presets/README.md) | Bundles sandbox mode with an approval policy into one user-facing Permissions selector | `ctx.permissionPresets` |
| [`user-questions/`](user-questions/README.md) | Defines the validated question schema and scoped answerer waterfall an agent pauses on | `ctx.userQuestions` |
| [`tool-ask-user/`](tool-ask-user/README.md) | Exposes the `ask_user_question` tool so the model can ask the human for a decision | registers on `ctx.tools` |
| [`external-gateway/`](external-gateway/README.md) | Authenticates machine clients and provides durable, peer-owned Session mutations and events over `/v1` | registers routes on isolated `ctx.webServer` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem references for the shared vocabularies, then the neighboring automation and composition surfaces.

- [Commands subsystem](../../docs/subsystems/commands.md) — command registry semantics and the `ctx.commands` cordis surface.
- [Approval subsystem](../../docs/subsystems/approval.md) — request/outcome vocabulary, the answerer waterfall, and per-session policy.
- [Permission presets subsystem](../../docs/subsystems/permission-presets.md) — the preset table and the knob write-through.
- [User interaction subsystem](../../docs/subsystems/user-questions.md) — question vocabulary, answerer waterfall, and presentation intent.
- [ACP group](../acp/README.md) — the automation-only transport that answers approval requests for its own agents.
- [External Gateway protocol](external-gateway/PROTOCOL.md) — the versioned HTTP operations, delivery guarantees, and ownership rules.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
