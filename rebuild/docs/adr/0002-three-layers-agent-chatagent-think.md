# Three layers: Agent → ChatAgent → Think (the boundary is opinion, not conversation)

**Status: ACCEPTED (target-state), 2026-07-15.** Agreed with the maintainer.
The code today is two-layer (`Agent` + `Think`); the migration this ADR
implies — extracting `ChatAgent` from Think's wiring — is a separate,
planned workstream (see Migration below). This ADR supersedes the earlier
contested draft ("Agent is the substrate; Think is a composition"), whose
"Agent is non-conversational" framing the maintainer rejected. The
mechanical invariants from that draft are carried forward verbatim (§
Invariants) — they were grep-verified and stand regardless of framing.

## The principle

Two axes were being conflated, and they are orthogonal:

- **Transport-free vs coupled** — the agent must never touch frames,
  connections, or wire formats. This is a hard goal and applies to *every*
  layer. Conversation is not the wire: a conversation is typed methods plus
  a durable log, and touches no transport.
- **Unopinionated vs opinionated** — this is the real layering axis.
  "An agent can converse" is *essence*, not an opinion. Opinions are the
  policies layered on conversing: compaction, recovery policy, channels,
  branching sessions, HITL, submissions, skills, delegation.

## The three layers

| Layer | Class | What it is |
|---|---|---|
| Durable substrate | `Agent` (existing, unchanged) | Conversation-free durable runtime: identity, observable state, scheduler, fibers, keep-alive, task queue, callables/RPC, sub-agent spawning, the outbound event-log *mechanism*, lifecycle. Non-conversational actors extend it directly. |
| Unopinionated conversing agent | `ChatAgent` (new — extracted from Think) | `extends Agent`. The essence of conversing: model binding, the turn loop (streaming, tool dispatch), transcript persistence/history, the conversation event *vocabulary* published onto the substrate's log. No policies. |
| Opinionated composition | `Think` (existing) | `extends ChatAgent`. The opinions: compaction/overflow guard, chat-recovery policy, channels, branching sessions, HITL approvals, submissions, skills, delegation-as-tools. One composition among possible many. |

**Naming decisions (2026-07-15).** The bottom layer keeps the name `Agent`
— renaming it (e.g. to `Actor`) was considered and rejected for blast
radius: `extends Agent` is pervasive in tests, docs, and the ported suites.
Instead the split happens *above*: Think divides into `ChatAgent` + `Think`.
Note the disambiguation: ISSUE-030's "no chat agent type" rejects gating the
*host* on a chat class (`instanceof`); it does not conflict with `ChatAgent`
as a layer name — there, "chat" meant the `cf_agent_*` client-protocol
bundle; here it means the conversational essence layer. Added to the context
map's overloaded-term watchlist.

**The event-log incoherence, resolved.** The old draft claimed the
`ConversationEventLog` was "generic, not conversational" to excuse it living
on `Agent` — a rationalization. The three-layer model dissolves this
cleanly: the *mechanism* (a durable, replayable outbound event stream that
event-projection transports consume) is substrate and stays on `Agent`; the
conversation *vocabulary* (`chunk` / `message:updated` / `turn:settled`) is
ChatAgent's, published via `publishEvent`. Inbound and outbound conversation
now live at the same layer.

## Allocation of concerns

The maintainer declined a universal rule for turn-loop knobs — whether a
given knob is a sensible global standard or a Think opinion is the **team's
case-by-case call**. This table records the accepted first-pass allocation
(2026-07-15); rows may move by team decision without invalidating the ADR —
the layering and the essence/opinion principle are what's fixed.

| Concern | Layer | Why |
|---|---|---|
| model call, streaming, tool dispatch loop | ChatAgent | can't converse without it |
| transcript persistence / history | ChatAgent | the "durable log" is part of the essence definition |
| maxSteps / stop conditions / tool protocol, client tools | ChatAgent | knobs on the loop, not policies about it — flagged as the contested zone; `applyToolResult` is unavoidable once a tool executes client-side (a transport reality, not a stance) |
| running turns on fibers (recoverability *mechanism*) | ChatAgent | substrate wiring, invisible to authors |
| recovery *policy* (`onChatRecovery`, persist/continue, incident bookkeeping) | Think | an opinion about what resumption means |
| compaction / overflow guard | Think | opinion |
| channels, branching sessions, HITL, submissions, skills, delegation-as-tools | Think | the canonical opinion list |

## Capability interfaces cut across the layers — let them compose

The inbound contract sketched previously as one `ConversationApi` mixed
layers: `chat`/`cancelChat`/`history`/`clearMessages`/`applyToolResult` are
ChatAgent essence, but `resolveApproval` is HITL (an opinion) and
`isRecovering`/`activeTurn`/`pendingChatTerminal` are recovery-policy
introspection (also opinions). Baking those into "the contract of an agent
you can converse with" would repeat the conflation this ADR exists to kill,
one level down.

Resolution — interfaces are structural and compose:

```ts
// essence — implemented by ChatAgent (and any userland equivalent)
interface ConversationApi {
  chat(input: string | ChatMessage[], callback?: StreamCallback,
       opts?: { channel?: string; requestId?: string; clientTools?: ToolSet }): Promise<TurnResult>;
  cancelChat(requestId: string, reason?: string): boolean;
  applyToolResult(a: { toolCallId: string; output: unknown; isError?: boolean }): Promise<void>;
  history(): Promise<ChatMessage[]>;
  clearMessages(): Promise<void>;
}

// opinion extensions — implemented by Think (or any composition that adopts the opinion)
interface ApprovalApi {
  resolveApproval(a: { toolCallId?: string; executionId?: string; approved: boolean; reason?: string }): Promise<void>;
}
interface RecoveryIntrospection {
  isRecovering(): boolean;
  activeTurn(): { requestId: string; startOffset: number } | null;
  pendingChatTerminal(): { requestId: string; body: string } | null;
}
```

A transport requires exactly the intersection it speaks: the full
`cf_agent_*` WS adapter (which has approval and resume frames) types against
`ConversationApi & ApprovalApi & RecoveryIntrospection`; a bare HTTP/SSE
turn driver needs only `ConversationApi`. Because transports name
capabilities, never layers, **ISSUE-030 is unblocked regardless of when the
class split lands** — it doesn't matter which class implements which
interface.

Callers of these interfaces are transports/drivers, never end users: the WS
chat adapter, a future HTTP/SSE adapter, the CLI demo, the delegation relay.
Do NOT name any of this `ConversationSurface` — "Surface" is Channels'
synonym in the context map (context 12, "Channels / Surfaces"). A transport
*realizes a Channel on a wire* and drives it via these interfaces.

## Invariants (carried from the superseded draft; grep-verified 2026-07-15)

**1. Each layer builds only on the layer below's public + protected
surface.** Verified for today's two-layer code: every `Agent` member Think
touches is public (`host`/`bus`/`ids`/`events()`) or protected
(`publishEvent`/`schedulerService`/`fiberService`/`registerInternalCallback`),
plus an ordinary `super.destroy()` override — none of Agent's `private`
fields, no `(this as any)` / `as unknown as` / `@ts-` bypasses. The same
rule applies at both seams after the split: ChatAgent over Agent, Think over
ChatAgent. If a layer needs something the layer below keeps `private`, the
fix is to *promote it into the extension contract* (make it `protected` and
document it), never to special-case the caller. This keeps "write your own
Think in userland" true by construction — TypeScript's `private` enforces
it, so the reproducibility is a checked property, not an aspiration.

The substrate's extension contract (audit 26 §5) is unchanged:

| protected seam | what a composition uses it for |
|---|---|
| `publishEvent(event)` | emit domain events onto the outbound log |
| `schedulerService` | schedule its own timers (recovery, tasks) |
| `fiberService` | wrap work in recoverable durable fibers |
| `keepAliveService` | hold the DO awake across async work |
| `registerInternalCallback(name, fn)` | name a callback the scheduler/queue can dispatch |
| `host.store` (scoped) | its own prefixed slice of storage |

**2. Transports/adapters depend on published capability interfaces, never
on a concrete agent class.** A concrete class with `private` fields is
nominal — typing a transport to it re-privileges that class and rejects
byte-identical userland compositions. Current leak: `attachChatTransport(
agent: Think)` — fix rides with ISSUE-030 (retype to the composed
interfaces above). Corollary already holds for three of the four
`cf_agent_*` concerns: event projection (`events()`), state sync
(`setState`/`state`), and RPC (`callables`) are Agent-level and never name
a conversational class.

## Migration

**LANDED 2026-07-15.** `ChatAgent` extracted to `src/app/chat-agent.ts`
(essence + 14 protected seams with neutral defaults); `think.ts` slimmed to
the opinions (1239→706 lines). Verified behavior-identical: typecheck clean,
native 1082 node + 42 workerd, and a per-test diff of the full ported board
pre/post extraction — byte-identical (217 passed / 172 failed / 7 skipped of
396, no name flipped). Bare-ChatAgent coverage added (`chat-agent.test.ts`).
Two domain seams widened for the split: `assembly.ts` (skills/policy/actions
now optional, neutral absent-behavior) and `continuation.ts` (`actions`
optional; executionId-addressed `resolveApproval` throws without it). One
ordering subtlety is documented in both classes: Think's `ensureRuntime()`
builds its services *before* `super.ensureRuntime()`, because
`pendingInteractions` reads the actions seam once at construction.

The original sketch below is retained for the record:

Extracting `ChatAgent` is mostly re-allocating which class wires which
domain modules — Think is already thin wiring over exported
`create*(deps)` factories, and the ported suites (`test-workers/ported/`)
plus the native suites guard behavior. Sequencing: this ADR freezes the
target; the split itself and the ISSUE-030 hosting refactor are separate
workstreams (the latter does not wait for the former).

## Consequence / open follow-up

Reproducible-in-userland is **true today but not yet first-class DX.** The
extension contract works but is documented only here; the domain-module
factories are public and test-proven but their `{ store, clock, ids, bus, … }`
dep signatures are internal-facing. Making "compose your own agent" an
*advertised* path (a cookbook + ergonomic composition surface) is the
companion DX work noted in audit 30 and ISSUE-030 — the architecture
already permits it; only the packaging is missing.
