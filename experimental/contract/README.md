# contract — domain interfaces for the composable rebuild (v0)

This package contains TypeScript interfaces only. It has no runtime code or
third-party dependencies; its minimal `package.json` makes it a private
workspace member so the repository toolchain can discover it.

The working implementation is the sibling
[`experimental/rebuild`](../rebuild/) package. It contains the engine, runtime
host, default harness and loop, model adapters, demo strategies, and 24 tests.
Its runtime dependencies (`ai` and `workers-ai-provider`) are declared in that
package, not here.

From the repository root:

```bash
pnpm install
pnpm --filter @cloudflare/agents-rebuild-experiment test
```

The test command compiles both the implementation and these contracts, then
runs the implementation's test suite. To typecheck only these interfaces:

```bash
pnpm exec tsc -p experimental/contract
```

See the [implementation README](../rebuild/README.md) for its architecture,
layout, durability guarantees, and known limitations.

Background: [design/think-capability-inventory.md](../../design/think-capability-inventory.md)
and [design/rfc-composable-rebuild.md](../../design/rfc-composable-rebuild.md).

## The model

The transcript is a durable, branch-aware log that acts as the bus. Everything
else is a producer or consumer of it:

- **Execution and durability are per-step**; "turn" survives only as `RunInfo`,
  a policy/reporting concept. The committed log is the snapshot — there is no
  separate checkpoint state.
- **Everything that gets work in is a channel** (WS chat, Telegram, cron,
  workflow callbacks, parent-agent RPC). One `AdmissionPolicy` replaces the
  five entry paths.
- **Async capability = tool call out, correlated entry back.** Subagents,
  workflows, HITL approvals and long tools are one pattern (`pending` +
  correlation), with sync completion as its fast path.
- **The engine owns durability exactly once**: claims/settles (effects),
  durable consumers (delivery/outbox), reconcilers (liveness + attempt chain),
  the live-step buffer (streaming), blobs (size).

## Module map and allowed imports

Arrows point at what a module may import. Anything not drawn is forbidden —
sharpness is enforced by these edges, so treat an import outside this graph as
a design bug, not a convenience.

```
                 kernel  (data only, imports nothing)
                    ▲
      ┌─────────┬───┴────┬──────────┬───────────┐
 transcript  resource  model      (kernel-only tier)
      ▲          ▲       ▲
      ├──────────┴───┬───┤
    tools ◄──────────┘   │        tools:    kernel, transcript, resource
      ▲                  │        model:    kernel, transcript (Part only)
      ├───────┬──────────┤
   context  channel  admission    context:  + tools, model (types)
      ▲                           channel/admission: kernel, transcript
      │
    loop                          loop: kernel, transcript, tools, model, context
      ▲
    agent                         agent: everything (composition root)
```

## The residue model

A robust engine does not make durability disappear; it makes durability
someone else's job exactly once. What remains for component implementers is
five declarations/disciplines, each pinned to a type:

| Residue                             | Where it lives in the contract                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Last-mile effects (two generals) | `EffectDeclaration` on `ToolDescriptor`; `DeliveryContract` on `OutboundSpec`                                                        |
| 2. At-least-once handlers           | `attempt` fields on `ReconcileContext`, `DeliveryContext`, `RunInfo`; discipline notes on `AgentLoop.step`, `AdmissionPolicy.decide` |
| 3. External resource lifecycles     | `Resource` (ensure/health/dispose), carried by `ToolProvider.resources`                                                              |
| 4. Policy is domain knowledge       | `RetryPolicy`, `LoopPolicy`, `AdmissionPolicy` — declarations the runtime enforces                                                   |
| 5. Entry schemas are forever        | `Versioned` envelope; namespaced kinds; tolerant-reader rule in kernel.ts                                                            |

Plus the boundary: realtime media never rides the log (`RealtimeSession`).

## Deliberately out of scope

The substrate the runtime provides beneath `AgentDefinition`: DO hosting,
boot phases, alarm/clock, connections/hibernation, state sync, RPC, sql. Also
client-side surfaces (React hooks, AgentClient) and the concrete wire protocol
— a channel implementation detail.

## Litmus tests this contract must eventually pass

1. **Think and AIChatAgent are both expressible as `AgentDefinition` values**
   (presets), sharing the engine and differing in loop/context/channels.
2. **An extension is just another bus client** — the host bridge disappears
   because entries + gateway + view ARE the extension API.
3. **The 14 e2e recovery scenarios** (chat-recovery, stall, action-pause,
   tool-rollback, reattach-budget, …) are restated against `Transcript` +
   reconcilers alone, with no chat vocabulary.
4. **Codemode needs only `ToolRuntime.catalog()`/`execute()`** to project the
   tool surface into a sandbox.
5. **Voice ships without adding a frame to the log.**

## Open questions (v0)

- **Branching semantics.** Is `fork()` enough for regeneration and concurrent
  writes-during-a-run, or do runs need explicit branch pinning in the types?
- **Claim key namespace.** Who mints `ClaimKey` for a tool call — the runtime
  (from callId) or the declaration's `key(input)`? Collision rules across
  providers need stating.
- **Entry vocabulary completeness.** Approval request/verdict entries are
  currently implied by `GatedToolResult` + admission; do they need reserved
  core kinds like `effect/*` has?
- **Multi-run concurrency.** v0 assumes ≤1 active run per branch. Parallel
  runs on forked branches (sub-lines) need merge semantics.
- **Consumer lag vs. retention.** Compaction/eviction must not outrun the
  slowest durable consumer; the contract does not yet say who yields.
- **Step size bounds.** A step's uncommitted buffer is bounded by what? The
  engine needs a declared cap so a runaway step cannot exhaust memory.
