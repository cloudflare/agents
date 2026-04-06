# Chat Layer Improvements: Non-Breaking Changes + Shared Extraction

Concrete improvements to `@cloudflare/ai-chat` (AIChatAgent + useAgentChat) that can ship without breaking changes, plus extraction of shared code into `agents/chat` to reduce duplication between AIChatAgent and Think.

This document covers three concerns:

1. **Non-breaking additions** to AIChatAgent and useAgentChat that improve DX immediately
2. **Shared code extraction** into `agents/chat` that benefits both AIChatAgent and Think
3. **Deprecation prep** for a future breaking change

Related:

- [chat-api.md](./chat-api.md) — API analysis identifying these issues
- [think-roadmap.md](./think-roadmap.md) — Think implementation plan (consumes the extracted code)
- [think-sessions.md](./think-sessions.md) — Session integration design

---

## Table of Contents

1. [Non-Breaking Additions](#non-breaking-additions)
2. [Shared Code Extraction](#shared-code-extraction)
3. [Deprecation Prep](#deprecation-prep)
4. [Implementation Order](#implementation-order)

---

## Non-Breaking Additions

### 1. Export `getAgentMessages()` from `@cloudflare/ai-chat`

**Problem:** The `defaultGetInitialMessagesFetch` function in `react.tsx` is internal. Framework loaders (Next.js, TanStack Router, Remix) can't prefetch messages during route loading. Users must reconstruct the internal URL format manually. See [chat-api.md §C1](./chat-api.md#issue-c1-suspense-only-initial-message-fetch), [#1011](https://github.com/cloudflare/agents/issues/1011).

**Solution:** Export a standalone fetch function from `@cloudflare/ai-chat/react` (or a separate `@cloudflare/ai-chat` entry):

```typescript
export async function getAgentMessages<
  M extends UIMessage = UIMessage
>(options: {
  host: string;
  agent: string;
  name: string;
  credentials?: RequestCredentials;
  headers?: HeadersInit;
}): Promise<M[]> {
  const agentSlug = options.agent
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const url = new URL(
    `${options.host}/agents/${agentSlug}/${options.name}/get-messages`
  );
  const response = await fetch(url.toString(), {
    credentials: options.credentials,
    headers: options.headers
  });

  if (!response.ok) {
    console.warn(
      `Failed to fetch initial messages: ${response.status} ${response.statusText}`
    );
    return [];
  }

  const text = await response.text();
  if (!text.trim()) return [];

  try {
    return JSON.parse(text) as M[];
  } catch {
    console.warn("Failed to parse initial messages");
    return [];
  }
}
```

**Usage in framework loaders:**

```typescript
// TanStack Router
import { getAgentMessages } from "@cloudflare/ai-chat/react";

export const Route = createFileRoute("/chat/$conversationId")({
  loader: async ({ params }) => ({
    messages: await getAgentMessages({
      host: "https://my-app.workers.dev",
      agent: "ChatAgent",
      name: params.conversationId
    })
  })
});

// In component — skip Suspense, use loader data
const { messages: initialMessages } = Route.useLoaderData();
const { messages, sendMessage } = useAgentChat({
  agent,
  getInitialMessages: null,
  messages: initialMessages
});
```

**Effort:** Very low. The logic already exists internally — just export and document it.

**Benefits Think:** Think speaks the same `/get-messages` protocol. The exported function works with Think agents too.

### 2. Add `fallbackMessages` to `useAgentChat`

**Problem:** Switching between conversations always suspends via `use()`, even if the user just visited that conversation. No stale-while-revalidate pattern. See [#1045](https://github.com/cloudflare/agents/issues/1045).

**Solution:** Add an optional `fallbackMessages` option:

```typescript
type UseAgentChatOptions = {
  // ... existing options ...

  /**
   * Messages to show immediately while the server fetch is in progress.
   * Use for instant conversation switching with cached messages.
   *
   * When provided:
   * 1. Messages render immediately (no Suspense)
   * 2. Background fetch still runs via getInitialMessages
   * 3. When fetch resolves, messages are replaced with server state
   * 4. If user sends a message before fetch completes, fetch result is discarded
   */
  fallbackMessages?: UIMessage[];
};
```

**Implementation sketch:**

```typescript
// In useAgentChat:
const initialMessages = (() => {
  if (options.fallbackMessages && initialMessagesPromise) {
    // Don't suspend — use fallback immediately
    return options.fallbackMessages;
  }
  if (initialMessagesPromise) {
    return use(initialMessagesPromise); // existing Suspense path
  }
  return optionsInitialMessages ?? [];
})();

// Background revalidation effect (only when fallbackMessages is used)
useEffect(() => {
  if (!options.fallbackMessages || !initialMessagesPromise) return;

  let stale = false;
  initialMessagesPromise.then((serverMessages) => {
    if (!stale && !hasSentMessage.current) {
      setMessages(serverMessages);
    }
  });

  return () => {
    stale = true;
  };
}, [initialMessagesCacheKey]);
```

**Effort:** Low-medium. The fetch pipeline is unchanged — only the consumption side changes.

**Benefits Think:** Same client hook, same benefit.

### 3. Add `continuation` to `OnChatMessageOptions`

**Problem:** `onChatMessage` doesn't know if it's being called for a continuation (after tool results, after recovery) vs a fresh user turn. Subclasses can't adjust system prompts, select different models, or skip expensive context assembly. See [chat-api.md §S2](./chat-api.md#issue-s2-onchatmessage-doesnt-know-if-its-a-continuation).

**Solution:** Add to the existing type — purely additive:

```typescript
export type OnChatMessageOptions = {
  requestId: string;
  abortSignal?: AbortSignal;
  clientTools?: ClientToolSchema[];
  body?: Record<string, unknown>;
  /** True when this is a continuation (auto-continue after tool result, continueLastTurn, recovery). */
  continuation?: boolean; // NEW — additive, optional
};
```

**Call sites to update (in AIChatAgent):**

```typescript
// WebSocket user submit (line ~670)
{ requestId: chatMessageId, abortSignal, clientTools, body, continuation: false }

// Auto-continuation after tool result (line ~1877)
{ requestId, abortSignal, clientTools, body, continuation: true }

// continueLastTurn (line ~2177)
{ requestId, abortSignal, clientTools, body, continuation: true }

// saveMessages / programmatic turn (line ~1948)
{ requestId, abortSignal, clientTools, body, continuation: false }
```

**Effort:** Very low. Add field to type, set at call sites.

**Benefits Think:** Think's `ChatMessageOptions` should include the same field. Extract the type into `agents/chat` so both share it.

### 4. Export tool part helpers

**Problem:** Every app reimplements tool-state detection: `isToolUIPart(part)`, `getToolName(part)`, and the 8-state rendering switch. See [chat-api.md §C3](./chat-api.md#issue-c3-tool-ui-is-entirely-user-rebuilt-every-time).

**Solution:** Export utilities from `@cloudflare/ai-chat/react`:

```typescript
import type { UIMessage } from "ai";

type ToolUIPart = Extract<
  UIMessage["parts"][number],
  { type: "tool-invocation" }
>;

/**
 * Check if a message part is a tool invocation (any state).
 */
export function isToolUIPart(
  part: UIMessage["parts"][number]
): part is ToolUIPart {
  return part.type === "tool-invocation";
}

/**
 * Get the tool name from a tool UI part.
 */
export function getToolName(part: ToolUIPart): string {
  return (part as { toolName?: string }).toolName ?? "unknown";
}

/**
 * Get a simplified state for rendering.
 * Maps the 8+ internal states to 6 UI-relevant states.
 */
export function getToolPartState(part: ToolUIPart):
  | "loading" // input-available, no approval needed
  | "streaming" // input-streaming (partial input arriving)
  | "waiting-approval" // approval-requested
  | "approved" // approval-responded
  | "complete" // output-available
  | "error" // output-error
  | "denied" {
  // output-denied
  const state = (part as { state?: string }).state;
  switch (state) {
    case "input-streaming":
      return "streaming";
    case "approval-requested":
      return "waiting-approval";
    case "approval-responded":
      return "approved";
    case "output-available":
      return "complete";
    case "output-error":
      return "error";
    case "output-denied":
      return "denied";
    default:
      return "loading";
  }
}

/**
 * Get the tool output (if available).
 */
export function getToolOutput(part: ToolUIPart): unknown | undefined {
  return (part as { output?: unknown }).output;
}

/**
 * Get the tool input (if available).
 */
export function getToolInput(part: ToolUIPart): unknown | undefined {
  return (part as { input?: unknown }).input;
}

/**
 * Get the tool call ID.
 */
export function getToolCallId(part: ToolUIPart): string {
  return (part as { toolCallId: string }).toolCallId;
}

/**
 * Get the approval info for a tool part (if in approval state).
 */
export function getToolApproval(
  part: ToolUIPart
): { id: string; approved?: boolean } | undefined {
  return (part as { approval?: { id: string; approved?: boolean } }).approval;
}
```

These are already used internally in `useAgentChat` (`isToolUIPart` at multiple call sites, `getToolName` throughout). Exporting them is a no-op change to internals.

**Effort:** Very low. Extract existing internal functions, add `getToolPartState` and the accessor helpers.

**Benefits Think:** Same exports work for Think agents since the message format is identical (`UIMessage` from AI SDK).

### 5. Add `getHttpUrl()` to `useAgent` return value

**Problem:** `useAgentChat` accesses internal `PartySocket` properties via `@ts-expect-error` to derive the HTTP URL for `/get-messages`. See [chat-api.md §C8](./chat-api.md#issue-c8-ts-expect-error-coupling-to-partysocket-internals).

**Current (fragile):**

```typescript
// packages/ai-chat/src/react.tsx, lines 469–474
const agentUrl = new URL(
  `${// @ts-expect-error we're using a protected _url property
  ((agent._url as string | null) || agent._pkurl)
    ?.replace("ws://", "http://")
    .replace("wss://", "https://")}`
);
```

**Solution:** Add a public method to the `useAgent` return value (in `packages/agents/src/react.tsx`):

```typescript
// In useAgent's return object:
const getHttpUrl = useCallback((): string => {
  const wsUrl = socket._url || socket._pkurl;
  return wsUrl?.replace("ws://", "http://").replace("wss://", "https://") ?? "";
}, [socket]);

return {
  ...socket,
  agent: resolvedAgent,
  name: resolvedName,
  // ... existing fields ...
  getHttpUrl // NEW
};
```

Then `useAgentChat` can replace the `@ts-expect-error` with:

```typescript
const agentUrl = new URL(agent.getHttpUrl());
```

**Effort:** Very low. Purely additive to `useAgent`'s return type. `useAgentChat` can migrate to it in the same PR.

**Benefits Think:** Any Think-specific client hook would use the same public API instead of internal access.

### 6. Add `isStreaming` property to AIChatAgent (server-side)

**Problem:** AIChatAgent has no public way to check if a stream is active. `_resumableStream.hasActiveStream()` is private. Useful for HTTP endpoints (`GET /status`), RPC methods, and health checks.

**Solution:**

```typescript
// On AIChatAgent:
/** True when a chat stream is currently active. */
get isStreaming(): boolean {
  return this._resumableStream.hasActiveStream() || this._turnQueue.isActive;
}
```

**Effort:** Very low.

**Benefits Think:** Same pattern applies to Think. Could extract into a shared mixin or just implement on both.

### 7. Add `onChatError` callback to `useAgentChat`

**Problem:** No structured error handling on the client for chat-level errors. Server errors arrive as `{ error: true }` frames but there's no callback to distinguish them from network errors. See [chat-api.md §C5](./chat-api.md#issue-c5-no-structured-error-handling).

**Solution:** Add to `UseAgentChatOptions`:

```typescript
type UseAgentChatOptions = {
  // ... existing options ...

  /**
   * Called when a chat error occurs. Receives the error message and source.
   * Use for error toasts, logging, or custom error UI.
   */
  onChatError?: (error: {
    message: string;
    requestId?: string;
    source: "server" | "network" | "abort";
  }) => void;
};
```

**Implementation:** In the `onAgentMessage` handler, when a `CF_AGENT_USE_CHAT_RESPONSE` has `error: true`:

```typescript
if (data.error) {
  onChatErrorRef.current?.({
    message: data.body || "Stream error",
    requestId: data.id,
    source: "server"
  });
}
```

In the transport's `sendMessages`, when `AbortError` is caught:

```typescript
onChatErrorRef.current?.({
  message: "Request cancelled",
  requestId,
  source: "abort"
});
```

**Effort:** Low. The error paths already exist — just need to call the callback.

**Benefits Think:** Same callback works with Think agents.

---

## Shared Code Extraction

Code currently duplicated between AIChatAgent (`packages/ai-chat/src/index.ts`) and Think (`packages/think/src/think.ts`) that should be extracted into `agents/chat` (`packages/agents/src/chat/`).

### 1. Protocol Handler Wiring

**What's duplicated:** Both AIChatAgent and Think wrap `onConnect`, `onClose`, `onMessage`, and `onRequest` with the same pattern — intercept protocol messages, handle them, delegate to the user's original handler.

**AIChatAgent** (lines 466–820 — ~354 lines of protocol handling in the constructor):

```typescript
// packages/ai-chat/src/index.ts
const _onConnect = this.onConnect.bind(this);
this.onConnect = async (connection, ctx) => {
  if (this._resumableStream.hasActiveStream()) {
    this._notifyStreamResuming(connection);
  }
  return _onConnect(connection, ctx);
};

const _onClose = this.onClose.bind(this);
this.onClose = async (connection, code, reason, wasClean) => {
  this._pendingResumeConnections.delete(connection.id);
  this._continuation.awaitingConnections.delete(connection.id);
  // ... continuation cleanup ...
  return _onClose(connection, code, reason, wasClean);
};

const _onMessage = this.onMessage.bind(this);
this.onMessage = async (connection, message) => {
  if (typeof message === "string") {
    let data = JSON.parse(message);
    // ... giant switch/if chain for all protocol messages ...
  }
  return _onMessage(connection, message);
};
```

**Think** (lines 397–562 — ~165 lines with the same structure):

```typescript
// packages/think/src/think.ts
private _setupProtocolHandlers() {
  const _onConnect = this.onConnect.bind(this);
  this.onConnect = async (connection, ctx) => {
    if (this._resumableStream.hasActiveStream()) {
      this._notifyStreamResuming(connection);
    }
    connection.send(JSON.stringify({ type: MSG_CHAT_MESSAGES, messages: this.messages }));
    return _onConnect(connection, ctx);
  };
  // ... same pattern for onClose, onMessage, onRequest ...
}
```

**Extraction:** Create a `ChatProtocolHandler` in `agents/chat` that encapsulates the hook wrapping pattern:

```typescript
// agents/chat/protocol-handler.ts

export interface ChatProtocolCallbacks {
  // Protocol message handlers — each returns true if handled
  onChatRequest(
    connection: Connection,
    data: Record<string, unknown>
  ): Promise<void>;
  onClear(connection: Connection): void;
  onCancel(requestId: string): void;
  onToolResult(connection: Connection, data: Record<string, unknown>): void;
  onToolApproval(connection: Connection, data: Record<string, unknown>): void;

  // State queries
  getMessages(): UIMessage[];
  hasActiveStream(): boolean;
  getActiveRequestId(): string | null;

  // Stream resume
  notifyStreamResuming(connection: Connection): void;
  replayChunks(connection: Connection, requestId: string): string | null;
  persistOrphanedStream(streamId: string): void;

  // Continuation state
  getContinuation(): ContinuationState;
  getPendingResumeConnections(): Set<string>;
}

export function setupChatProtocol(
  agent: Agent,
  callbacks: ChatProtocolCallbacks
): void {
  // Wraps onConnect, onClose, onMessage, onRequest
  // with protocol handling, delegating to callbacks for agent-specific behavior
}
```

Both AIChatAgent and Think would call `setupChatProtocol(this, { ... })` with their specific implementations, eliminating ~200+ lines of duplicated wrapping logic.

**Effort:** Medium. Need to design the callback interface carefully to handle differences (AIChatAgent has `CF_AGENT_CHAT_MESSAGES` from client, concurrency decisions; Think doesn't).

**Note:** An alternative is a simpler `parseProtocolMessage(data): { type, ...fields } | null` utility that both agents call inside their own `onMessage` handler. This is less ambitious but still eliminates the JSON parsing, type detection, and field extraction duplication. Think and AIChatAgent would still have their own switch/if chains, but each case body would be cleaner.

### 2. Abort Controller Registry

**What's duplicated:** Both maintain a `Map<string, AbortController>` with identical get/create/cancel/remove/destroy patterns.

**AIChatAgent** (lines 3607–3645):

```typescript
private _getAbortSignal(id: string): AbortSignal | undefined {
  if (typeof id !== "string") return undefined;
  if (!this._chatMessageAbortControllers.has(id)) {
    this._chatMessageAbortControllers.set(id, new AbortController());
  }
  return this._chatMessageAbortControllers.get(id)?.signal;
}

private _removeAbortController(id: string) {
  this._chatMessageAbortControllers.delete(id);
}

private _cancelChatRequest(id: string) {
  this._chatMessageAbortControllers.get(id)?.abort();
}

private _destroyAbortControllers() {
  for (const controller of this._chatMessageAbortControllers.values()) {
    controller?.abort();
  }
  this._chatMessageAbortControllers.clear();
}
```

**Think** (lines 607–608, 674–676, 703–708):

```typescript
private _abortControllers = new Map<string, AbortController>();

// In _handleChatRequest:
const abortController = new AbortController();
this._abortControllers.set(requestId, abortController);
// ...
this._abortControllers.delete(requestId);

// In _handleClear:
for (const controller of this._abortControllers.values()) {
  controller.abort();
}
this._abortControllers.clear();

// In _handleCancel:
const controller = this._abortControllers.get(requestId);
if (controller) controller.abort();
```

**Extraction:**

```typescript
// agents/chat/abort-registry.ts

export class AbortRegistry {
  private controllers = new Map<string, AbortController>();

  /** Get or create an AbortController for the given ID. Returns its signal. */
  getSignal(id: string): AbortSignal {
    if (!this.controllers.has(id)) {
      this.controllers.set(id, new AbortController());
    }
    return this.controllers.get(id)!.signal;
  }

  /** Cancel a specific request. */
  cancel(id: string): void {
    this.controllers.get(id)?.abort();
  }

  /** Remove a controller after the request completes. */
  remove(id: string): void {
    this.controllers.delete(id);
  }

  /** Abort all pending requests and clear. */
  destroyAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }

  /** Check if a request is tracked. */
  has(id: string): boolean {
    return this.controllers.has(id);
  }
}
```

**Effort:** Very low. Self-contained utility, no interface design needed.

### 3. Tool State Machine

**What's duplicated:** Both implement `_applyToolResult` and `_applyToolApproval` with the same state matching logic — find the message containing a tool part with the given `toolCallId`, check it's in a valid state, apply the update, persist, broadcast.

**AIChatAgent** (lines 2809–2959 — ~150 lines):

- `_findAndUpdateToolPart()` — generic find-and-update with retry backoff for streaming race
- `_applyToolResult()` — delegates to `_findAndUpdateToolPart` with result-specific update
- `_applyToolApproval()` — delegates to `_findAndUpdateToolPart` with approval-specific update

**Think** (lines 930–1001 — ~70 lines):

- `_applyToolResult()` — inline find loop, update, persist, broadcast
- `_applyToolApproval()` — inline find loop, update, persist, broadcast

The core logic is the same — iterate message parts, find matching `toolCallId` in valid states, apply update. The differences are:

- AIChatAgent has a retry loop for streaming race conditions (`_findAndUpdateToolPart` with backoff)
- AIChatAgent separates streaming vs persisted message paths (in-place mutation vs immutable update)
- Think always operates on persisted messages

**Extraction:** Extract the state matching and update logic as a pure function:

```typescript
// agents/chat/tool-state.ts

export type ToolPartUpdate = {
  toolCallId: string;
  matchStates: string[];
  apply: (part: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * Find and update a tool part in a message array.
 * Returns the updated message (or null if not found), and the part index.
 */
export function findAndUpdateToolPart(
  messages: UIMessage[],
  update: ToolPartUpdate
): { message: UIMessage; partIndex: number; updated: UIMessage } | null {
  for (const msg of messages) {
    for (let i = 0; i < msg.parts.length; i++) {
      const part = msg.parts[i] as Record<string, unknown>;
      if (
        "toolCallId" in part &&
        part.toolCallId === update.toolCallId &&
        "state" in part &&
        update.matchStates.includes(part.state as string)
      ) {
        const updatedParts = [...msg.parts];
        updatedParts[i] = update.apply(part) as UIMessage["parts"][number];
        return {
          message: msg,
          partIndex: i,
          updated: { ...msg, parts: updatedParts } as UIMessage
        };
      }
    }
  }
  return null;
}

/** Pre-built update for tool result application. */
export function toolResultUpdate(
  toolCallId: string,
  output: unknown,
  overrideState?: "output-error",
  errorText?: string
): ToolPartUpdate {
  return {
    toolCallId,
    matchStates: [
      "input-available",
      "approval-requested",
      "approval-responded"
    ],
    apply: (part) => ({
      ...part,
      ...(overrideState === "output-error"
        ? {
            state: "output-error",
            errorText: errorText ?? "Tool execution denied by user"
          }
        : { state: "output-available", output, preliminary: false })
    })
  };
}

/** Pre-built update for tool approval application. */
export function toolApprovalUpdate(
  toolCallId: string,
  approved: boolean
): ToolPartUpdate {
  return {
    toolCallId,
    matchStates: ["input-available", "approval-requested"],
    apply: (part) => ({
      ...part,
      state: approved ? "approval-responded" : "output-denied",
      approval: {
        ...(part.approval as Record<string, unknown> | undefined),
        approved
      }
    })
  };
}
```

Both agents would call `findAndUpdateToolPart(this.messages, toolResultUpdate(toolCallId, output))` and then handle persistence and broadcast in their own way. AIChatAgent keeps its retry/streaming logic around the call; Think keeps its simpler inline path.

**Effort:** Low-medium. The pure function extraction is straightforward. The tricky part is AIChatAgent's streaming message path (`_streamingMessage` in-place mutation) — that stays in AIChatAgent, but the state matching and update construction moves to the shared function.

### 4. Request Context Persistence

**What's duplicated:** Both persist key-value context (client tools, body) to SQLite with identical patterns.

**AIChatAgent** (lines 1149–1193):

```typescript
private _restoreRequestContext() {
  const rows = this.sql`select key, value from cf_ai_chat_request_context` || [];
  for (const row of rows) {
    if (row.key === "lastBody") this._lastBody = JSON.parse(row.value);
    else if (row.key === "lastClientTools") this._lastClientTools = JSON.parse(row.value);
  }
}

private _persistRequestContext() {
  if (this._lastBody) {
    this.sql`insert or replace into cf_ai_chat_request_context (key, value)
      values ('lastBody', ${JSON.stringify(this._lastBody)})`;
  } else {
    this.sql`delete from cf_ai_chat_request_context where key = 'lastBody'`;
  }
  // ... same for lastClientTools ...
}
```

**Think** (lines 865–888):

```typescript
private _persistClientTools(): void {
  if (this._lastClientTools) {
    this.sql`INSERT OR REPLACE INTO think_request_context (key, value)
      VALUES ('lastClientTools', ${JSON.stringify(this._lastClientTools)})`;
  } else {
    this.sql`DELETE FROM think_request_context WHERE key = 'lastClientTools'`;
  }
}

private _restoreClientTools(): void {
  const rows = this.sql`SELECT value FROM think_request_context WHERE key = 'lastClientTools'` || [];
  if (rows.length > 0) {
    this._lastClientTools = JSON.parse(rows[0].value);
  }
}
```

Different table names, same pattern.

**Extraction:**

```typescript
// agents/chat/request-context.ts

export interface SqlProvider {
  sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ): T[];
}

export class RequestContextStore {
  private agent: SqlProvider;
  private table: string;
  private initialized = false;

  constructor(agent: SqlProvider, table = "cf_chat_request_context") {
    this.agent = agent;
    this.table = table;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.agent.sql`CREATE TABLE IF NOT EXISTS ${this.table} (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    )`;
    this.initialized = true;
  }

  get<T>(key: string): T | undefined {
    this.ensureTable();
    const rows = this.agent.sql<{ value: string }>`
      SELECT value FROM ${this.table} WHERE key = ${key}
    `;
    if (rows.length === 0) return undefined;
    try {
      return JSON.parse(rows[0].value) as T;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    this.ensureTable();
    if (value !== undefined && value !== null) {
      this.agent.sql`INSERT OR REPLACE INTO ${this.table} (key, value)
        VALUES (${key}, ${JSON.stringify(value)})`;
    } else {
      this.agent.sql`DELETE FROM ${this.table} WHERE key = ${key}`;
    }
  }

  getAll(): Record<string, unknown> {
    this.ensureTable();
    const rows =
      this.agent.sql<{ key: string; value: string }>`
      SELECT key, value FROM ${this.table}
    ` || [];
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        /* skip corrupted */
      }
    }
    return result;
  }

  clear(): void {
    this.ensureTable();
    this.agent.sql`DELETE FROM ${this.table}`;
  }
}
```

**Note:** For Think-on-Session, this functionality moves to `assistant_config` — but the `RequestContextStore` interface is still useful for AIChatAgent (which doesn't use Session). The store could accept `assistant_config` as the table name when Session is in play.

**Effort:** Low. Self-contained utility.

### 5. Stream Resume Handshake

**What's duplicated:** Both implement the `_notifyStreamResuming` → `STREAM_RESUME_REQUEST` → `STREAM_RESUME_ACK` → `replayChunks` → `_persistOrphanedStream` pattern with nearly identical logic.

**AIChatAgent** (lines 760–820 for the ACK handler, lines 989–1005 for `_notifyStreamResuming`):

```typescript
private _notifyStreamResuming(connection: Connection) {
  if (!this._resumableStream.hasActiveStream()) return;
  this._pendingResumeConnections.add(connection.id);
  connection.send(JSON.stringify({
    type: MessageType.CF_AGENT_STREAM_RESUMING,
    id: this._resumableStream.activeRequestId
  }));
}

// ACK handler:
if (data.type === MessageType.CF_AGENT_STREAM_RESUME_ACK) {
  this._pendingResumeConnections.delete(connection.id);
  if (this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeRequestId === data.id) {
    const orphanedStreamId = this._resumableStream.replayChunks(connection, ...);
    if (orphanedStreamId) this._persistOrphanedStream(orphanedStreamId);
  }
  return;
}
```

**Think** (lines 465–501 for the handler, lines 1104–1113 for `_notifyStreamResuming`):
Identical logic with different message constant names (`MSG_STREAM_RESUME_ACK` vs `MessageType.CF_AGENT_STREAM_RESUME_ACK`).

**Extraction:** Since `ResumableStream` already lives in `agents/chat`, extend it with resume handshake methods:

```typescript
// Add to ResumableStream or a new StreamResumeHandler:

export class StreamResumeHandler {
  private stream: ResumableStream;
  private pendingConnections: Set<string>;
  private continuation: ContinuationState;

  notifyStreamResuming(connection: Connection): void { ... }

  handleResumeRequest(
    connection: Connection,
    continuation: ContinuationState
  ): "resuming" | "awaiting-continuation" | "none" { ... }

  handleResumeAck(
    connection: Connection,
    requestId: string,
    persistOrphan: (streamId: string) => void
  ): void { ... }
}
```

**Effort:** Medium. The continuation state interactions make this slightly complex.

### 6. Broadcast with Resume Exclusions

**What's duplicated:** Both exclude `_pendingResumeConnections` from broadcasts.

**AIChatAgent** (lines 1195–1204):

```typescript
private _broadcastChatMessage(message: OutgoingMessage, exclude?: string[]) {
  const allExclusions = [...(exclude || []), ...this._pendingResumeConnections];
  this.broadcast(JSON.stringify(message), allExclusions);
}
```

**Think** (lines 1131–1147 — `_broadcastChat` method):

```typescript
private _broadcastChat(payload: Record<string, unknown>, exclude?: string[]): void {
  const allExclude = exclude
    ? [...exclude, ...this._pendingResumeConnections]
    : [...this._pendingResumeConnections];
  this.broadcast(JSON.stringify(payload), allExclude);
}
```

This is minor duplication (~6 lines each) but conceptually belongs with the resume handler. If `StreamResumeHandler` owns `_pendingResumeConnections`, it can provide a `getExclusions()` method.

**Effort:** Very low (part of resume handler extraction).

---

## Deprecation Prep

These don't change behavior — they add warnings and documentation that prepare users for a future breaking change.

### 1. Deprecate `onFinish` parameter on `onChatMessage`

**What:** Add `@deprecated` JSDoc. Add a one-time runtime warning if a subclass's `onChatMessage` override actually uses the `_finishResult` parameter (detect by checking if the passed callback was called with non-empty data).

**Migration path:** Use `onChatResponse` for post-turn metadata.

**Think:** Never adds `onFinish`. Think's `onChatMessage(options?)` is the target signature.

### 2. Deprecate `addToolOutput` naming

**What:** Add `addToolResult` as an alias in the return value of `useAgentChat`. Deprecate `addToolOutput` in JSDoc. Both call the same internal function.

```typescript
return {
  // ... existing return ...
  addToolOutput, // @deprecated — use addToolResult
  addToolResult: addToolOutput // NEW alias
};
```

**Migration path:** Switch from `addToolOutput` to `addToolResult`.

### 3. Deprecate remaining legacy options

**Already deprecated but not yet removed:**

- `tools` (with `execute`) → use `onToolCall`
- `experimental_automaticToolResolution` → use `onToolCall`
- `toolsRequiringConfirmation` → use `needsApproval` on server tools
- `autoSendAfterAllConfirmationsResolved` → use `sendAutomaticallyWhen` from AI SDK

**Action:** Add `@deprecated` JSDoc if missing. Add deprecation notice to README. Plan removal in next major version. Consider moving deprecated code paths to `@cloudflare/ai-chat/compat`.

### 4. Mark `Response` return type for future change

**What:** Document in `onChatMessage` JSDoc that a future version will accept `StreamableResult | Response` (or just `StreamableResult`). Don't change the type yet — just signal the direction.

---

## Implementation Order

### Wave 1: Quick wins (1–2 days each)

These are independent, purely additive, and can be PRed in parallel:

| #   | Change                                       | Effort   | Impact                              |
| --- | -------------------------------------------- | -------- | ----------------------------------- |
| 1   | Export `getAgentMessages()`                  | Very low | Unblocks framework loaders          |
| 3   | Add `continuation` to `OnChatMessageOptions` | Very low | Better continuation handling        |
| 4   | Export tool part helpers                     | Very low | Eliminates boilerplate in every app |
| 5   | Add `getHttpUrl()` to `useAgent`             | Very low | Removes `@ts-expect-error`          |
| 6   | Add `isStreaming` to AIChatAgent             | Very low | Server-side stream detection        |

### Wave 2: Client DX (3–5 days)

| #   | Change                                   | Effort     | Impact                       |
| --- | ---------------------------------------- | ---------- | ---------------------------- |
| 2   | Add `fallbackMessages` to `useAgentChat` | Low-medium | Fixes conversation switching |
| 7   | Add `onChatError` to `useAgentChat`      | Low        | Structured error handling    |

### Wave 3: Extraction (benefits Think Phase 1)

These should land before Think's Session integration PR, so Think can import from `agents/chat`:

| #   | Change                                               | Effort     | Impact                                    |
| --- | ---------------------------------------------------- | ---------- | ----------------------------------------- |
| E2  | Extract `AbortRegistry`                              | Very low   | Think reuses, AIChatAgent simplified      |
| E4  | Extract `RequestContextStore`                        | Low        | Think reuses (or uses `assistant_config`) |
| E3  | Extract tool state machine (`findAndUpdateToolPart`) | Low-medium | Think reuses, AIChatAgent simplified      |
| E1  | Extract protocol handler (or `parseProtocolMessage`) | Medium     | Largest dedup win                         |
| E5  | Extract stream resume handler                        | Medium     | Think reuses, resume logic consolidated   |

### Wave 4: Deprecation

Can happen anytime, independent of the above:

| #   | Change                              | Effort   | Notes                             |
| --- | ----------------------------------- | -------- | --------------------------------- |
| D1  | Deprecate `onFinish`                | Very low | JSDoc + optional runtime warning  |
| D2  | Add `addToolResult` alias           | Very low | Alias + deprecate `addToolOutput` |
| D3  | Deprecate legacy hook options       | Very low | JSDoc updates                     |
| D4  | Signal `StreamableResult` direction | Very low | JSDoc only                        |

### Dependency on Think roadmap

Wave 3 extractions directly feed into [Think Phase 1](./think-roadmap.md#phase-1-session-integration). The ideal timeline:

```
Wave 1 (quick wins)  ─┐
Wave 2 (client DX)   ─┤─ Can proceed in parallel
Wave 4 (deprecation) ─┘
                        │
Wave 3 (extraction)  ───┤─ Land before Think Phase 1
                        │
Think Phase 1        ───┘─ Session integration, imports from agents/chat
```
