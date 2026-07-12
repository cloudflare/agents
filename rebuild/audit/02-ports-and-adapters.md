# 02 — Ports and in-memory adapters

The original `Agent` is a Durable Object: it reaches directly into
`ctx.storage` (synchronous SQLite/KV), `ctx.storage.setAlarm`, accepted
WebSockets, `env` bindings, and the AI SDK's `streamText`. The rebuild inverts
all of that: the domain sees only these interfaces. `adapters/memory/` provides
a complete in-memory implementation of every port so the whole system runs in
plain vitest.

All ports live in `ports/` as interface-only files (plus trivial helper types).
In-memory adapters live in `adapters/memory/`.

---

## `ports/clock.ts`
```ts
export interface Clock { now(): number }            // epoch ms
export const systemClock: Clock;
```
In-memory: `TestClock` with `advance(ms)`, `set(ms)`.

## `ports/storage.ts` — KeyValueStore

Semantics modeled on Durable Object storage: **synchronous**, ordered,
prefix-scannable, JSON-serializable values. Every domain module namespaces its
keys with a module prefix (e.g. `fiber:run:<id>`); modules never touch another
module's prefix.

```ts
export interface KeyValueStore {
  get<T = unknown>(key: string): T | undefined;
  put<T = unknown>(key: string, value: T): void;
  delete(key: string): boolean;
  /** Ordered by key. `prefix` filters; `limit` caps. */
  list<T = unknown>(options?: { prefix?: string; limit?: number }): Map<string, T>;
  deleteAll(options?: { prefix?: string }): number;
}
export function scoped(store: KeyValueStore, prefix: string): KeyValueStore; // helper
```
Notes:
- Values must round-trip JSON. The in-memory adapter should deep-copy on
  put/get (structuredClone) so tests catch accidental shared-reference bugs —
  real DO storage serializes too.
- `scoped()` prepends the prefix on writes and strips it on reads/lists; this
  is how modules receive "their" storage without seeing siblings.

## `ports/alarms.ts` — AlarmTimer

Durable Objects give exactly **one** alarm slot; the scheduler (doc 05)
multiplexes on top. The port is the raw slot:
```ts
export interface AlarmTimer {
  set(at: number): void;      // replaces any previous alarm
  get(): number | null;
  clear(): void;
}
```
In-memory adapter (`MemoryAlarmTimer`): wired to `TestClock`; when the clock
advances past the alarm time, it invokes a registered `onAlarm()` callback
(once; the slot clears before the callback runs, matching DO semantics). It
must also support async `onAlarm` handlers that re-arm the alarm.

## `ports/transport.ts` — connections & broadcast

Abstraction of the WebSocket surface (partyserver's `Connection` in the
original):
```ts
export interface Connection {
  readonly id: string;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  readonly state: Record<string, unknown>; // per-connection attachment (readonly flags etc.)
}
export interface ConnectionRegistry {
  connections(): Iterable<Connection>;
  get(id: string): Connection | undefined;
  broadcast(message: string, exclude?: string[]): void;
}
```
In-memory adapter: `MemoryConnection` records `sent: string[]` and exposes
`receive(msg)` to simulate inbound messages (the app layer registers a
handler).

## `ports/model.ts` — ModelClient (the LLM)

We deliberately do NOT depend on the AI SDK. The domain defines the minimal
streaming contract the turn loop needs. An AI SDK adapter can map this 1:1
later (`streamText` → these chunks).

```ts
// What the model receives:
export interface ModelRequest {
  system?: string;
  messages: ModelMessage[];            // doc 03 defines ModelMessage
  tools: ToolDescriptor[];             // name, description, JSON schema; no execute
  toolChoice?: "auto" | "none" | { toolName: string };
  settings?: ModelCallSettings;        // temperature, maxOutputTokens, seed, stopSequences, headers...
  signal?: AbortSignal;
}
// What comes back — a stream of typed chunks:
export type ModelChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "finish"; finishReason: "stop" | "tool-calls" | "length" | "error" | "content-filter";
      usage?: { inputTokens?: number; outputTokens?: number } };

export interface ModelClient {
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}
export type LanguageModelRef = ModelClient | string; // string ids resolved by the app layer
```
Error behavior: provider failures **throw** from the async iterable; the turn
loop classifies/handles them (docs 09, 14).

### `adapters/memory/fake-model.ts` — scripted model (test double)

The single most important test double. Scriptable per-call behaviors:
```ts
export type FakeTurn =
  | { kind: "text"; text: string; reasoning?: string }
  | { kind: "tool-call"; toolName: string; input: unknown; id?: string }
  | { kind: "error"; error: Error }                     // throws mid-stream after `emitBefore` chunks
  | { kind: "hang" }                                    // never yields (stall-watchdog tests)
  | { kind: "custom"; chunks: ModelChunk[] };
export class FakeModel implements ModelClient {
  constructor(script: FakeTurn[] | ((req: ModelRequest, call: number) => FakeTurn));
  readonly requests: ModelRequest[];  // captured for assertions
}
```
- Text turns stream the text in ≥2 deltas then `finish/stop`.
- Tool-call turns emit one `tool-call` chunk then `finish/tool-calls`.
- Must respect `signal` (stop yielding, throw AbortedError).

## `ports/sandbox.ts` — code execution (out-of-scope engines)
```ts
export interface Sandbox {
  run(request: { language: "js" | "ts" | "python" | "bash"; source: string;
                 input?: unknown; timeoutMs?: number }): Promise<{ ok: boolean; output?: unknown; error?: ErrorValue }>;
}
```
No in-memory implementation beyond a canned stub; used by skills scripts and
the execute tool if/when wired.

## `ports/email.ts`
```ts
export interface EmailMessage { from: string; to: string; subject?: string; text?: string; html?: string; headers?: Record<string,string> }
export interface EmailTransport { send(message: EmailMessage): Promise<{ messageId: string }> }
```
In-memory: records sent messages.

## `ports/workflow-runtime.ts`
The original delegates to Cloudflare Workflows bindings. The port:
```ts
export interface WorkflowRuntime {
  create(name: string, options: { id: string; params?: unknown }): Promise<void>;
  sendEvent(name: string, id: string, event: { type: string; payload?: unknown }): Promise<void>;
  terminate(name: string, id: string): Promise<void>;
  pause(name: string, id: string): Promise<void>;
  resume(name: string, id: string): Promise<void>;
  restart(name: string, id: string): Promise<void>;
  status(name: string, id: string): Promise<{ status: string; output?: unknown; error?: string } | null>;
}
```
In-memory: a controllable fake whose statuses tests can flip; it can invoke a
registered callback hook to simulate workflow→agent progress callbacks.

## `ports/tool-source.ts` — external tool providers (MCP et al.)
```ts
export interface ExternalToolSource {
  id: string;
  ready(): Promise<void>;                 // "waitForMcpConnections"
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, input: unknown, signal?: AbortSignal): Promise<unknown>; // throws on failure
}
```
In-memory: static tool map.

## `ports/agent-spawner.ts` — sub-agent access

The original spawns colocated child Durable Objects ("facets") via
`ctx.exports`. The rebuild's port abstracts "get me a handle to a named child
agent instance of class X":
```ts
export interface AgentHandle {
  readonly className: string;
  readonly name: string;
  call<T = unknown>(method: string, args: unknown[]): Promise<T>;
  abort(reason?: unknown): void;      // kill the running instance, keep storage
  destroy(): Promise<void>;           // wipe storage
}
export interface AgentSpawner {
  get(className: string, name: string): AgentHandle;   // lazy create
}
```
In-memory: constructs real rebuilt Agent/Think instances (from a registered
class map) each with their own in-memory ports — this is what makes full
parent/child e2e tests possible without workerd.

## `ports/http.ts` — outbound fetch (for the fetch tool)
```ts
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string,string>; redirect?: "manual"; signal?: AbortSignal }) => Promise<{
  status: number; headers: Map<string,string>; url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
```
In-memory: route-table fake with scripted responses/redirects.

---

## Implementation notes for `adapters/memory`

- One factory assembles a full port set: `createMemoryHost({ clock?, onAlarm? })`
  → `{ clock, store, alarms, connections, bus... }`. The app layer (docs 22/23)
  consumes exactly this shape, so tests and future Cloudflare adapters are
  symmetric.
- Keep adapters dumb. Any logic worth testing belongs in a domain module.

## Tests
- KV: ordering, prefix scan, limit, deep-copy isolation, scoped() views.
- Alarm: fires once on advance, re-arm inside handler works, clear.
- FakeModel: script sequencing, abort behavior, captured requests.
- Spawner: two names → two isolated instances; same name → same instance.
