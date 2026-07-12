# 22 — `app/agent.ts`: the Agent composition root

The original `Agent` class is 13k lines. The rebuilt `Agent` is a **thin
composition root**: it owns no business logic, only construction, wiring, and
the overridable hook surface. Target: a few hundred lines.

## Construction

```ts
export interface AgentHost {                 // provided by an adapter (memory or cloudflare)
  className: string;
  name: string;
  store: KeyValueStore;
  alarm: AlarmTimer;                          // adapter must call agent.onAlarm() when it fires
  connections: ConnectionRegistry;
  clock: Clock;
  ids?: IdSource;
  spawner?: AgentSpawner;
  email?: EmailTransport;
  workflowRuntime?: WorkflowRuntime;
  parentPath?: Array<{ className: string; name: string }>;
}
export class Agent<State = unknown> {
  constructor(host: AgentHost);
}
```

The constructor assembles, in order: `EventBus` → `Scheduler` (dispatch table
below) → `KeepAlive` → `FiberService` → `TaskQueue` → `StateContainer` →
`SubAgentRegistry` → `WorkflowService` → `CallableRegistry` (scanning
`@callable` tags). Each service gets a `scoped()` store slice.

### Scheduler dispatch table
The scheduler's `dispatch(callback, payload, schedule)` resolves, in order:
1. `$internal:*` callbacks registered by services (keep-alive heartbeat,
   fiber recovery backoff, stream GC, declared tasks — services register
   their internal callbacks through an `internalCallbacks` map the Agent
   passes in);
2. otherwise: a public method of that name on the agent instance →
   `method(payload, schedule)`; missing method → emit `schedule:error`.
The TaskQueue dispatches the same way (minus internal names).

## Public surface (delegation only — grouped by service)

| Group | Methods (delegate to) |
| ----- | -------------------- |
| state | `state` getter, `setState`, hooks `validateStateChange`, `onStateChanged` (StateContainer) |
| scheduling | `schedule(when, cb, payload)` (Date/number-delay/cron-string sugar → ScheduleSpec), `scheduleEvery`, `getScheduleById`, `listSchedules`, `cancelSchedule` (Scheduler) |
| keep-alive | `keepAlive()`, `keepAliveWhile(fn)` |
| queue | `queue`, `dequeue`, `dequeueAll`, `dequeueAllByCallback`, `getQueue`, `getQueues` |
| fibers | `runFiber`, `startFiber`, `stash`, `inspectFiber(ByKey)`, `listFibers`, `cancelFiber(ByKey)`, `resolveFiber`, `deleteFibers`, hook `onFiberRecovered` |
| sub-agents | `subAgent`, `hasSubAgent`, `listSubAgents`, `deleteSubAgent`, `abortSubAgent`, `parentPath`, `selfPath`, `parentAgent` (single-hop via spawner) |
| workflows | `runWorkflow`, `sendWorkflowEvent`, `approveWorkflow`, ... `onWorkflowCallback`, hooks `onWorkflowProgress`, `onWorkflowComplete` |
| email | `sendEmail(options)` (port + `email:reply` event), hook `onEmail(message)` |
| rpc | `callableMethods()`, `@callable` support |
| lifecycle | `onStart()`, `onConnect(conn)`, `onClose(conn)`, `onError`, `onRequest(req)` seam, `destroy()`, `onAlarm()` |
| misc | `broadcast(msg, exclude?)`, `this.name`, `this.className` |

## Lifecycle behaviors

- **`start()`** (adapter calls once per activation, before anything else):
  run user `onStart()`, then `fibers.checkInterrupted()`, then
  `queue.flush()`, then re-arm scheduler (`scheduler.nextWake` → alarm).
  Rebuild note: original runs fiber checks on both onStart and alarm
  housekeeping — the scheduler registers an `$internal:housekeeping`
  interval only while needed (fiber rows or GC work exist).
- **`onAlarm()`**: delegate to `scheduler.onAlarm()`.
- **Connections**: adapter routes inbound WebSocket text to
  `agent.onMessage(conn, text)`. Base implementation parses JSON:
  - `{ type: "rpc", ... }` → CallableRegistry.dispatch (responses via
    `conn.send`);
  - `{ type: "cf_agent_state", state }` → StateContainer.set with
    connection source (readonly connections rejected with
    `cf_agent_state_error`);
  - unknown types → `onUnhandledMessage(conn, parsed)` hook (Think overrides).
  On connect: send identity frame (`cf_agent_identity`
  `{ className, name, connectionId }`) + current state frame if initialized;
  emit `connect`/`disconnect` events; `shouldSendProtocolMessages(conn)`
  hook can suppress protocol frames per connection.
- **Readonly connections**: `setConnectionReadonly(conn, flag)` stores a flag
  in `conn.state`; `isConnectionReadonly`; `shouldConnectionBeReadonly(conn)`
  hook consulted at connect time.
- **`destroy()`**: cancel all schedules, clear all storage prefixes, close
  connections, emit `destroy`, then `host.spawner`-independent teardown
  (adapter hook `host.onDestroyed?.()`).

## What is deliberately NOT here
- No SQL tag (`this.sql`) — storage is the KV port; app code that needs
  structured queries builds a domain service.
- No AsyncLocalStorage `getCurrentAgent()` — pass the agent explicitly;
  the ambient-fiber helper (doc 06) is the one sanctioned ambient.
- No email routing resolvers, no HTTP router — adapter/edge concerns.

## Tests (integration-style over memory adapters)
- construction + start ordering (onStart before fiber recovery? — original
  recovers within onStart path: assert both run, fibers after user onStart).
- schedule sugar forms (Date, seconds, cron string) round-trip.
- scheduler → public method dispatch, payload delivered; internal callback
  isolation (user `listSchedules` hides `$internal:*`).
- rpc frame round-trip over a MemoryConnection incl. streaming.
- state update from connection: broadcast excludes source; readonly rejected
  with error frame.
- destroy clears storage + cancels alarm.
- keepAliveWhile holds heartbeat (alarm armed) and releases.
