# Agent is the substrate; Think is a composition over it (no privileged access)

**Status: DRAFT — contested; do not treat as authoritative.** Its core framing
("Agent is non-conversational; conversation belongs only to Think") was
challenged and does not hold: (1) transport-free ≠ conversation-free — I
conflated the wire (frames/connections, which Agent must not touch) with
conversation (turns/transcript/streaming, all transport-free); (2) the claim
that the `ConversationEventLog` is "generic, not conversational" is a
rationalization — its events *are* `chunk`/`message:updated`/`turn:settled`,
and it already lives on `Agent`, so the current split (outbound conversation on
the base, inbound in Think) is incoherent, not principled. The real Agent/Think
axis is **opinion, not conversation**. Emerging three-layer reading (matches
the context map's own Context 3 vs 4): **Durable Runtime** = conversation-free
substrate (non-conversational actors live here) · **Agent** = an *unopinionated
agent that converses* (model + turn loop + transcript + event stream;
transport-free) · **Think** = the *opinions* (compaction, recovery, delegation,
channels, branching sessions, HITL, submissions, skills). To be re-derived with
the maintainer before any authoritative ADR is written.

Everything below reflects the OLD (contested) framing and the *mechanical*
findings, which remain useful regardless of where the conversational boundary
lands: the grep-verified fact that Think reaches only Agent's public+protected
surface (no private access, no casts), and the corollary that transports must
depend on capability interfaces, not concrete classes.

---

`Think` uses only `Agent`'s
public and `protected` surface — no `private` access, no `super.*` beyond a
normal `destroy()` override, no escape-hatch casts. Therefore Think is
reproducible in userland: a developer can write their own Think-equivalent
(or a leaner/different composition) by extending `Agent` and composing the
same domain modules, with exactly the access Think has. There is nothing
magic about Think — it is one composition among possible many.

## The boundary, stated

**`Agent` = the durable, transport-free runtime substrate.** It owns the
platform-agnostic primitives every durable agent needs, and nothing about
conversation:

- identity — `host`, `name`, `ids` (public readonly)
- observable state — `setState` / `state` (private `stateContainer`)
- the single-alarm **scheduler** — `schedule` / `scheduleEvery` / `cancelSchedule`
- durable execution (**fibers**) — `startFiber`
- **keep-alive** ref-counting — `keepAlive`
- the durable **task queue** — `queue`
- **RPC / callables** — `callables`
- sub-agent **spawning** and **workflow** tracking
- the outbound **event log** — `events()` (public read) / `publishEvent` (emit)
- lifecycle — `start` / `onAlarm` / `destroy`

Plus a deliberate **extension contract** — the `protected` members a
composition-on-Agent builds against (audit 26 §5):

| protected seam | what a composition uses it for |
|---|---|
| `publishEvent(event)` | emit domain events onto the outbound log |
| `schedulerService` | schedule its own timers (recovery, tasks) |
| `fiberService` | wrap work in recoverable durable fibers |
| `keepAliveService` | hold the DO awake across async work |
| `registerInternalCallback(name, fn)` | name a callback the scheduler/queue can dispatch |
| `host.store` (scoped) | its own prefixed slice of storage |

**`Think` = one composition over `Agent`.** It adds a conversational turn
engine by wiring together *isolated, independently-tested domain modules* —
the turn loop, session/history, tools + actions, chat recovery + overflow
guard, submissions, channels, delegation-as-tools, conversation turn-state /
continuation — and connecting them to the substrate: emitting conversation
events via `publishEvent`, running recoverable turns on `fiberService`,
scheduling continuations and declared tasks via `schedulerService` +
`registerInternalCallback`, storing module state in scoped `host.store`.
Think's own file is thin wiring; the heavy logic lives in the modules (each an
exported `create*(deps)` factory) and in the Agent substrate.

## The evidence (why this is not aspirational)

Grep of `src/app/think.ts` against `src/app/agent.ts` (2026-07-15): every
`Agent` member Think touches is public or `protected` —
`host`/`bus`/`ids`/`events()` (public), `publishEvent`/`schedulerService`/
`fiberService`/`registerInternalCallback` (protected), and `super.destroy()`
(ordinary override). Think references **none** of Agent's `private` fields
(`taskQueue`, `stateContainer`, `subAgents`, `workflows`, `callableRegistry`,
`eventLog`, `dispatchSchedule`, `dispatchQueue`), and contains no
`(this as any)` / `as unknown as` / `@ts-` bypass. TypeScript's `private`
already prevents a userland author from reaching less than Think reaches — so
the reproducibility is enforced, not merely observed.

## Why enshrine it

The Agent/Think difference was unstated and caused confusion (e.g. treating
"chat" as an agent *type* — see ISSUE-030). Naming the boundary makes the
architecture legible and gives it a testable invariant:

**Invariant: Think must build only on Agent's public + protected surface.** If
Think ever needs something Agent keeps `private`, the fix is to *promote it
into the extension contract* (make it `protected` and document it here), never
to special-case Think. That keeps "write your own Think in userland" true by
construction, and keeps Agent an honest, reusable substrate rather than a
Think implementation detail.

## Corollary: adapters depend on capability interfaces, not concrete Think

ADR-0002 keeps the **Think↔Agent** boundary honest (Think uses only Agent's
public + protected surface). The same principle must hold one layer out, at
the **transport↔agent** boundary, or the userland promise leaks: a transport
that names the concrete `Think` class re-privileges it even though Think is a
plain composition.

**Current leak (to fix, rides with ISSUE-030).** `attachChatTransport(agent:
Think, …)` is typed to the concrete class and `import type { Think }`. Because
`Think` has `private` fields, TypeScript treats that parameter *nominally* —
only a `Think` subclass is assignable, even a userland composition with
byte-identical public methods is rejected (it lacks Think's private brand). So
today a "write your own Think" (which extends `Agent`, per this ADR) cannot use
the chat transport. That contradicts the ADR at the hosting layer.

**Invariant (corollary): a transport/adapter depends on a published capability
interface, never on a concrete agent class.** Type the conversation transport
against a `ConversationApi` interface — the methods it actually calls
(`chat`/`history`/`applyToolResult`/`resolveApproval`/`isRecovering`/
`activeTurn`/`pendingChatTerminal`/`clearMessages`/`cancelChat` + the
Agent-level `events`/`setState`/`callables`/`identity`). An interface has no
private brand, so it is structural: `Think` satisfies it *and so does any
userland composition that implements the same methods*. The blessing moves
from the class to the contract — and a contract is open.

This narrows to exactly one transport: event-projection, state-sync, and RPC
transports need only Agent-level capabilities (`events`/`setState`/`callables`,
on any Agent) — they never name Think. Only the conversation transport needs
`ConversationApi`. So three of the four `cf_agent_*` concerns are already
userland-open; the fourth becomes open by interface-typing.

`ConversationApi` is the **wire-independent inbound contract** of "an agent
you can converse with" — what a transport *calls*. The outbound stream is the
generic event log (`events()`), deliberately NOT part of this surface, so the
conversation transport pulls in only conversation, and state/rpc transports
pull in only their own capability.

```ts
interface ConversationApi {
  // drive a turn
  chat(input: string | ChatMessage[], callback?: StreamCallback,
       opts?: { channel?: string; requestId?: string; clientTools?: ToolSet }): Promise<TurnResult>;
  cancelChat(requestId: string, reason?: string): boolean;
  // resolve a suspended interaction (resume a paused turn)
  applyToolResult(a: { toolCallId: string; output: unknown; isError?: boolean }): Promise<void>;
  resolveApproval(a: { toolCallId?: string; executionId?: string; approved: boolean; reason?: string }): Promise<void>;
  // transcript
  history(): Promise<ChatMessage[]>;
  clearMessages(): Promise<void>;
  // reconnect / resume introspection
  isRecovering(): boolean;
  activeTurn(): { requestId: string; startOffset: number } | null;
  pendingChatTerminal(): { requestId: string; body: string } | null;
}
```

Callers are transports/drivers, never end users: the WS chat adapter, a future
HTTP/SSE adapter, the CLI demo, and the delegation relay (a parent driving a
child's `chat`) are all bindings of one protocol onto this one contract.

**Naming + relation to Channels (source-of-truth check, 2026-07-15).** This
interface is the INBOUND transport seam — the mirror of the OUTBOUND
`ConversationEventLog` the context map already names ("the transport seam").
Together, in seam (`ConversationApi`) + out seam (`ConversationEventLog`) = the
boundary that keeps the app transport-free. It is NOT the Channels context:
Channels/Surfaces (context 12) models *which surface a turn arrives on* +
per-surface policy + out-of-band delivery; `ConversationApi` is *how you drive
a turn*, surface-agnostic (a turn's channel is just its `chat({ channel })`
argument). Do NOT call this `ConversationSurface` — "Surface" is already
Channels' synonym in the map (context 12 is "Channels / Surfaces"); reusing it
would add a third "surface" meaning to the overloaded-term watchlist. A
transport *realizes a Channel on a wire* and drives it via `ConversationApi`.

## Consequence / open follow-up

Reproducible-in-userland is **true today but not yet first-class DX.** The
extension contract works but is documented only here; the domain-module
factories are public and test-proven but their `{ store, clock, ids, bus, … }`
dep signatures are internal-facing. Making "compose your own agent" an
*advertised* path (a cookbook + ergonomic composition surface) is the
companion DX work noted in audit 30 and ISSUE-030 — the architecture already
permits it; only the packaging is missing.
