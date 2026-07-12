# 01 — Kernel: ids, errors, json, events

Four tiny modules with zero dependencies. Everything else builds on these, so
they land first. In the original system these concerns were smeared through the
god classes (inline `crypto.randomUUID()` calls, ad-hoc murmur-style hashing,
`JSON.stringify` with hand-rolled truncation, and a diagnostics-channel emitter
hidden in `observability/`).

---

## 1. `kernel/ids.ts`

### Responsibilities
- Generate unique ids with a readable prefix: `newId("req") → "req_x7f3..."`.
- Stable content hashing for idempotency: hash arbitrary JSON-serializable
  input to a short hex string. The original used a 128-bit murmur-inspired
  string hash to fingerprint action inputs and schedule definitions; the
  requirement is: deterministic across processes, stable across key order.

### Proposed interface
```ts
export interface IdSource {
  newId(prefix: string): string;
}
export const defaultIdSource: IdSource; // crypto.randomUUID-based
export function stableHash(value: unknown): string; // canonical-JSON + FNV-1a/64 hex (or similar)
export function canonicalJson(value: unknown): string; // sorted keys, stable output
```

### Behaviors to preserve
- `stableHash({a:1,b:2}) === stableHash({b:2,a:1})` (key order independent).
- Arrays are order-sensitive. `undefined` properties are dropped.
- Ids are URL-safe, prefix-delimited with `_`.

### Tests
- Determinism, key-order independence, distinctness for different values,
  prefix formatting, injectable deterministic IdSource for other modules' tests.

---

## 2. `kernel/errors.ts`

### Responsibilities
The original threw bare `Error`s and defined scattered structured error shapes
for tool results. Centralize a small taxonomy. These cross module boundaries so
they must be defined once.

### Proposed interface
```ts
export class AgentError extends Error { readonly code: string }
export class ValidationError extends AgentError {}       // bad input/config, code "validation"
export class NotFoundError extends AgentError {}         // missing row/entity, code "not_found"
export class ConflictError extends AgentError {}         // identity conflicts (e.g. submissionId vs idempotencyKey mismatch)
export class AbortedError extends AgentError {}          // cooperative cancellation
export class TimeoutError extends AgentError {}          // deadline exceeded

// Tool/action results carry failures as VALUES with this shape:
export interface ErrorValue { name: string; message: string; [k: string]: unknown }
export function toErrorValue(err: unknown): ErrorValue;  // never throws
```

### Behaviors to preserve
- `toErrorValue` handles non-Error throwables (strings, objects, null).
- Special error results in the original that must remain representable as
  values: `ActionPendingError` (an action ledger row is pending and cannot be
  safely retried), `ActionAuthorizationError` (carries `permissions: string[]`).
  Define these in the actions module (doc 12) but on top of `ErrorValue`.

### Tests
- `toErrorValue` on Error / string / object / undefined; instanceof chains.

---

## 3. `kernel/json.ts`

### Responsibilities
Safe JSON plumbing used by tool outputs, stashes, ledgers:
- `normalizeJson(value)`: deep-convert a value to plain JSON (drop functions,
  cycles → error, Dates → ISO strings), returning a deep copy.
- `truncateForModel(text, maxChars)`: truncate with a trailing marker noting
  how much was elided (the original capped action outputs and tool outputs
  before the model sees them).
- `byteLength(json)`: UTF-8 size of the serialized value (used by the message
  store's row-size enforcement and the fetch tool's `maxBytes`).

### Proposed interface
```ts
export function normalizeJson<T = unknown>(value: unknown): T;
export function tryNormalizeJson(value: unknown): { ok: true; value: unknown } | { ok: false; error: ErrorValue };
export function truncateForModel(text: string, maxChars: number): { text: string; truncated: boolean };
export function jsonByteLength(value: unknown): number;
```

### Tests
- Cycles rejected; deep copy is detached; truncation marker; byte length of
  multibyte characters.

---

## 4. `kernel/events.ts` — observability bus

### Responsibilities
The original emits structured events to Node diagnostics channels, silent when
nobody listens, with a channel-per-domain taxonomy and an `Observability`
override point. Rebuild as a plain synchronous pub/sub bus (an adapter can
forward to diagnostics channels later).

Every event: `{ type, agent, name, payload, timestamp }` where `agent` is the
class name and `name` the instance name.

### Channel taxonomy (event type prefix → channel)
| channel     | types (examples) |
| ----------- | ---------------- |
| `state`     | `state:update` |
| `rpc`       | `rpc`, `rpc:error` |
| `message`   | `message:request`, `message:response`, `message:clear`, `message:cancel`, `message:error`, `tool:result`, `tool:approval` |
| `chat`      | `chat:request:failed`, `chat:recovery:detected|attempt|scheduled|completed|skipped|failed|exhausted`, `chat:stream:stalled`, `chat:context:compacted` |
| `transcript`| `chat:transcript:repaired` |
| `fiber`     | `fiber:run:started|completed|failed|interrupted`, `fiber:recovery:detected|attempt|handled|skipped|failed` |
| `agentTool` | `agent_tool:recovery:begin|row|deadline|complete|failed` |
| `schedule`  | `schedule:create|execute|cancel|retry|error|duplicate_warning`, `queue:create|retry|error` |
| `lifecycle` | `connect`, `disconnect`, `destroy` |
| `workflow`  | `workflow:start|event|approved|rejected|terminated|paused|resumed|restarted` |
| `email`     | `email:receive`, `email:reply` |
| `tool`      | `tool:fetch` |
| `channel`   | `channel:resolved`, `channel:delivered`, `notice:delivered`, `notice:failed` |

### Proposed interface
```ts
export interface ObservabilityEvent {
  type: string;
  agent: string;
  name: string;
  payload: Record<string, unknown>;
  timestamp: number;
}
export interface EventBus {
  emit(type: string, payload?: Record<string, unknown>): void;
  subscribe(channel: string | "*", fn: (e: ObservabilityEvent) => void): () => void;
}
export function createEventBus(source: { agent: string; name: string }, clock?: () => number): EventBus;
export function channelForType(type: string): string; // taxonomy above; unknown → "misc"
```

### Behaviors to preserve
- Zero overhead when no subscribers (guard before building payloads is the
  caller's concern; the bus itself must not throw if a subscriber throws —
  swallow and continue delivering to other subscribers).
- `subscribe` returns an unsubscribe function.
- A `"*"` subscription sees everything (used by tests and by a future tail
  adapter).

### Tests
- Routing by taxonomy, subscriber isolation (one throwing subscriber does not
  break others), unsubscribe, timestamp from injected clock.
