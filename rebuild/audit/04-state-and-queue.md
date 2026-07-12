# 04 — State container & task queue

Two self-contained Agent features. In the original both are method clusters on
`Agent` (`setState`/`onStateChanged`/`shouldConnectionBeReadonly`… and
`queue`/`dequeue`/`getQueues`… backed by `cf_agents_state` / `cf_agents_queues`
tables).

---

## 1. `domain/state/state.ts` — StateContainer

### Responsibilities (original behavior)
- Hold a JSON-serializable `State` with lazy load from storage; `initialState`
  used only when storage has none.
- `setState(next, source)` validates, persists, notifies, and broadcasts to
  connected clients as a `cf_agent_state` protocol message — excluding the
  originating connection when the change came from a client.
- `validateStateChange(next, source)` hook may throw to reject (client-driven
  updates send a `cf_agent_state_error` back to the offender and do not apply).
- `onStateChanged(state, source)` observer hook fires after persist.
- Readonly connections: a per-connection flag; state updates from a readonly
  connection are rejected. (Flag storage is the transport port's per-connection
  `state` bag; policy lives here.)

### Proposed interface
```ts
export type StateSource = { kind: "server" } | { kind: "connection"; connectionId: string };

export interface StateContainer<State> {
  get(): State;                                  // throws if no state and no initial
  set(next: State, source?: StateSource): void;
  initialized(): boolean;
}
export function createStateContainer<State>(deps: {
  store: KeyValueStore;                          // key "state:value"
  bus: EventBus;                                 // emits "state:update"
  initialState?: State;
  validate?: (next: State, source: StateSource) => void;   // throw to reject
  onChanged?: (state: State, source: StateSource) => void;
  broadcast?: (state: State, excludeConnectionId?: string) => void;
}): StateContainer<State>;
```
Notes:
- Persist BEFORE notifying; a throwing `onChanged` must not unpersist.
- The app layer (doc 22) wires `broadcast` to the transport and translates the
  client protocol (`cf_agent_state` in/out, readonly rejection) — the domain
  container stays transport-free.

### Tests
- initialState only on first use; persistence across container recreation;
  validation rejection leaves old state; broadcast excludes source connection;
  event emitted.

---

## 2. `domain/queue/queue.ts` — TaskQueue

### Responsibilities (original behavior)
- Durable FIFO queue of named-callback tasks: `queue(callback, payload)`
  persists a row and schedules an immediate flush; rows execute **in
  sequence** (single in-flight task; strict insertion order).
- Executing a task calls a host-provided dispatcher
  `(callback, payload, item) => Promise<void>` (in the app layer this resolves
  to a method on the agent). Success → row deleted.
- Retries: failed tasks retry with backoff up to `maxAttempts` (default 3,
  exponential-ish delay); each retry emits `queue:retry`; exhaustion emits
  `queue:error` and drops the row.
- Introspection: `getQueue(id)`, `getQueues(key, value)` (filter by payload
  field in the original — keep a simple predicate filter), `dequeue(id)`,
  `dequeueAll()`, `dequeueAllByCallback(callback)`.
- Rows survive eviction: on construction/first flush, pending rows resume
  (order preserved).

### Proposed interface
```ts
export interface QueueItem<T = unknown> {
  id: string; callback: string; payload: T;
  createdAt: number; attempts: number;
}
export interface TaskQueue {
  enqueue<T>(callback: string, payload: T): Promise<string>;   // returns id
  dequeue(id: string): void;
  dequeueAll(): void;
  dequeueAllByCallback(callback: string): void;
  get(id: string): QueueItem | undefined;
  find(predicate: (item: QueueItem) => boolean): QueueItem[];
  /** Drain pending rows now (called on startup and after enqueue). */
  flush(): Promise<void>;
  size(): number;
}
export function createTaskQueue(deps: {
  store: KeyValueStore;               // prefix "queue:"
  clock: Clock; ids: IdSource; bus: EventBus;
  dispatch: (callback: string, payload: unknown, item: QueueItem) => Promise<void>;
  retry?: { maxAttempts?: number; baseDelayMs?: number };     // delays via setTimeout is fine (retry timing is best-effort in-isolate)
}): TaskQueue;
```
Notes:
- Concurrency guard: `flush()` while a flush is running is a no-op join —
  never two tasks in flight.
- `enqueue` emits `queue:create` and triggers flush asynchronously (caller does
  not wait for execution).

### Tests
- FIFO order; single-flight (no interleaving with slow dispatcher); retry then
  success; retry exhaustion emits `queue:error` and drops; dequeue before
  execution; recovery: build a new queue over the same KV → pending items run.
