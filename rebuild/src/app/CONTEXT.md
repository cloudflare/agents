# Agent

The base-class identity and lifecycle — the one thing actually "about the agent".
A thin composition root that owns no business logic: construction, service wiring,
lifecycle, and the overridable hook surface. Lives in `app/` alongside
`chat-agent.ts` (the unopinionated conversing layer) and `think.ts` (the opinions
composition) — the ADR-0002 three-layer split, landed 2026-07-15. See the
[context map](../CONTEXT-MAP.md).

## Language

**Agent**:
The Durable-Object base-class composition root. It wires the Durable Runtime services
and exposes the lifecycle; all behavior lives in domain services.
_Avoid_: god class (the thing this rebuild deliberately isn't)

**AgentHost**:
The adapter-provided construction dependencies (`store`, `alarm`, `clock`, `ids`,
`spawner`, `email`, `workflowRuntime`, `parentPath`, …) — the seam between the Agent
and a memory-or-Cloudflare adapter. Notably it carries **no connection registry**:
the Agent never holds a connection or parses a frame — transport is entirely the
adapter's concern (audit 25).

**Composition root**:
The constructor that assembles the domain services in a fixed order and wires their
hooks. It contains wiring, not logic.

**Lifecycle**:
The activation surface the adapter drives: `start()`/`onStart()` (once per
activation), `onAlarm()`, and `destroy()`.

**Scheduler dispatch table**:
How a fired schedule resolves: `$internal:*` service callbacks first, otherwise a
public method of that name on the agent instance.

**$internal callback**:
A service-registered background callback (keep-alive heartbeat, fiber housekeeping,
declared tasks) hidden from user-facing schedule listings.

**StateOrigin**:
The Agent-facing provenance of a state change: `{ kind: "server" }` or
`{ kind: "client"; sourceId }`. The Agent publishes it on the `state:changed` event.
_Avoid_: the container's coarse `StateSource` (Durable Runtime) has no `sourceId` —
the Agent holds the id, the container never sees it (ADR-0001).

**identity()**:
What the identity frame used to carry, minus the transport-supplied connectionId:
`{ className, name }`. A transport adapter frames it for the wire.

**ChatAgent**:
The unopinionated conversing layer (`chat-agent.ts`, `extends Agent`; ADR-0002
layer 2). Wires the conversation *essence*: model binding (`getModel`), the turn
pipeline (`executeTurn` — admission, streaming, tool dispatch, finalization),
transcript/session, pending interactions, and the conversation event vocabulary
(`chunk` / `message:updated` / `turn:started` / `turn:settled`). Composes no
opinion context; instead it exposes **protected seams** with neutral defaults
(assembly, turn scope, recoverable execution, error handling, attachments,
suspension parking, submissions, stability waiters) that an opinionated
composition overrides.
_Avoid_: "chat" as in the `cf_agent_*` protocol bundle — that sense lives in
Hosting/ISSUE-030 (see the context map's overloaded-term watchlist).

**Think**:
The opinions composition (`think.ts`, `extends ChatAgent`; ADR-0002 layer 3):
recovery policy, overflow/compaction guard, channels, actions/HITL, submissions,
skills, workspace/fetch tools, scheduled tasks, delegation-as-tools. It plugs
into ChatAgent exclusively through the public+protected surface (the promotion
rule — grep-verified), and exposes the remaining overridable subclass API
(`getActions`, `getSkills`, `configureChannels`, …). Like Agent, it owns no
domain language of its own — every behavioral term belongs to a wired context.
_Avoid_: treating Think (or ChatAgent) as a context; both are composition roots.
