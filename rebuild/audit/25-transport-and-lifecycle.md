# 25 — Transport-free agents: conversation events, lifecycle, adapters

**Refactor wave.** Docs 00–24 produced a working system, but `app/agent.ts` and
`app/think.ts` still speak transport: they parse JSON frames, hold
`Connection`s, and call `broadcast(JSON.stringify({ type: "cf_agent_..." }))`.
This doc respecs the boundary. Decisions already made (do not relitigate):

1. **Methods are canonical.** Agents expose typed public methods; there is NO
   generic command envelope or `dispatch(command)` union. Adapters call
   methods directly.
2. **Replay is built into the event port.** The outbound port is a durable,
   offset-addressed event log with subscribe-from-offset catch-up.
3. **The WebSocket adapter keeps the `cf_agent_*` frame vocabulary.**
4. This wave bundles the doc-26 decompositions.

## The acceptance test for this wave

After this wave, in `src/app/`:
- no import of `Connection` or `ConnectionRegistry`;
- no occurrence of `cf_agent_`, `JSON.stringify`, `broadcast(`, or `conn.send`;
- `rg 'frame' src/app src/domain` finds nothing but comments explaining that
  frames are an adapter concern.
Everything transport lives under `src/adapters/`.

## The model

**Inbound**: adapters translate their surface (WS frames, parent RPC, HTTP,
webhooks) into calls on the agent's typed public methods. A method argument may
carry an `origin` (see `state:changed` below) but never a connection.

**Outbound**: the agent publishes typed `ConversationEvent`s to a durable log.
Adapters subscribe (from an offset) and decide serialization, fan-out,
exclusion, and replay per surface. The agent never knows who is listening.

Telemetry (`kernel/events` bus) is unchanged and distinct: fire-and-forget
diagnostics. ConversationEvents are product behavior with delivery semantics.

## 1. `domain/events/log.ts` — ConversationEventLog

### Event vocabulary
```ts
export type ConversationEvent =
  | { type: "turn:started"; requestId: string; trigger: string; channelId?: string }
  | { type: "chunk"; requestId: string; chunk: UiChunk }
  | { type: "message:updated"; message: ChatMessage; requestId?: string }
  | { type: "conversation:cleared" }
  | { type: "state:changed"; state: unknown;
      origin: { kind: "server" } | { kind: "client"; sourceId: string } }
  | { type: "recovering:changed"; active: boolean; requestId?: string }
  | { type: "session:status"; phase: "idle" | "compacting"; tokenEstimate: number; tokenThreshold?: number }
  | { type: "run:event"; runId: string; event: unknown }        // agent-tool run fan-out
  | { type: "turn:settled"; requestId: string;
      outcome: "completed" | "suspended" | "cancelled" | "failed";
      suspendedOn?: "client-tool" | "approval" | "durable-pause"; errorText?: string };
```
`sourceId` is an opaque adapter-supplied id (the WS adapter uses the
connection id) so adapters can implement "don't echo to the originator".

### Log semantics
```ts
export interface StoredEvent { offset: number; at: number; event: ConversationEvent }
export type CatchUp =
  | { kind: "events"; events: StoredEvent[] }
  | { kind: "gap"; firstAvailable: number };   // requested offset was pruned

export interface ConversationEventLog {
  publish(event: ConversationEvent): StoredEvent;          // assigns offset, persists, notifies live subs
  head(): number;                                          // next offset to be assigned
  read(fromOffset: number, limit?: number): CatchUp;
  /** Replays [fromOffset, head) synchronously via fn, then continues live.
      fromOffset "live" skips catch-up. Returns unsubscribe. */
  subscribe(fromOffset: number | "live", fn: (e: StoredEvent, replay: boolean) => void): () => void;
  /** Prune per retention policy; returns pruned count. Wire to housekeeping. */
  gc(): number;
}
export function createConversationEventLog(deps: {
  store: KeyValueStore;          // prefix "evlog:" (module-owned)
  clock: Clock;
  retention?: {
    settledTurnChunksMs?: number;   // default 600_000  — chunk events of settled turns
    abandonedTurnChunksMs?: number; // default 3_600_000 — chunk events of turns never settled
    maxLightEvents?: number;        // default 500 — non-chunk events kept (FIFO prune)
  };
  /** Log must know when turns settle to start the chunk-retention clock. It
      derives this from `turn:settled` events itself — no extra dep. */
}): ConversationEventLog;
```
Behaviors:
- Offsets are monotonic forever; pruning never reuses offsets. Reading a
  pruned range returns `{ kind: "gap", firstAvailable }` — the subscriber
  falls back to a state/history read and resumes from `firstAvailable`.
- `subscribe` catch-up passes `replay: true`; live delivery passes `false`.
- A subscriber throwing must not break other subscribers (mirror the
  telemetry bus rule).
- Persistence layout is the module's business, but chunk events must be
  addressable per turn for GC (`evlog:turn:<requestId>:<paddedOffset>` or an
  index — implementer's choice).
- **This module absorbs `domain/stream/resumable.ts`.** The resume handshake
  becomes subscribe-from-offset on chunk events of the active turn. After the
  WS adapter lands (doc's wave R3), `resumable.ts` and its tests are deleted;
  its retention semantics live on in the log's chunk retention.

### Tests (TDD list)
- publish/read ordering; head; subscribe-from-0 replay flag then live.
- gap semantics after gc; firstAvailable correct.
- retention: settled-turn chunks pruned after settledTurnChunksMs; abandoned
  after abandonedTurnChunksMs (derive settlement from turn:settled events);
  light events FIFO-pruned beyond maxLightEvents.
- subscriber isolation; unsubscribe; persistence across log recreation over
  the same store (offsets continue, no reuse).

## 2. Agent/Think public surface changes (methods canonical)

New/changed public methods (adapters call these; each is transport-free):

| Method | Notes |
| ------ | ----- |
| `events(): ConversationEventLog` | the outbound port (Agent owns the log; Think publishes into it) |
| `history(): Promise<ChatMessage[]>` | repaired transcript (what `onConnect` used to send) |
| `identity(): { className: string; name: string }` | what the identity frame used to carry |
| `applyToolResult(args: { toolCallId: string; output: unknown; isError?: boolean }): Promise<void>` | extracted continuation module (doc 26) |
| `resolveApproval(args: { toolCallId?: string; executionId?: string; approved: boolean; reason?: string }): Promise<void>` | routes approval-gated vs durable-pause |
| `setState(state, origin?)` | origin flows into the `state:changed` event |
| `activeTurn(): { requestId: string; startOffset: number } \| null` | lets adapters implement the resume handshake |
| `callables(): CallableRegistry` | RPC dispatch moves into adapters |

Removed from `Agent`/`Think`: `onConnect`, `onClose`, `onMessage`,
`onUnhandledMessage`, `broadcast`, all frame parsing/sending, readonly
connection helpers (`setConnectionReadonly` etc. — the readonly *policy* hook
`shouldConnectionBeReadonly(meta)` survives as a plain predicate the adapter
consults with adapter-supplied metadata). `AgentHost` loses `connections`.

## 3. Lifecycle — the single flow

```
activate: construct → start() → fibers.checkInterrupted → tasks.reconcile → arm alarm
stimulus: adapter method call | submission drain | schedule fire | alarm |
          approval resolution | recovery decision | auto-continuation
   → either a COMMAND (state op; may publish events; never runs inference)
   → or a TURN REQUEST, normalized to one shape and admitted to ONE queue:
        TurnRequest { requestId, trigger, newMessages, channelId?, continuation,
                      clientTools?, admission }
pipeline: admit → assemble → execute → settle → publish(turn:settled)
idle:     alarm armed → (hibernation is the host's business)
```
Turn statechart (each transition publishes one event):
```
queued → assembling → streaming → settling
  settled: completed | failed | cancelled
  suspended(client-tool | approval | durable-pause) —applyToolResult/resolveApproval→ queued
  interrupted —recovery: retry|continue→ queued ; exhausted→ failed(terminal message)
```
Every entry point (chat, saveMessages, submissions, scheduled prompts,
continuations, recovery re-runs) constructs a `TurnRequest` and calls the one
pipeline. No second path.

## 4. `adapters/websocket-chat/adapter.ts` — the WS chat adapter

```ts
export function attachChatTransport(agent: Think, registry: ConnectionRegistry, options?: {
  shouldSendProtocolMessages?: (connectionId: string) => boolean;
  readonly?: (connectionId: string) => boolean;
}): { onConnect(conn: Connection): void; onMessage(conn: Connection, raw: string): Promise<void>;
      onClose(conn: Connection): void; detach(): void };
```
Responsibilities (all of these move OUT of app/):
- **connect**: send `cf_agent_identity`, current state frame (if initialized),
  `cf_agent_chat_messages` (from `agent.history()`), `cf_agent_chat_recovering`
  if active. Subscribe the connection to the event log from `"live"`.
- **event → frame**: chunk → `cf_agent_use_chat_response { id, chunk, replay }`;
  message:updated → `cf_agent_message_updated`; conversation:cleared →
  `cf_agent_chat_clear`; state:changed → `cf_agent_state` (skip the connection
  whose id === origin.sourceId); recovering:changed → `cf_agent_chat_recovering`;
  session:status → `cf_agent_session`; run:event → `cf_agent_tool_run_event`.
- **frame → method**: `cf_agent_use_chat_request` → `agent.runTurn(...)` (parse
  messages/input/clientTools/channel here); `cf_agent_chat_clear` →
  `clearMessages()`; `cf_agent_chat_request_cancel` → `cancelChat(id)`;
  `cf_agent_tool_result` → `applyToolResult`; `cf_agent_tool_approval` →
  `resolveApproval`; `{ type: "rpc" }` → `agent.callables().dispatch(...)`
  with a responder that writes rpc frames; `cf_agent_state` →
  `setState(state, { kind: "client", sourceId: conn.id })`, catching
  validation errors into `cf_agent_state_error` (readonly connections rejected
  here, via the `readonly` option).
- **resume handshake**: `cf_agent_stream_resume_request` → if
  `agent.activeTurn()` exists, reply `cf_agent_stream_resuming`, replay chunk
  events of that turn from its `startOffset` with `replay: true`, then live;
  a `gap` catch-up → resend full `cf_agent_chat_messages` then live. No active
  turn → `cf_agent_stream_resume_none`.
- Frame-shape validation lives here; malformed frames never reach the agent.

## 5. `adapters/relay/child-relay.ts` — parent↔child streaming

`chat(input, callback)` loses its special-cased fan-out inside the pipeline.
Instead: `relayTurn(agent: Think, requestId: string, callback: StreamCallback)`
subscribes to the log filtered by requestId (from the turn's startOffset),
maps chunk→onEvent, turn:settled→onDone/onError, recovering→onInterrupted,
and unsubscribes on terminal. `Think.chat()` keeps its signature and wires
this internally — but through the log, not through the pipeline.

## 6. Memory adapter rework

`createMemoryHost` drops `connections` from the host given to agents; the
Memory transport (`MemoryConnection` + registry) is now wired only through
`attachChatTransport` in tests. Add a test helper
`connectChatClient(agent) => { send(frame), frames: unknown[], close() }`.

## Test strategy for the wave
- The event log gets its own module tests (above).
- app/ tests assert **events**, not frames (rewrite `agent.test.ts` /
  `think.test.ts` accordingly; they get simpler).
- The WS adapter gets frame-level tests: frame in → method call observed
  (spy on a real Think over memory host); event published → frame out;
  resume handshake incl. gap fallback; state echo exclusion; readonly.
- e2e scenarios connect through `attachChatTransport` + `connectChatClient`
  so the full path (frame → method → pipeline → log → frame) is exercised.
- Grep-based acceptance test (top of this doc) encoded as a unit test that
  reads the app/ sources and asserts the banned tokens are absent.
