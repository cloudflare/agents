# Agent Tools

Agent tools are the orchestration layer that lets a parent agent run a
chat-capable sub-agent as part of a larger operation. The shipped V1 follows
[`rfc-helper-sub-agent-orchestration.md`](./rfc-helper-sub-agent-orchestration.md).

The parent owns a framework table, `cf_agent_tool_runs`, that records each
logical run by `runId`: parent tool call id, child class, safe input preview,
display order, status, summary, and terminal error metadata. The child remains a
normal sub-agent facet and owns the full chat transcript plus resumable stream
chunks. For Think children, `cf_agent_tool_child_runs` maps `runId` to the
underlying Think request and stream ids.

`runAgentTool(Cls, options)` is the foundational API. It inserts the parent row
before waking the child, starts the child adapter idempotently by `runId`,
forwards child `UIMessageChunk` bodies to parent clients as
`agent-tool-event` frames, records a terminal state, and retains the child facet
for replay and drill-in. `agentTool(Cls, options)` is a small AI SDK tool
factory layered on top for model-selected dispatch.

The React surface is intentionally headless. `applyAgentToolEvent` reconstructs
child `UIMessage.parts` from opaque chunk bodies and groups runs by parent tool
call id; `useAgentToolEvents` subscribes to the existing parent connection and
deduplicates replay/live races. Applications own layout, panels, and drill-in
UI.

V1 supports Think children. Cancellation is bridged through the live observer
stream rather than serializing `AbortSignal` across Durable Object RPC: when the
parent operation aborts, it cancels the child tail reader, whose `cancel()`
callback aborts the child Think turn locally. If a parent restarts while a run
is non-terminal, V1 replays stored chunks and marks the parent row
`interrupted`; live-tail reattach is deferred.

## Tradeoffs

- Runs and facets are retained by default so refresh, drill-in, and debugging
  work after completion. Applications must call `clearAgentToolRuns()` when
  clearing chat history or enforcing retention.
- The parent registry stores input previews, not raw inputs, to avoid creating a
  second prompt store.
- `AIChatAgent` support is intentionally deferred until it can satisfy the same
  stream, recovery, and cancellation adapter contract.

## History

- [`rfc-helper-sub-agent-orchestration.md`](./rfc-helper-sub-agent-orchestration.md)
  — accepted V1 direction for `runAgentTool`, `agentTool`, event forwarding,
  replay, and cleanup.
