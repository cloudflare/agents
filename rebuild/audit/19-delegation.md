# 19 — Delegation: sub-agent registry & agent-tool runs

Original: two layers on `Agent`/Think —
(a) **sub-agents**: colocated child DOs ("facets") with `subAgent()`,
`listSubAgents()`, `deleteSubAgent()`, `parentPath`, `onBeforeSubAgent`;
(b) **agent tools**: `runAgentTool()` / `agentTool()` — a parent dispatches a
chat-capable child during a turn, with a parent-side run registry, streamed
`agent-tool-event` frames, replay, cancellation, drill-in, and recovery
reconciliation. The rebuild ports both over the `AgentSpawner` port.

---

## 1. Sub-agent registry (`domain/delegation/registry.ts`)

### Behaviors
- `subAgent(className, name)`: lazy get-or-create via the spawner; first call
  records `{ className, name, createdAt }` in the parent's registry
  (`sub:reg:`). Reserved name check: kebab-cased class name `"sub"` rejected.
- `hasSubAgent`, `listSubAgents(className?)` (creation order),
  `deleteSubAgent` (registry row removed + handle.destroy(); idempotent),
  `abortSubAgent(className, name, reason?)` (handle.abort; storage kept).
- Parent/child identity: children receive `parentPath`
  (root-first `[{ className, name }...]`) at spawn; `selfPath = parentPath + self`.
  The in-memory spawner passes this through construction options.
- `onBeforeSubAgent` middleware belongs to HTTP routing — out of scope here;
  document as an app-layer hook seam.

```ts
export interface SubAgentRegistry {
  get(className: string, name: string): AgentHandle;      // registers on first use
  has(className: string, name: string): boolean;
  list(className?: string): Array<{ className: string; name: string; createdAt: number }>;
  delete(className: string, name: string): Promise<void>;
  abort(className: string, name: string, reason?: unknown): void;
}
export function createSubAgentRegistry(deps: { store: KeyValueStore; spawner: AgentSpawner; clock: Clock; ids: IdSource }): SubAgentRegistry;
```

---

## 2. Agent-tool runs (`domain/delegation/runs.ts`)

A parent turn calls a tool that dispatches a **child Think** to do subwork.
Requirements from the original:

### Run lifecycle
- `startRun({ agentClassName, input, displayName? })`:
  1. create run row `{ runId, agentType, status: "running", summary: null,
     startedAt, requestId?, streamId? }` (prefix `run:`);
  2. spawn/get the child (child name = runId — each run gets a fresh child
     instance retained after completion for drill-in);
  3. invoke the child's chat entry (`call("chat", [prompt, relayRef])`) with a
     relay that forwards streamed events;
  4. every relayed event → append to a per-run event log (for replay) and
     emit to the parent's live listeners (`agent-tool-event` frames in the
     original; rebuild: a callback the app layer wires to broadcast).
- Terminal transitions: child onDone → `completed` (+ `output_json` = final
  text/summary); onError → `error` (+ message); cancel → `aborted`;
  onInterrupted (doc 14) → stay `running` — a child continuation owns the
  outcome; the parent's reconciliation later observes the real terminal state.
- `cancelRun(runId, reason?)`: abort bridging — call child's
  `cancelChat(requestId)` when known, else abort the handle; settle `aborted`.
- `inspectRun(runId)`, `listRuns({ status? })`, `readEvents(runId, afterIndex?)`
  (replay for late-attaching UIs = "tail"), `hasRun(agentType, runId)`.
- `clearRuns({ statuses?, before? })`: delete run rows + event logs **and
  destroy the retained child instances** (original `clearAgentToolRuns`).
- Parent hooks: `onRunStart(run)`, `onRunFinish(run)`, `onProgress(runId, progress)`
  (children report via `reportProgress` — a parent-callable method).

### Recovery reconciliation (original `_cfDetachedReconcileTick` +
`agent_tool:recovery:*` events)
- On parent startup: scan `running` rows; for each, ask the child for its
  current state (`call("inspectRun" ...)` — child consults its own recovery
  state). Child says done/error → settle parent row accordingly (emit
  `agent_tool:recovery:row`); child unreachable/unknown → mark `error`
  (reason "lost"). Bounded total time (`agent_tool:recovery:deadline`).
  Events: `begin`, `row`, `deadline`, `complete`, `failed`.

### The tool factory
```ts
export function agentTool(agentClassName: string, cfg: {
  description: string; inputSchema: z.ZodType; displayName?: string;
  /** Build the child prompt from tool input. Default: JSON.stringify(input). */
  prompt?: (input: unknown) => string;
}): Tool;   // execute = startRun + wait for terminal, output = child summary
```
The tool's execute suspends on the run's completion; the run row + events are
the durable record (a parent eviction mid-run reconciles on restart).

### Proposed interface
```ts
export type RunStatus = "running" | "completed" | "error" | "aborted";
export interface AgentToolRun { runId: string; agentType: string; status: RunStatus;
  summary?: string; output?: unknown; error?: string; startedAt: number; completedAt?: number }
export interface AgentToolRunService {
  startRun(args: { agentClassName: string; prompt: string; displayName?: string }): Promise<AgentToolRun>;
  waitForRun(runId: string): Promise<AgentToolRun>;         // resolves on terminal
  cancelRun(runId: string, reason?: string): Promise<void>;
  inspectRun(runId: string): AgentToolRun | null;
  listRuns(options?: { status?: RunStatus[] }): AgentToolRun[];
  readEvents(runId: string, afterIndex?: number): Array<{ index: number; event: unknown }>;
  clearRuns(options?: { statuses?: RunStatus[] }): Promise<number>;
  reconcile(): Promise<void>;                                // startup recovery scan
}
export function createAgentToolRunService(deps: {
  store: KeyValueStore; registry: SubAgentRegistry; clock: Clock; ids: IdSource; bus: EventBus;
  onEvent?: (runId: string, event: unknown) => void;         // live fan-out
  hooks?: { onRunStart?; onRunFinish?; onProgress? };
}): AgentToolRunService;
```
Child contract (Think, doc 23): exposes `chat(prompt, relay)` where relay =
`{ onStart({requestId}), onEvent(json), onDone(), onError(err), onInterrupted?() }`,
plus `cancelChat(requestId)` — exactly the original StreamCallback shape.

## Tests
- registry: lazy create, list order, delete destroys + idempotent, reserved
  name rejected, parentPath propagation (in-memory spawner).
- runs: happy path (fake child relays start/events/done) → completed with
  events replayable; error path; cancel mid-run → child cancelled + aborted;
  onInterrupted keeps running (then a later done settles);
  waitForRun joins; clearRuns destroys children; reconcile settles stale rows
  from a live child and marks unreachable children error("lost"); events
  emitted per taxonomy.
