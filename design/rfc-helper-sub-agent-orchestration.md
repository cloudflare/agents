# RFC: Agent tool orchestration

Status: accepted

Related:

- [`sub-agent-routing.md`](./sub-agent-routing.md) — shipped nested Durable Object addressing, used as the substrate.
- [`rfc-sub-agent-routing.md`](./rfc-sub-agent-routing.md) — rationale for externally addressable sub-agents.
- [`think.md`](./think.md) — Think's turn, streaming, session, and recovery model.
- [`think-vs-aichat.md`](./think-vs-aichat.md) — relationship between Think and AIChatAgent.
- [`../examples/agents-as-tools`](../examples/agents-as-tools) — empirical prototype for this RFC.
- [`../wip/inline-sub-agent-events.md`](../wip/inline-sub-agent-events.md) — chronological worklog and discarded designs.
- [cloudflare/agents#1377](https://github.com/cloudflare/agents/issues/1377) — user report that exposed the missing pattern.

## Summary

Promote the `examples/agents-as-tools` pattern into framework APIs for running
agents as tools inside a parent agent's work.

The parent should be able to dispatch one or more agent-tool sub-agents, observe
their chat chunks and lifecycle events, forward those events to its own clients,
and keep enough durable state for reconnect, refresh, drill-in, and later
inspection.

This RFC adopts two public shapes over the same underlying mechanism:

1. `runAgentTool(Cls, { input, ...options })` — an imperative API for
   deterministic workflows, background jobs, staged reports, and non-LLM
   orchestration.
2. `agentTool(Cls, options)` — a tool factory for the common case where the
   parent LLM chooses when to dispatch an agent tool.

Both shapes use existing `subAgent(Cls, name)` semantics. We are not renaming
the shipped sub-agent routing primitive.

## Glossary

- **Sub-agent / facet**: the existing storage and routing primitive created by
  `subAgent(Cls, name)`. It gives a child Durable Object its own SQLite,
  clients, and nested URL.
- **Chat-capable agent**: a `Think` or `AIChatAgent` subclass that can run a
  programmatic chat turn and persist/replay `UIMessageChunk`s.
- **Agent tool**: a chat-capable sub-agent that a parent starts as part of
  another operation. It is still a normal sub-agent; "agent tool" describes the
  orchestration role.
- **AI SDK tool**: a model-call tool entry returned from `getTools()`. The
  `agentTool(...)` factory creates one of these entries and wires it to
  `runAgentTool(...)`.
- **Agent tool run**: one durable execution identified by `runId`, with a
  parent registry row, child run mapping, retained transcript, and optional
  parent tool-call association.

## Problem

The framework has two pieces that almost solve "agents as tools":

- `subAgent(Cls, name)` creates colocated child Durable Objects with isolated
  SQLite and direct routing.
- `Think` and `AIChatAgent` already have durable chat streams, replay, tools,
  programmatic turns, and cancellation.

But it does not have the connecting orchestration layer. A parent can manually
spawn a child and call methods on it, but users have to reinvent:

- creating an agent tool run record before work starts
- forwarding agent tool chat chunks to the parent connection
- synthesizing `started`, `finished`, `error`, `aborted`, and `interrupted`
  lifecycle events
- demultiplexing multiple agent tools under one parent tool call
- replaying agent tool timelines on reconnect or refresh
- preserving agent tool storage for drill-in after the parent turn completes
- propagating cancellation across Durable Object RPC
- gating drill-in URLs so arbitrary agent tool ids do not spawn fresh facets

Issue #1377 originally described this as a `ResumableStream` limitation: the
class is named generically, but its table names and wire type are chat-specific.
That observation was correct, but the better design is not a second
`ResumableStream` on the parent. Agent tool work belongs to the dispatched
agent. Each agent tool should be a real chat-capable sub-agent with its own
stream and SQLite; the parent should forward that agent's stream into the
current UI.

The prototype in `examples/agents-as-tools` validates that shape with a Think
parent, Think agent tools, multi-turn helpers, parallel fan-out, drill-in,
durable replay, cancellation propagation, and a production
`onBeforeSubAgent` registry gate.

## Proposal

### Mental model

```
Browser ──ws──▶ Parent chat agent
                 │
                 ├─ normal parent chat response
                 │
                 └─ agent-tool-event frames under parent tool calls
                       │
                       ├─ Agent tool chat sub-agent A
                       ├─ Agent tool chat sub-agent B
                       └─ Agent tool chat sub-agent C
```

The browser stays connected to the parent. Agent tools are normal sub-agents,
not synthetic in-memory tasks. Each dispatched agent owns its messages, tools,
model, resumable stream, and SQLite. The parent stores a lightweight registry of
agent tool runs so it can replay and gate access.

### Agent tools are ordinary chat agents

Agent tools should be ordinary chat-capable agent subclasses. A class becomes an
agent tool because the parent dispatches it with `runAgentTool` or wraps it with
`agentTool`, not because the class inherits from a special base.

The first implementation should be Think-only because that is what the
prototype validated and Think already has the strongest programmatic turn
surface. The public API should still not be Think-shaped. `AIChatAgent` parents
and tools should be supported after an adapter proves the same stream,
recovery, and cancellation contract. Mixed Think/AIChatAgent pairs are a design
target, not a Phase 1 requirement.

The framework-provided runner owns the protocol bridge:

- create an agent tool sub-agent with `subAgent(Cls, runId)`
- drive the agent tool turn via `saveMessages(..., { signal })`
- forward `MSG_CHAT_RESPONSE` chunks to the parent as agent tool events
- keep the agent tool's own `_resumableStream` as the durable source of truth
- read stored chunks, final text, and stream errors for replay/result synthesis
- prevent concurrent framework-driven turns on one agent tool instance

Sub-agent scheduling is now available through the normal `Agent` scheduling
APIs. Facets still do not own independent physical alarm slots, but the
top-level parent stores child-owned schedule rows with an owner path and routes
callbacks back into the owning child when the alarm fires. This matters for
agent-tool recovery: a child can schedule recovered continuations from inside
the facet, and that callback runs with the child as `this`.

There should not be a separate public base class for agent tools unless the
implementation later proves it needs one. The shared base class extracted in
`examples/agents-as-tools` is prototype structure, not proposed public API.

The runner should treat execution and observation as separate concerns. Starting
an agent tool creates durable work identified by `runId`; forwarding events to
the parent is an observer of that work. Dropping the observer stream should not
automatically cancel execution. Explicit cancellation should be a separate path
that targets the run by id.

Agent tools may dispatch their own agent tools. The substrate supports
arbitrary nesting because facets nest: an agent tool's `runAgentTool` produces
another framework-managed run with its own `cf_agent_tool_runs` row in the
nested parent. Observation does not bridge upward by default; nested runs are
visible only to their immediate parent's clients. Tracing across the chain
should rely on `runId` as the join key.

### Parent-side agent tool run registry

The parent maintains an internal framework-owned agent tool run table,
conceptually:

```sql
create table cf_agent_tool_runs (
  run_id text primary key,
  parent_tool_call_id text,
  agent_type text not null,
  input_preview text,
  input_redacted integer not null default 1,
  status text not null,
  summary text,
  error_message text,
  display_metadata text,
  display_order integer not null default 0,
  started_at integer not null,
  completed_at integer
);
```

This is separate from the existing sub-agent registry. The sub-agent registry
answers "does this facet exist?" The agent tool run registry answers "what
parent work caused this run to exist, where should its events render, and what
should replay synthesize?"

This table lives in parent storage because replay is parent-shaped. The child
agent owns its own transcript and durable chunks, but only the parent knows
which parent tool call caused the child run, which sibling order to render, and
which lifecycle event to synthesize after reconnect.

The mechanics should be framework-owned:

- inserting the row before the child is started
- updating status as the child starts, completes, errors, or aborts
- preserving `parentToolCallId`, `displayOrder`, input preview, summary, and
  error metadata for replay
- reconciling non-terminal rows after parent restart
- exposing typed APIs for listing, replaying, cancelling, and deleting runs

Applications should own policy, not the registry implementation:

- retention and garbage-collection rules
- whether clearing chat history also deletes agent tool runs and facets
- access-control decisions for drill-in and replay
- optional display metadata such as labels or grouping
- whether full inputs or outputs should be hidden, redacted, omitted from app
  UI, or explicitly persisted

Rows are retained after completion by default. Retention is required for
post-run refresh, drill-in, and later inspection. Applications can clear or GC
old agent tool runs explicitly.

Raw input persistence is opt-in. The framework should persist and broadcast an
`inputPreview` by default, not the full `input`. This avoids turning the
orchestration table into a second copy of prompts, credentials, file contents,
or other sensitive data. Applications that need full input replay can opt into
their own storage/policy, but the default registry should be safe to inspect.

### Run status lifecycle

`runId` carries one logical status, but different layers see it differently.
The framework should keep this table truthful:

| Status        | Terminal | Where it can be observed                                                  | Meaning                                                          |
| ------------- | -------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `starting`    | no       | parent registry, child adapter inspection                                 | row inserted, child not yet confirmed running                    |
| `running`     | no       | parent registry, child adapter inspection                                 | child has started a chat turn                                    |
| `completed`   | yes      | parent registry, child adapter inspection, observer state, `runAgentTool` | child reached a normal terminal state                            |
| `error`       | yes      | parent registry, child adapter inspection, observer state, `runAgentTool` | child threw, surfaced a stream error, or failed result synthesis |
| `aborted`     | yes      | parent registry, child adapter inspection, observer state, `runAgentTool` | run was explicitly cancelled by a parent abort signal            |
| `interrupted` | yes      | parent registry, observer state, `runAgentTool`                           | parent reconciled a non-terminal run it could not safely resume  |

`interrupted` is **parent-only** by design. The child does not declare itself
interrupted; only a parent that lost its observer or cannot live-tail can
record that resolution.

Once a run reaches a terminal state in the parent registry, that state is
authoritative. A late cancel must not rewrite `completed` / `error` as
`aborted`; a late reconciliation must not rewrite `aborted` as `interrupted`.

### Child-side run mapping

`runId` is the only public id. It names the durable agent-tool run across
replay, drill-in, cancellation, cleanup, logs, and parent-side UI state.

Chat internals should not be forced to use `runId` as their own request id.
Instead, the child adapter should persist the mapping from orchestration run to
chat turn and stored stream:

```sql
create table cf_agent_tool_child_runs (
  run_id text primary key,
  request_id text,
  stream_id text,
  status text not null,
  summary text,
  error_message text,
  started_at integer not null,
  completed_at integer
);
```

For V1, an agent-tool run usually maps to one child chat turn and one stored
stream. Keeping the ids distinct still matters:

- `runId` is the product/orchestration id.
- `requestId` is the chat turn / abort-registry id.
- `streamId` is the resumable-stream persistence id.

This avoids baking in "one agent-tool run equals one chat turn." Future versions
can evolve the child table into a `cf_agent_tool_child_turns` table with
`(run_id, turn_index, request_id, stream_id)` if one logical agent-tool run
needs multiple child turns.

The child-side mapping must be authoritative for recovery. If the parent crashes
after the child starts but before the parent stores generated ids, the parent
must be able to recover `requestId` / `streamId` from the child by asking for
`runId`.

The start operation is idempotent by `runId`: if the child already has a run for
that id, it returns the existing run state instead of starting a duplicate chat
turn. Cancellation and replay also operate by `runId`; the adapter performs any
internal lookup to request and stream ids.

Optional caller-supplied chat request ids may still be useful later, but agent
tool recovery should not depend on making Think or AIChatAgent expose request-id
semantics as public API.

### Child adapter contract

`ChatCapableAgentClass` is a structural framework-internal contract, not a
public superclass. User subclasses of supported chat bases are eligible
automatically:

- `class Researcher extends Think { ... }`
- `class Researcher extends AIChatAgent { ... }`

The framework provides adapters for those bases. Internally, the adapter for a
child instance must support:

```ts
interface AgentToolChildAdapter<Input = unknown, Output = unknown> {
  startAgentToolRun(
    input: Input,
    options: {
      runId: string;
      signal?: AbortSignal;
    }
  ): Promise<AgentToolRunInspection<Output>>;

  cancelAgentToolRun(runId: string, reason?: unknown): Promise<void>;

  inspectAgentToolRun(
    runId: string
  ): Promise<AgentToolRunInspection<Output> | null>;

  getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]>;

  tailAgentToolRun?(
    runId: string,
    options?: {
      afterSequence?: number;
      signal?: AbortSignal;
    }
  ): Promise<ReadableStream<AgentToolStoredChunk>>;
}

interface AgentToolRunInspection<Output = unknown> {
  runId: string;
  status: "starting" | "running" | "completed" | "error" | "aborted";
  requestId?: string;
  streamId?: string;
  output?: Output;
  summary?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

interface AgentToolStoredChunk {
  sequence: number;
  body: string; // JSON-encoded UIMessageChunk
}
```

The child cannot report `interrupted`; that is parent-only. The parent maps a
non-terminal child inspection into `interrupted` when reconciling.

`AgentToolStoredChunk.sequence` is the child's stream-local index. The parent
stamps a separate per-run envelope `sequence` when emitting
`agent-tool-event` frames. The two are kept aligned in V1 (`envelope.sequence`
== `chunk.sequence`) so durable replay and original live observation share a
single client-side dedup key. A future implementation that introduces parent
back-pressure or batching can diverge them, but only by also exposing the
mapping to the React surface.

V1 requires `startAgentToolRun`, `cancelAgentToolRun`,
`inspectAgentToolRun`, and `getAgentToolChunks`. `tailAgentToolRun` is optional
and future-facing. V1 does not require any adapter to implement late live-tail
reattach.

Required semantics:

- `startAgentToolRun` is idempotent by `runId`. Existing terminal runs return
  their terminal inspection; existing running runs return their running
  inspection; no duplicate chat turn is created.
- `cancelAgentToolRun` is idempotent. Terminal runs are not rewritten as
  `aborted` by a late cancel.
- `inspectAgentToolRun` is authoritative for recovery and returns the internal
  `requestId` / `streamId` mapping when available.
- `getAgentToolChunks` is replay-only. It returns stored chunks and does not
  imply the run is live.
- `tailAgentToolRun`, when implemented, is observation-only. Cancelling the tail
  stream detaches the observer; it does not cancel execution.

This gives the implementation a precise boundary without making application
authors inherit from an `AgentTool` or `HelperAgent` base class.

### Agent tool event protocol

The parent emits agent tool events to its own clients:

```ts
type AgentToolEvent =
  | {
      kind: "started";
      runId: string;
      agentType: string;
      inputPreview?: unknown;
      order: number;
      display?: {
        name?: string;
        icon?: string;
      };
    }
  | {
      kind: "chunk";
      runId: string;
      body: string; // JSON-encoded UIMessageChunk
    }
  | {
      kind: "finished";
      runId: string;
      summary: string;
    }
  | {
      kind: "error";
      runId: string;
      error: string;
    }
  | {
      kind: "aborted";
      runId: string;
      reason?: string;
    }
  | {
      kind: "interrupted";
      runId: string;
      error: string;
    };

type AgentToolEventMessage = {
  type: "agent-tool-event";
  parentToolCallId?: string;
  sequence: number;
  replay?: true;
  event: AgentToolEvent;
};
```

`chunk.body` is opaque JSON-encoded `UIMessageChunk`. The framework should not
invent a second vocabulary for text, reasoning, tool calls, and future AI SDK
parts. The client can rebuild agent tool message parts with the same
`applyChunkToParts` primitive used for chat responses.

`sequence` is monotonic per agent tool run as stamped by the parent. Client-side
dedup keys must include `(parentToolCallId, runId, sequence)` because parallel
agent tools under one parent tool call all legitimately start at sequence 0.
Imperative runs without a `parentToolCallId` use `(null, runId, sequence)` for
dedup.

Terminal events are distinct so the UI can render failed, cancelled, and
interrupted runs differently. `error` is for child/tool failure, `aborted` is
for explicit cancellation, and `interrupted` is for parent recovery limitations
or lost observers.

`error` / `reason` fields are strings in V1 to keep the wire shape minimal, but
downstream code should treat them as forward-compatible with a richer
`{ message, code?, retryable? }` object. A future protocol revision can extend
terminal payloads without breaking clients that read a string today.

### React/client surface

V1 should ship a small frontend surface. Protocol types alone are not enough:
every app would otherwise need to reimplement the fragile client work from
`examples/agents-as-tools`: raw WebSocket filtering, replay/live dedupe,
chunk accumulation, per-tool-call grouping, sibling ordering, and reset handling.

The hook needs a stable way to listen to non-chat parent WebSocket frames. If
`useAgent` does not already expose a public raw-message subscription API, V1
should add one rather than making `useAgentToolEvents` reach into private
client fields. Agent-tool events are part of the parent connection protocol, so
their consumer should be built on a supported client extension point.

The split should be:

- `agents/chat`: protocol types and a pure reducer.
- `agents/react`: a hook that subscribes to an existing `useAgent` connection.
- application code: rendering, layout, drill-in panels, and styling.

Sketch:

```ts
type AgentToolRunState = {
  runId: string;
  agentType: string;
  parentToolCallId?: string;
  inputPreview?: unknown;
  order: number;
  display?: {
    name?: string;
    icon?: string;
  };
  status: "running" | "completed" | "error" | "aborted" | "interrupted";
  parts: UIMessage["parts"];
  summary?: string;
  error?: string;
  subAgent: { agent: string; name: string };
};

type AgentToolEventState = {
  runsById: Record<string, AgentToolRunState>;
  runsByToolCallId: Record<string, AgentToolRunState[]>;
};

function applyAgentToolEvent(
  state: AgentToolEventState,
  message: AgentToolEventMessage
): AgentToolEventState;

function useAgentToolEvents(options: { agent: ReturnType<typeof useAgent> }): {
  runsById: Record<string, AgentToolRunState>;
  runsByToolCallId: Record<string, AgentToolRunState[]>;
  unboundRuns: AgentToolRunState[];
  getRunsForToolCall(toolCallId: string): AgentToolRunState[];
  resetLocalState(): void;
};
```

`unboundRuns` covers imperative `runAgentTool(...)` calls that did not pass
`parentToolCallId`. Apps that only render agent tools inside chat tool-call
parts can ignore it; apps that drive runs from `@callable`, HTTP handlers, or
non-chat UI can render directly from this list.

The reducer/hook owns:

- filtering `agent-tool-event` messages from the parent connection
- deduping replay/live races by `(parentToolCallId, runId, sequence)`
- applying JSON `UIMessageChunk` bodies via `applyChunkToParts`
- grouping runs by `parentToolCallId`
- sorting siblings by `order`
- mapping protocol status into `running | completed | error | aborted | interrupted`
- exposing `subAgent: { agent: agentType, name: runId }` for drill-in wiring

The hook should not own:

- panel UI
- Streamdown or other rendering choices
- opening drill-in connections automatically
- server-side cleanup policy

Clear/reset needs coordination but should not force a styled component. V1 can
expose `resetLocalState()` and document that apps should delete retained
agent-tool runs on the server before clearing chat history, e.g.

```ts
await agent.call("clearAgentToolRuns");
agentTools.resetLocalState();
clearHistory();
```

A future higher-level helper may coordinate chat clearing and agent-tool cleanup
for `useAgentChat`, but the V1 hook should keep the boundary headless.

The expected `useAgentChat` integration is:

```tsx
const agent = useAgent({ agent: "Assistant", name: userId });
const { messages } = useAgentChat({ agent });
const agentTools = useAgentToolEvents({ agent });

return messages.map((message) => (
  <Message message={message}>
    {message.parts.map((part) =>
      part.type === "tool-call" ? (
        <ToolCallPart
          part={part}
          runs={agentTools.getRunsForToolCall(part.toolCallId)}
        />
      ) : (
        <NormalPart part={part} />
      )
    )}
  </Message>
));
```

Apps with imperative-only runs render from `agentTools.unboundRuns` directly
without touching `useAgentChat`.

### V1 observer semantics

V1 supports two observer paths:

1. **Original live observation** while the parent operation that called
   `runAgentTool` is still alive.
2. **Durable replay** via `getAgentToolChunks(runId)` after reconnect, refresh,
   or parent restart.

V1 does not promise late live-tail reattach. If the original observer disappears
and the child is still running when the parent reconciles, the parent replays
stored chunks and then marks the parent row `interrupted` with a precise error,
for example:

> Agent tool run was still running, but live-tail reattachment is not supported
> in this runtime.

This is a V1 runtime limitation, not the intended end state. The RFC keeps
`tailAgentToolRun?(runId, { afterSequence })`, stable `runId`, stored chunk
`sequence`, and observer/run cancellation separation so a later implementation
can add live-tail reattach without changing the public `runAgentTool` /
`agentTool` surface.

### Recovery semantics

An agent tool run is durable work; live streaming is one way to observe it.

`runId` is the stable join key across:

- the parent row in `cf_agent_tool_runs`
- the child sub-agent name by default
- the child-side `cf_agent_tool_child_runs` row
- replay, drill-in, cancellation, and cleanup APIs

The intended lifecycle is:

1. Parent inserts a row with `status = "starting"` before waking the child.
2. Parent starts the child run with `runId` and the input.
3. Child persists the `runId -> requestId -> streamId` mapping.
4. Parent observes the child stream and forwards `agent-tool-event` frames.
5. Parent marks the row `completed`, `error`, or `aborted` after the child
   reaches a terminal state.

V1 keeps persisted run status about execution, not observation:

- `starting` / `running` are non-terminal execution states.
- `completed` / `error` / `aborted` / `interrupted` are terminal execution
  states.
- `detached` is not a V1 persisted run status. It is a future observer state
  meaning "the run may still be valid, but this parent/client is not currently
  attached to live output."

If the parent crashes or is evicted while observing, the child run should not be
cancelled merely because the observer disappeared. On restart, the parent
reconciles each `starting` / `running` row:

- If there is no matching child sub-agent or child run, the child never started
  or was deleted; mark the run `interrupted`.
- If the child reports `completed`, replay stored chunks, read the final output,
  and mark the parent row `completed`.
- If the child reports `error` or `aborted`, replay stored chunks and mark the
  parent row with that terminal status.
- If the child reports `running`, V1 replays stored chunks and marks the row
  `interrupted` with the unsupported-live-tail message above. A future
  implementation that supports `tailAgentToolRun` can instead attach a new
  observer from the last forwarded sequence.

Some edge cases follow from that split:

- A parent may crash after inserting the row but before the child starts. On
  reconciliation, "no matching child run" means `interrupted` unless the caller
  explicitly requested retry/restart semantics. The default should not re-run
  arbitrary agent work after an ambiguous crash.
- A parent may crash after the child starts but before the parent sees
  `requestId` or `streamId`. The child-side mapping must be authoritative enough
  for the parent to recover those ids from `runId`.
- Multiple browser tabs, reconnects, or parent retries may observe the same run.
  Observation is fan-out; only one execution exists for a `runId`.
- Explicit cancel is idempotent. If the child already reached a terminal
  `completed` / `error` state, a late cancel must not overwrite it as `aborted`.
- Clearing retained history while a run is `starting` / `running` cancels the
  run first and then deletes the registry row and child facet. Skipping the
  cancel step would leave orphaned LLM work running with no observers and no
  way to surface its result, so V1 takes the explicit "cancel, then clean"
  ordering instead of best-effort deletion.

The hardest boundary is parent-chat recovery. If an `agentTool(...)` call was
part of a parent LLM turn, recovering the child run is not enough to resume the
parent turn unless the parent chat recovery machinery can also continue from the
tool result. Until that is implemented, a parent crash during an LLM-dispatched
agent tool may recover the child transcript but still mark the parent-side tool
call as interrupted. Imperative `runAgentTool(...)` calls have a cleaner
recovery story because application code can inspect the run later without
reconstructing an in-flight LLM turn.

Sub-agent schedules and delegated keepAlive remove the earlier blockers for
child-side recovery. A facet still does not own an independent physical alarm,
but a child can schedule logical callbacks through the top-level parent's alarm,
hold a root-owned heartbeat ref while work is active, and register facet fibers
in a small root-side index. Think chat recovery and `runFiber()` therefore work
for long-lived agent-tool facets even when the child is otherwise idle: the root
alarm routes recovery checks back into the child that owns the fiber row.

The remaining V1 limitation is not "facets cannot recover"; it is "the parent
observer may be gone." V1 should still guarantee durable replay and honest
terminal/interrupted state. `detached` and full live reattach are observer
features that can be added once `tailAgentToolRun` / live-tail support exists,
without changing the public `runAgentTool` / `agentTool` surface.

### Imperative API: `runAgentTool`

Imperative orchestration is first-class:

```ts
const result = await this.runAgentTool(Researcher, {
  input: { query: "Compare HTTP/3 and gRPC" },
  parentToolCallId,
  displayOrder: 0,
  signal: abortSignal
});

result.runId;
result.summary;
result.status; // "completed" | "error" | "interrupted" | "aborted"
```

This is the API for deterministic multi-stage workflows, reports kicked off via
`@callable` or HTTP rather than chat, parent agents that extend `Agent`, and
fan-out/fan-in code that wants `Promise.allSettled`.

Sketch:

```ts
interface RunAgentToolOptions<Input> {
  input: Input;
  runId?: string;
  parentToolCallId?: string;
  displayOrder?: number;
  signal?: AbortSignal;
}

interface RunAgentToolResult<Output = unknown> {
  runId: string;
  agentType: string;
  status: "completed" | "error" | "interrupted" | "aborted";
  output?: Output;
  summary?: string;
  error?: string;
}

abstract class Agent {
  protected runAgentTool<Cls extends ChatCapableAgentClass, Input, Output>(
    cls: Cls,
    options: RunAgentToolOptions<Input>
  ): Promise<RunAgentToolResult<Output>>;
}
```

`runAgentTool` is idempotent by `runId`. If the caller passes a `runId` that
already has a row:

- Terminal runs return the existing `RunAgentToolResult` without re-running.
- Non-terminal runs do not start duplicate work. In V1, a caller that is not
  the original live observer replays stored chunks and receives `interrupted`
  if the child is still running, matching the no-late-live-tail rule. A future
  implementation with `tailAgentToolRun` can attach to the existing live run.

This makes `runAgentTool` safe to call from retry paths, alarms, and reconnect
recovery without accidentally duplicating LLM work.

For V1, `runAgentTool` should not require a runtime schema. Imperative callers
already have application code at the call site, so TypeScript generics are enough
for the first implementation:

```ts
type ResearchInput = { query: string };
type ResearchOutput = { summary: string };

const result = await this.runAgentTool<
  typeof Researcher,
  ResearchInput,
  ResearchOutput
>(Researcher, {
  input: { query }
});
```

The result always has `summary?: string` as the baseline output because chat
agents naturally produce assistant text. Structured `output?: Output` is
optional and should only be present when the agent tool has an explicit
structured-output contract.

### Tool API: `agentTool`

`agentTool` wraps `runAgentTool` for LLM-selected dispatch:

```ts
getTools() {
  return {
    research: agentTool(Researcher, {
      description: "Research one topic in depth.",
      displayName: "Researcher",
      inputSchema: z.object({
        query: z.string().min(3)
      }),
      outputSchema: z.object({
        summary: z.string()
      })
    }),

    plan: agentTool(Planner, {
      description: "Write an implementation plan.",
      inputSchema: z.object({
        description: z.string().min(5)
      })
    })
  };
}
```

The generated tool receives the AI SDK `toolCallId` and `abortSignal`, calls
`runAgentTool(Cls, { parentToolCallId: toolCallId, signal: abortSignal })`,
returns the agent tool's structured output or summary to the parent LLM, and
forwards agent tool events under the matching tool part for the browser.

For V1, `inputSchema` is required on `agentTool(...)` because the parent LLM
needs a runtime schema for tool selection and validation. `outputSchema` is
optional. If it is omitted, the generated tool returns the agent tool's text
summary. If it is present, the framework validates structured output explicitly
returned by the child adapter before returning it to the parent LLM.

V1 should not perform automatic extraction of structured output from prose. If
`outputSchema` is set and the child only produces a text summary, or returns
output that fails validation, result synthesis marks the run `error` with a
validation message. Applications that want structured output should make that
part of the child agent's own prompt/tool contract rather than relying on a
second hidden model or parser pass.

The tool result returned to the parent LLM depends on terminal status:

- `completed` returns the structured `output` (when `outputSchema` is set) or
  the text `summary`.
- `error` returns a structured failure (`{ ok: false, error }`) so the LLM can
  decide whether to retry or surface the failure to the user.
- `aborted` returns `{ ok: false, error: "agent tool run was cancelled" }`.
- `interrupted` returns
  `{ ok: false, error: "agent tool run was interrupted; no recoverable output" }`
  so the LLM does not hallucinate a successful summary from missing data.

The exact wire shape can evolve, but the principle is: the LLM never sees a
silent empty result for a non-`completed` run.

`agentTool` shines when the LLM is the dispatcher. It should not be the only
API, because many workflows dispatch agent tools from deterministic application
code.

Model-facing and user-facing labels should be separate. `description` is for
tool selection by the parent LLM; optional `displayName`, `icon`, or other
display metadata is for UI. The framework should carry display metadata through
the parent registry and `started` event without making it part of the model
prompt.

Longer term, the framework can add a reusable contract so the same input/output
definition feeds both `agentTool` and `runAgentTool`, for example:

```ts
const researcherTool = defineAgentTool(Researcher, {
  inputSchema: z.object({ query: z.string().min(3) }),
  outputSchema: z.object({ summary: z.string() })
});
```

or an equivalent class-level convention. V1 should not require that extra
abstraction; it should leave room for it without baking inconsistent schemas
into the core API.

### Drill-in and access control

Agent tools remain externally addressable through the existing sub-agent routing
primitive:

```ts
useAgent({
  agent: "Assistant",
  name: userId,
  sub: [{ agent: "Researcher", name: runId }]
});
```

The framework agent tool machinery should install or document a strict
`onBeforeSubAgent` gate: a request for `(agentType, runId)` should only reach
the child if the parent has a matching agent tool run row. Applications can
customize the policy, but the production default should not let arbitrary run
ids spawn fresh facets by URL guessing.

`runId` alone is not a capability. Drill-in URLs should always be reached
through the parent's existing identity (`useAgent({ agent: parent, name:
userId, sub: ... })`) so that authentication and tenancy come from the parent.
The framework should not encourage handing `runId`s out as bearer tokens.

Drill-in observers can read the child's chat freely. While a framework-driven
agent tool turn is running on a child, the framework holds an exclusive claim
on that child instance: concurrent `runAgentTool` calls into the same `runId`
return the existing inspection (idempotent start) instead of starting a second
turn. A drill-in user sending a chat message during a framework-driven run
should be deferred or rejected with a clear error rather than silently
interleaved with the in-flight turn. The exact policy is the chat base's
responsibility, but V1 should at minimum not corrupt the in-flight turn.

### Cancellation

Cancellation flows parent to the agent tool through `AbortSignal`:

1. Parent chat/tool/request is cancelled.
2. `runAgentTool` explicitly cancels the child run by `runId`.
3. The agent tool aborts a per-turn `AbortController`.
4. The agent tool passes that signal into `saveMessages(..., { signal })`.
5. The parent detaches any live observer stream for that run.
6. The agent tool aborts the inference loop and reports an aborted result.

This depends on the `saveMessages({ signal })` API added after the prototype.
We keep the `saveMessages` name for now; renaming it to `runTurn` or similar is
out of scope for this RFC.

Important distinction: cancelling an observer stream is not by itself a request
to cancel the run. A browser disconnect, parent restart, or failed replay
connection should detach observation. Only an explicit abort signal from the
parent's active operation should cancel execution.

### Observability and cost

Agent tools can multiply LLM cost: a parent LLM that fans out five `research`
calls in parallel triggers five child Think turns, each with their own model
calls. The framework should expose lifecycle hooks so application code can
log, meter, and audit runs without monkey-patching `runAgentTool`:

```ts
interface AgentToolLifecycleHooks {
  onAgentToolStart?(run: AgentToolRunInfo): void | Promise<void>;
  onAgentToolFinish?(
    run: AgentToolRunInfo,
    result: {
      status: "completed" | "error" | "aborted" | "interrupted";
      summary?: string;
      error?: string;
    }
  ): void | Promise<void>;
}
```

The exact placement (parent class hook, configuration on `runAgentTool`, or
both) is an implementation detail. The principle is that `runId` is the join
key for parent registry, child transcript, logs, and traces, and the framework
should make it easy to wire that join key into existing observability stacks.

V1 does not commit to a specific tracing format, billing integration, or
sampling strategy. Hooks are enough to defer those decisions to applications.

V1 should still provide a coarse concurrency guard so cost control is not
entirely app folklore. A parent-level option such as
`maxConcurrentAgentTools` should limit currently running agent tool runs and
fail fast with a clear `error` event when exceeded. Fine-grained quotas,
token-based budgets, and billing integration can layer on top of lifecycle
hooks later.

### Retention and cleanup

V1 should retain agent tool runs by default and ship one explicit cleanup API.
The default lifecycle is:

- `runAgentTool` creates a fresh run id unless the caller provides one.
- The framework inserts a parent-side `cf_agent_tool_runs` row before starting
  the child.
- The agent tool sub-agent is retained after completion.
- The agent tool run row is retained after completion.
- `clearHistory`, account/workspace deletion, or app-specific cleanup explicitly
  deletes retained agent tool runs and agent tool facets.

Automatic deletion after completion is not the default because it breaks
post-run refresh, replay, drill-in, and debugging.

The V1 cleanup surface should be small:

```ts
await this.clearAgentToolRuns();

await this.clearAgentToolRuns({ olderThan: Date.now() - 7 * DAY });

await this.clearAgentToolRuns({
  status: ["completed", "error", "aborted", "interrupted"]
});
```

`clearAgentToolRuns(...)` should delete both the parent registry row and the
corresponding agent tool facet by default. Deleting only the parent row would
leave an orphaned child transcript that is no longer reachable through replay or
drill-in. If a future API allows registry-only deletion, it must make that
orphaning behavior explicit.

V1 should defer automatic TTL, count-based GC, and `retain: false` on
`runAgentTool`. Those are useful policy knobs, but the first implementation only
needs the reliable primitive that applications can call from their own lifecycle
code. Sub-agent scheduling means the framework is no longer blocked on a
mechanism for future background GC; the remaining question is what retention
policy to choose.

### Think and AIChatAgent

The API should be chat-agent-family-wide, not Think-specific.

The validated prototype is Think-based, so the first implementation should land
Think support first. AIChatAgent support is a follow-up adapter milestone, not
part of Phase 1. The proposed boundary is still structural:

- the agent tool can run a programmatic chat turn
- the agent tool emits chat response chunks as `UIMessageChunk`
- the agent tool stores those chunks in the shared resumable-stream machinery
- the agent tool accepts an external `AbortSignal`
- the parent can forward agent tool chunks with `broadcast`
- the parent can reconcile a durable `runId` after its observer disappears
- the framework can provide an `AgentToolChildAdapter` for the class

Once the AIChatAgent adapter exists, both `Think` and `AIChatAgent` should
satisfy that contract. That allows:

- Think parent + Think agent tool
- Think parent + AIChatAgent agent tool
- AIChatAgent parent + AIChatAgent agent tool
- AIChatAgent parent + Think agent tool

If implementation needs an internal adapter layer, it should be hidden behind
`runAgentTool` rather than exposed as a public base class.

## Non-goals

These are intentionally out of scope for V1. They are noted so the API surface
does not silently grow to absorb them later.

- **Workflows replacement.** Cloudflare Workflows offer durable step graphs.
  Agent tools are chat-shaped: streaming, transcript-bearing, drill-in-able.
  The two compose; this RFC does not try to subsume either.
- **MCP bridging.** Agent tools are in-account, in-process Workers DOs. MCP
  tools are external RPC. Agent tools may call MCP tools; MCP-exposed tools
  may eventually wrap agent tools. V1 does neither.
- **Multi-turn agent tools.** V1 maps one `runId` to one child chat turn.
  The schemas leave room (`cf_agent_tool_child_turns`), but the API does not
  expose multi-turn semantics.
- **Automatic retry of failed/interrupted runs.** Recovery is read-only in
  V1: the framework reports honest terminal/interrupted states; retry is a
  caller decision.
- **Live tail reattach** for runs whose original observer disappeared. The
  protocol/runId/sequence design is forward-compatible; V1 reports
  `interrupted` instead.
- **Cost accounting and tracing primitives.** V1 ships lifecycle hooks; it
  does not standardize a billing or OpenTelemetry surface.
- **Cross-tenant or cross-account agent tools.** Tenancy is inherited from
  the parent's identity. Cross-boundary dispatch is an MCP/loopback concern,
  not this RFC.
- **Visual UI components.** The headless reducer/hook is the only React
  surface; styled panels are app-owned.

## Alternatives

### Add `tablePrefix` and `messageType` to `ResumableStream`

This is the direct fix proposed in #1377. It would allow a parent DO to host a
second durable stream for agent tool events.

Rejected for this feature. It stores agent tool state on the wrong DO and does
not give us drill-in, agent-owned sessions, tool surfaces, or lifecycle. Once
agent tools are real sub-agents, table collisions disappear by SQLite isolation.

The `ResumableStream` options can still be added later if a separate use case
needs multiple independent durable streams on one DO.

### Encode agent tool events as AI SDK data parts in the parent chat stream

This gives replay "for free" because agent tool events ride the parent chat
stream.

Rejected. It uses lower-level/internal stream transformation points, couples
agent tool lifecycle to the parent's assistant message, and makes post-run
inspection awkward. Agent tool events are not really parent assistant tokens.

### Store agent tool events in parent state

Rejected. Broadcasting state re-sends the whole state object and becomes
quadratic for long agent tool runs. It also turns an append-only event log into a
mutable state blob.

### Make the run registry app-owned

Rejected for V1. Applications should control retention, auth, and presentation
policy, but the registry mechanics are part of making `runAgentTool` reliable.
If every app owns the table, every app must also correctly implement pre-start
insertion, terminal status updates, replay ordering, cancellation bookkeeping,
and crash reconciliation.

### Require class-level input/output contracts in V1

Deferred. A single reusable contract is likely the right long-term shape, but
requiring it immediately would add a new convention to ordinary `Think` and
`AIChatAgent` subclasses before the implementation proves the exact spelling.
V1 can require `inputSchema` at the `agentTool(...)` call site and type
imperative `runAgentTool(...)` calls with generics, while leaving room for
`defineAgentTool(...)` or a class-level convention later.

### Require structured output for every agent tool

Rejected. Chat-capable agents naturally produce assistant text and durable chat
chunks. Requiring every agent tool to also produce structured JSON would make
simple summarizing helpers more cumbersome. V1 should treat `summary` as the
baseline output and make `outputSchema` opt-in.

### Extract structured output from prose automatically

Rejected for V1. An `outputSchema` should validate structured output explicitly
returned by the child adapter. Running a hidden parser or second model over the
child's prose would add cost, latency, and failure modes that are hard for
application authors to reason about. If structured output is required, make it
part of the agent tool's own contract.

### Automatically delete runs after completion

Rejected for V1. Completion is exactly when post-run inspection becomes useful:
refresh replay, drill-in, failed-run debugging, and audit trails all depend on
retaining the child facet and parent registry row. Cleanup should be explicit.

### Ship TTL/background garbage collection in V1

Deferred. Time-based and count-based cleanup are useful, but they are policy
decisions and may depend on account, workspace, or chat-history lifecycle.
Shipping `clearAgentToolRuns(...)` first gives applications a reliable primitive
without committing to default retention windows. Sub-agent scheduling means a
future TTL/GC implementation can run from either the parent or a retained
agent-tool facet, but the retention policy should still be explicit rather than
hidden in V1 defaults.

### Ship only protocol types, no client hook

Rejected for V1. It would keep the framework API technically complete while
forcing every app to copy the example's raw message listener, dedupe map,
`applyChunkToParts` reducer, grouping, ordering, and reset behavior.

### Ship styled agent-tool panels

Deferred. The common hard part is state reconstruction, not visual design.
Applications need to decide how panels look, where they appear, and whether
drill-in is available. A headless reducer/hook gives a real frontend story
without imposing UI.

### Keep only `agentTool`

Rejected. LLM-dispatched agent tools are important, but deterministic workflows
also matter. Users building reports, staged analysis, or background jobs need
plain imperative orchestration.

### Rename existing `subAgent`

Rejected. The current name is already shipped and acceptable. The new API can
use agent-tool vocabulary for the orchestration layer while continuing to build
on `subAgent` as the routing/storage primitive.

### Rename `saveMessages`

Deferred. The method does more than persistence, and a future `runTurn` name may
be clearer. This RFC does not take that churn. The new agent-tool APIs can hide
most direct `saveMessages` usage from application authors.

## Decision

Adopt this RFC as the V1 direction for agent tool orchestration:

- `runAgentTool` and `agentTool` are the server APIs.
- Agent tools are ordinary chat-capable sub-agents, supported through internal
  adapters rather than a public helper base class.
- Parent storage owns the framework-managed `cf_agent_tool_runs` registry; child
  storage owns chat transcripts, chunks, and `runId -> requestId -> streamId`
  mapping. The parent registry stores safe `inputPreview` metadata by default,
  not raw inputs.
- V1 guarantees original live observation, durable replay, explicit
  cancellation, and honest terminal/interrupted states, but not late live-tail
  reattach. Failed, cancelled, and interrupted runs have distinct terminal
  events.
- V1 ships a headless React/client reducer and hook for `agent-tool-event`
  frames.
- V1 requires `inputSchema` for `agentTool(...)`, makes structured
  `outputSchema` optional, and treats text `summary` as the baseline result.
- V1 retains runs by default and ships explicit `clearAgentToolRuns(...)`
  cleanup; TTL/background GC and `retain: false` are deferred.

### Suggested phasing

The implementation does not need to land all at once. A reasonable order is:

1. Think parent + Think agent tools, server side: `runAgentTool`, `agentTool`,
   parent registry, child mapping, idempotent start, cancellation, lifecycle
   hooks, `maxConcurrentAgentTools`, `clearAgentToolRuns`.
2. Headless React surface: protocol types, `applyAgentToolEvent` reducer,
   stable raw-message subscription, `useAgentToolEvents` hook, `unboundRuns`.
3. `AIChatAgent` parity: child adapter, mixed Think/AIChatAgent dispatch,
   docs and examples.
4. Ergonomics: `defineAgentTool(...)` or class-level reusable contracts;
   richer error shape; structured-output convenience.
5. Live-tail reattach via `tailAgentToolRun`; `detached` observer state;
   tracing/cost integrations.

After Phase 1 lands, `examples/agents-as-tools` should be rewritten on top of
the new APIs so the empirical prototype tracks the shipped surface.
