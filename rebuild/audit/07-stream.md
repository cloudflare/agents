# 07 — Stream: UI chunks, accumulator, resumable buffer

Original: the turn loop converts AI SDK stream parts into "UI message stream"
JSON chunks sent over WebSocket (`cf_agent_use_chat_response` frames carrying
one chunk each), while `resumable-stream.ts` (935 lines) persists chunks so a
reconnecting client can replay. `stream-accumulator.ts` folds chunks back into
a `ChatMessage` for persistence.

---

## 1. `domain/stream/chunks.ts` — UI chunk model + accumulator

### UI chunk vocabulary (rebuild-owned, mirrors concepts not wire bytes)
```ts
export type UiChunk =
  | { type: "start"; messageId: string }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown;
      executor: "server" | "client" }                    // client → the browser must run it
  | { type: "tool-approval-requested"; toolCallId: string; toolName: string; input: unknown;
      descriptor?: unknown }                              // actions doc 12 fills descriptor
  | { type: "tool-output-available"; toolCallId: string; output: unknown; isError?: boolean }
  | { type: "finish"; finishReason: string }
  | { type: "error"; errorText: string };
```

### StreamAccumulator
Folds a chunk sequence into the assistant `ChatMessage` (parts in arrival
order, coalescing consecutive deltas of the same kind, tool parts keyed by
toolCallId transitioning `input-available → output-available|output-error`).
Must be **incrementally snapshottable**: at any point `current()` returns the
partial assistant message (used to persist partials on error/interrupt).

```ts
export interface StreamAccumulator {
  push(chunk: UiChunk): void;
  current(): ChatMessage;            // stable id from the "start" chunk
  finished(): boolean;
}
export function createAccumulator(idFallback?: string): StreamAccumulator;
```

### Tests
- text + reasoning coalescing; tool lifecycle to output-error; partial
  snapshot mid-stream equals what was pushed; unknown chunk types ignored.

---

## 2. `domain/stream/resumable.ts` — ResumableStreamBuffer

### Responsibilities (original behavior)
- Persist every outgoing chunk of an active stream (identified by `streamId`,
  monotonically indexed) so a client that reconnects mid-turn can replay from
  chunk 0 and continue live. In the original chunks are batched (flush every
  ~10 chunks) — keep batching an internal detail; the KV port is synchronous
  so batching is optional, but the API should not preclude it.
- Track stream status: `active | completed | errored`.
- Replay handshake (protocol handled by Think, doc 23):
  client asks "resume?" → if an active/ recently-settled stream exists,
  server replies "resuming" and replays buffered chunks flagged `replay: true`,
  then live chunks follow; if none, "resume-none".
- GC (run from a scheduled housekeeping callback):
  - settled (completed/errored) streams retained 10 minutes after settling;
  - abandoned active streams retained 1 hour after their **last chunk**, then
    reclaimed (marked errored + dropped).
- Only one active stream per request; a new stream for the same conversation
  supersedes (previous must be settled first by the turn queue anyway).

### Proposed interface
```ts
export interface ResumableStreamBuffer {
  begin(streamId: string, requestId: string): void;
  append(streamId: string, chunk: UiChunk): void;
  settle(streamId: string, outcome: "completed" | "errored"): void;
  /** null if unknown/reclaimed */
  read(streamId: string): { chunks: UiChunk[]; status: "active" | "completed" | "errored"; requestId: string } | null;
  activeStream(): { streamId: string; requestId: string } | null;
  gc(): number;                       // returns reclaimed count
}
export function createResumableStreamBuffer(deps: {
  store: KeyValueStore;               // prefix "stream:"
  clock: Clock;
  retention?: { settledMs?: number /*600_000*/; abandonedMs?: number /*3_600_000*/ };
}): ResumableStreamBuffer;
```

### Tests
- append/read order; settle transitions; activeStream tracking; gc honors both
  retention windows (drive with TestClock); read after reclaim → null;
  persistence across buffer recreation (eviction survival of an active
  stream's chunks).
