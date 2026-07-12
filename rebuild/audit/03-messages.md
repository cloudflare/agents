# 03 — Message model, sanitization/repair, message store

In the original, the chat message shape is the AI SDK's `UIMessage` (parts
array), converted to provider `ModelMessage`s per call. Sanitization, repair of
interrupted transcripts, and row-size enforcement live in `chat/sanitize.ts`,
`chat/repair-transcript.ts`, `chat/message-builder.ts`, `chat/sql-batch.ts` and
inline in Think. The rebuild owns its message model outright.

---

## 1. `domain/messages/model.ts`

### The chat message (client/persistence shape)

```ts
export type Role = "system" | "user" | "assistant";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "file"; mediaType: string; url?: string; data?: string; filename?: string } // data = base64
  | ToolPart;

export type ToolPart = {
  type: `tool-${string}`;                       // "tool-<toolName>"
  toolCallId: string;
  state: "input-streaming" | "input-available" | "approval-requested" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;                              // when output-available
  errorText?: string;                            // when output-error
  approval?: { id: string; approved?: boolean; reason?: string };
};

export interface ChatMessage {
  id: string;
  role: Role;
  parts: MessagePart[];
  metadata?: Record<string, unknown>;            // channelId, requestId stamps live here
  createdAt?: number;
}
```

### The model message (provider-facing shape)

```ts
export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: Array<{ type: "text"; text: string } | { type: "file"; mediaType: string; data: string }> }
  | { role: "assistant"; content: Array<{ type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }> }
  | { role: "tool"; content: Array<{ type: "tool-result"; toolCallId: string; toolName: string; output: unknown; isError?: boolean }> };

export function toModelMessages(messages: ChatMessage[]): ModelMessage[];
```

Conversion rules (mirror the AI SDK's convertToModelMessages at a high level):
- Reasoning parts are dropped from model messages (provider-specific reasoning
  replay is an adapter concern).
- An assistant message with tool parts expands to an assistant message
  (tool-calls) followed by a tool message (tool-results) for every part with
  `state: "output-available" | "output-error"` (error → `isError: true`,
  output = errorText).
- Tool parts still awaiting input/approval produce **no** tool-call in model
  messages (they must be repaired first — see below).
- Empty messages (no convertible parts) are omitted.

### Helpers
```ts
export function textOf(message: ChatMessage): string;                 // concatenated text parts
export function userMessage(text: string, id?: string): ChatMessage;  // convenience constructors
export function assistantMessage(parts: MessagePart[], id?: string): ChatMessage;
export function isToolPart(p: MessagePart): p is ToolPart;
export function toolName(p: ToolPart): string;                        // strips "tool-" prefix
```

### Tests
- Round-trip of a tool call/result pair to model messages; error results carry
  isError; unfinished tool parts excluded; file parts flow to user content.

---

## 2. `domain/messages/repair.ts` — sanitization & transcript repair

### Why (from the original)
When a turn is interrupted (eviction, stall abort, cancel), the persisted
assistant message can contain a tool part stuck in `input-streaming` /
`input-available` / `approval-requested`. Sending that transcript back to a
provider yields `AI_MissingToolResultsError`-style 400s or makes the model
re-run the tool. The original repairs the transcript before every provider
call, emits `chat:transcript:repaired`, and allows subclass customization via
`repairInterruptedToolPart`.

### Responsibilities
- `sanitizeForPersistence(message)`: strip ephemeral, provider-specific
  metadata before storage (drop non-JSON values; drop transient fields the
  stream attaches, e.g. per-chunk provider metadata).
- `repairTranscript(messages, options)`: heal incomplete tool parts:
  - Default repair: flip an unsettled tool part to
    `state: "output-error", errorText: "Tool call was interrupted before completing."`
    (preserve the call + input so context is not lost).
  - A caller-provided `repairPart(part) → MessagePart` overrides the default
    per part (Think exposes this as an overridable hook). Returning a
    non-tool part (e.g. plain text) is allowed.
  - Normalize stringified tool inputs: if `input` is a string that parses as
    JSON, parse it (counts as `normalizedInputs`).
  - Backstop: a tool part that still lacks both output and error after repair
    is dropped from the model view.
- Return a report: `{ messages, removedToolCalls, normalizedInputs, toolCallIds }`;
  caller emits the event when counts are non-zero.

### Proposed interface
```ts
export interface RepairReport { messages: ChatMessage[]; removedToolCalls: number; normalizedInputs: number; toolCallIds: string[]; changed: boolean }
export function repairTranscript(messages: ChatMessage[], options?: {
  repairPart?: (part: ToolPart) => MessagePart;
}): RepairReport;
export function sanitizeForPersistence(message: ChatMessage): ChatMessage;
```

### Tests
- Interrupted tool part → errored result by default; custom repairPart wins;
  string input normalized; settled parts untouched; report counts.

---

## 3. `domain/messages/store.ts` — MessageStore

### Responsibilities (original: SQLite `cf_ai_chat_agent_messages` + helpers)
- Persist the linear conversation as ordered `ChatMessage[]` rows in the KV
  port under `msg:`; maintain insertion order via a monotonic sequence.
- `save(messages)` upserts by id (replace matching ids in place, append new).
- **Row-size enforcement**: before persisting a message whose serialized size
  exceeds `maxRowBytes` (default 1.8 MB), compact its largest tool outputs:
  replace `output` with a truncation marker object
  `{ truncated: true, originalBytes, preview }` until the row fits. Never
  drop the message entirely.
- `clear()` wipes messages (and lets subscribers know — Think broadcasts
  `cf_agent_chat_clear`).
- Batched writes during streaming are the resumable-stream module's concern
  (doc 07); the store itself is simple upsert semantics.

### Proposed interface
```ts
export interface MessageStore {
  all(): ChatMessage[];
  get(id: string): ChatMessage | undefined;
  save(messages: ChatMessage[]): void;         // upsert, sanitizes each message
  append(message: ChatMessage): void;
  clear(): void;
  count(): number;
}
export function createMessageStore(store: KeyValueStore, options?: {
  maxRowBytes?: number;                         // default 1_800_000
  onOversize?: (info: { messageId: string; originalBytes: number }) => void;
}): MessageStore;
```

### Tests
- Order stability across upserts; oversize tool output compacted (message fits,
  marker present, other parts intact); clear; persistence across a second
  store instance over the same KV (eviction survival).
