# Chat API Analysis: AIChatAgent + useAgentChat

A critical analysis of the current `@cloudflare/ai-chat` API surface — both the server-side `AIChatAgent` class and the client-side `useAgentChat` React hook. Identifies pain points, awkward patterns, missing capabilities, and opportunities for improvement.

> **Note:** The "Implications for Think" section was written before the Session integration design. For how Think addresses these issues with Session as its storage layer, see [think-roadmap.md](./think-roadmap.md). Several server-side issues (S3 message access helpers, X2 conversation management) are resolved by Session. The client-side issues (C1–C8) remain fully relevant — they affect `useAgentChat` regardless of server-side architecture.

Related:

- [think-vs-aichat.md](./think-vs-aichat.md) — feature gap analysis between Think and AIChatAgent
- [think-sessions.md](./think-sessions.md) — Session integration design for Think
- [think-roadmap.md](./think-roadmap.md) — implementation plan (supersedes the prioritization in this doc)

---

## Table of Contents

1. [Current API Surface](#current-api-surface)
2. [What Works Well](#what-works-well)
3. [Server-Side Issues](#server-side-issues)
4. [Client-Side Issues](#client-side-issues)
5. [Cross-Cutting Issues](#cross-cutting-issues)
6. [Implications for Think](#implications-for-think)
7. [Summary: Prioritized Improvements](#summary-prioritized-improvements)

---

## Current API Surface

### Server: `AIChatAgent` (`@cloudflare/ai-chat`)

Core class that extends `Agent` from the Agents SDK. Users subclass it and override `onChatMessage`:

```typescript
export class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    const result = streamText({
      model: createWorkersAI({ binding: this.env.AI })(
        "@cf/moonshotai/kimi-k2.6"
      ),
      system: "You are a helpful assistant.",
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        /* ... */
      },
      abortSignal: options?.abortSignal
    });
    return result.toUIMessageStreamResponse();
  }
}
```

**Override points and properties:**

| Member                               | Type                     | Purpose                             |
| ------------------------------------ | ------------------------ | ----------------------------------- |
| `onChatMessage(onFinish, options?)`  | override                 | Handle chat turn, return `Response` |
| `onChatResponse(result)`             | override                 | Post-turn lifecycle hook            |
| `onChatRecovery(ctx)`                | override                 | Recovery policy after DO eviction   |
| `sanitizeMessageForPersistence(msg)` | override                 | Custom pre-persist transform        |
| `this.messages`                      | `ChatMessage[]`          | Current conversation history        |
| `maxPersistedMessages`               | `number \| undefined`    | Storage cap                         |
| `messageConcurrency`                 | `MessageConcurrency`     | Overlap strategy                    |
| `chatRecovery`                       | `boolean`                | Fiber-wrapped turns                 |
| `waitForMcpConnections`              | `boolean \| { timeout }` | MCP wait                            |
| `saveMessages(msgs)`                 | method                   | Programmatic turn                   |
| `continueLastTurn(body?)`            | method                   | Continue last assistant message     |
| `persistMessages(msgs)`              | method                   | Persist + broadcast                 |
| `hasPendingInteraction()`            | method                   | Client tool pending check           |
| `waitUntilStable(opts?)`             | method                   | Await quiescence                    |
| `resetTurnState()`                   | method                   | Abort + reset                       |

**`OnChatMessageOptions`:**

```typescript
export type OnChatMessageOptions = {
  requestId: string;
  abortSignal?: AbortSignal;
  clientTools?: ClientToolSchema[];
  body?: Record<string, unknown>;
};
```

**`ChatResponseResult` (for `onChatResponse`):**

```typescript
export type ChatResponseResult = {
  message: ChatMessage;
  requestId: string;
  continuation: boolean;
  status: "completed" | "error" | "aborted";
  error?: string;
};
```

### Client: `useAgentChat` (`@cloudflare/ai-chat/react`)

React hook that wraps the AI SDK's `useChat` with WebSocket transport and agent-specific features:

```typescript
const agent = useAgent({ agent: "ChatAgent", name: "session-1" });
const {
  messages,
  sendMessage,
  clearHistory,
  stop,
  addToolOutput,
  addToolApprovalResponse,
  status,
  isServerStreaming,
  isStreaming
} = useAgentChat({ agent });
```

**`UseAgentChatOptions` (agent-specific fields, beyond `useChat` options):**

| Option                                  | Type                               | Default       | Purpose                                   |
| --------------------------------------- | ---------------------------------- | ------------- | ----------------------------------------- |
| `agent`                                 | `ReturnType<typeof useAgent>`      | required      | WebSocket connection                      |
| `getInitialMessages`                    | `((opts) => Promise<M[]>) \| null` | default fetch | Custom initial message source             |
| `credentials`                           | `RequestCredentials`               | —             | HTTP fetch credentials                    |
| `headers`                               | `HeadersInit`                      | —             | HTTP fetch headers                        |
| `onToolCall`                            | `OnToolCallCallback`               | —             | Client-side tool execution                |
| `tools`                                 | `Record<string, AITool>`           | —             | ~~Dynamic client tools~~ (deprecated)     |
| `toolsRequiringConfirmation`            | `string[]`                         | —             | ~~Manual confirmation list~~ (deprecated) |
| `experimental_automaticToolResolution`  | `boolean`                          | —             | ~~Auto-resolve tools~~ (deprecated)       |
| `autoContinueAfterToolResult`           | `boolean`                          | `true`        | Server auto-continues after tool result   |
| `autoSendAfterAllConfirmationsResolved` | `boolean`                          | `true`        | ~~Client batching~~ (deprecated)          |
| `resume`                                | `boolean`                          | `true`        | Stream resumption on reconnect            |
| `body`                                  | `object \| (() => object)`         | —             | Custom data in every request              |
| `prepareSendMessagesRequest`            | `(opts) => { body?, headers? }`    | —             | Advanced request customization            |

**Return type additions (beyond `useChat`):**

| Field               | Type             | Purpose                              |
| ------------------- | ---------------- | ------------------------------------ |
| `clearHistory`      | `() => void`     | Clear conversation                   |
| `addToolOutput`     | `(opts) => void` | Provide tool result                  |
| `isServerStreaming` | `boolean`        | Server-initiated stream active       |
| `isStreaming`       | `boolean`        | Any stream active (client or server) |

### Transport: `WebSocketChatTransport`

Implements the AI SDK's `ChatTransport` interface over WebSocket. Not typically used directly by app code:

```typescript
interface ChatTransport<M extends UIMessage> {
  sendMessages(options: { messages: M[]; ... }): Promise<ReadableStream<UIMessageChunk>>;
  reconnectToStream(options: { chatId: string }): Promise<ReadableStream<UIMessageChunk> | null>;
}
```

The transport maps between `CF_AGENT_USE_CHAT_REQUEST` / `CF_AGENT_USE_CHAT_RESPONSE` WebSocket frames and the `ReadableStream<UIMessageChunk>` that `useChat` consumes. It handles:

- Request ID correlation
- Abort/cancel signaling
- Stream resume handshake
- Tool continuation streams

### Wire Protocol

See [chat-shared-layer.md](./chat-shared-layer.md) and the `types.ts` `MessageType` enum. The full protocol includes 12 message types for chat requests/responses, message sync, stream resume, tool results/approvals, and clear commands.

---

## What Works Well

### Wire protocol design

The `cf_agent_chat_*` WebSocket protocol is well-designed and battle-tested:

- **Resumable streams**: Chunk buffering in SQLite + replay on reconnect is a genuine differentiator. The 3-step handshake (`STREAM_RESUMING` → `STREAM_RESUME_ACK` → replay chunks) correctly handles reconnection timing, and `_pendingResumeConnections` prevents duplicate chunks during replay.
- **Multi-tab broadcast**: Chunks are broadcast to all connections. The `activeRequestIds` mechanism in the transport correctly deduplicates, while `onAgentMessage` in the hook handles cross-tab updates via `broadcastTransition`.
- **Continuation protocol**: The `continuation: true` flag on response frames + `messageId` stripping enables clean message append semantics.

### Tool execution model

The preferred pattern (`onToolCall` callback) is clean and well-structured:

```typescript
useAgentChat({
  agent,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    if (toolCall.toolName === "getLocation") {
      const pos = await navigator.geolocation.getCurrentPosition();
      addToolOutput({
        toolCallId: toolCall.toolCallId,
        output: { lat: pos.coords.latitude, lng: pos.coords.longitude }
      });
    }
  }
});
```

The server-side `needsApproval` + client-side `addToolApprovalResponse` flow for human-in-the-loop approval is also well-structured, with the server persisting the approval state and broadcasting `CF_AGENT_MESSAGE_UPDATED` when it changes.

### `body` option

The `body` option on `useAgentChat` — supporting both static objects and dynamic functions — is well-designed:

```typescript
// Static
body: { timezone: "America/New_York", userId: "abc" }

// Dynamic (called on each send)
body: () => ({ token: getAuthToken(), timestamp: Date.now() })
```

On the server, `options.body` is persisted to SQLite and survives hibernation, so tool continuations and recovery flows inherit the original request context. The `prepareSendMessagesRequest` escape hatch provides additional flexibility for advanced cases.

### `autoContinueAfterToolResult`

The default `true` behavior for auto-continuation after tool results mirrors how server-executed tools work with `maxSteps` in `streamText`. The 10ms coalesce window batches rapid tool results into a single continuation turn. This is the right default — most apps want the LLM to respond after tool results without manual intervention.

---

## Server-Side Issues

### Issue S1: `onChatMessage` signature is awkward

**Current:**

```typescript
async onChatMessage(
  onFinish: StreamTextOnFinishCallback<ToolSet>,
  options?: OnChatMessageOptions
): Promise<Response | undefined>
```

**Problems:**

1. **`onFinish` is almost never used.** The framework passes `async (_finishResult) => {}` (a no-op) at every call site — WebSocket turns, auto-continuations, programmatic turns, and `continueLastTurn`. Every example in the repo either ignores it or passes it through without using the data. It's a vestige of an earlier design where `onFinish` was the persistence hook; now `_reply` handles persistence internally.

2. **The `Response` return type is an abstraction mismatch.** AIChatAgent communicates over WebSocket, not HTTP. The `Response` is never sent to any HTTP client — it's consumed internally by `_reply`, which reads the body stream and detects content type (`text/event-stream` vs plaintext). Users must call `.toUIMessageStreamResponse()` even though no HTTP response is sent. Content-type detection and HTTP status codes are HTTP concepts applied to an internal pipeline.

3. **`undefined` return has no ergonomic use.** When `onChatMessage` returns `undefined`, the framework logs a warning and sends a terminal `done: true` frame with "No response was generated by the agent." This is almost always a bug, not intentional. A void return should either be an error or have clear semantics (e.g., "I handled this myself via `broadcast`").

**Compare Think:**

```typescript
async onChatMessage(options?: ChatMessageOptions): Promise<StreamableResult>
```

Think's signature is cleaner: no `onFinish` parameter, and the return type (`StreamableResult` with `toUIMessageStream()`) matches what's actually needed — an async iterable of chunks, not an HTTP response.

**Recommendation:** Drop `onFinish` from the signature. If users need provider finish metadata, they can get it from `onChatResponse` (which already provides richer context) or wire their own `onFinish` into `streamText` inside their override. Accept `StreamableResult | Response` for backward compat.

### Issue S2: `onChatMessage` doesn't know if it's a continuation

`OnChatMessageOptions` has no `continuation` field. When the server auto-continues after tool results, or when `continueLastTurn()` fires after recovery, `onChatMessage` is called identically to a fresh user turn.

The only signals available to subclasses are:

- `options.requestId` — client-generated for user submits, server-generated `nanoid()` for continuations (but this is an implementation detail, not a semantic signal)
- Inspecting `this.messages` for patterns (last message is assistant with pending tool state)
- `onChatResponse`'s `result.continuation` — but that fires _after_ the turn, not during

The `experimental/forever-chat` example works around this with `options?.body?.recovering` — a client-side flag that's fragile and requires client-server coordination for what should be a server-internal concept.

**Recommendation:** Add `continuation: boolean` to `OnChatMessageOptions`. This lets subclasses:

- Adjust system prompts for continuations vs fresh turns
- Select different models (faster model for continuations)
- Skip expensive context assembly (RAG, memory retrieval) on continuations
- Log continuation vs initial turn metrics

### Issue S3: `this.messages` is the only context access

The server-side API relies entirely on `this.messages` (a flat `ChatMessage[]`) for conversation history. There are no helper methods for common access patterns:

```typescript
// Every app does this:
const lastAssistant = this.messages.filter((m) => m.role === "assistant").pop();
const recentMessages = this.messages.slice(-10);
const hasPendingTool = this.messages.some(
  (m) =>
    m.role === "assistant" &&
    m.parts.some((p) => "state" in p && p.state === "input-available")
);
```

Think partially addresses this with `assembleContext()` (a structured override for context customization) and `getMessages()`, but the underlying data access is still raw array manipulation.

**Recommendation:** Add helper methods:

- `getLastAssistantMessage(): ChatMessage | undefined`
- `getLastUserMessage(): ChatMessage | undefined`
- `getRecentMessages(n: number): ChatMessage[]`
- `getMessageById(id: string): ChatMessage | undefined`
- Consider a `ConversationContext` object passed to `onChatMessage` that provides these

### Issue S4: `Response` return type couples to HTTP semantics

As noted in S1, the `Response` return type is a leaky abstraction. Beyond the ergonomic issue, it has practical consequences:

1. **Content-type detection**: `_reply` checks `response.headers.get("content-type")` to choose between SSE parsing and plaintext wrapping. This is an HTTP concept being used as a dispatch mechanism inside a WebSocket pipeline.

2. **Two parsing paths**: The SSE path (`_streamSSEReply`) and the plaintext path (`_sendPlaintextReply`) have different message building, error handling, and continuation semantics. This dual-path complexity exists because `Response` is too generic — it could be anything.

3. **No type safety**: A `Response` provides no compile-time guarantee about what's inside. Users could return `new Response("oops")` or `new Response(JSON.stringify({foo: "bar"}))` and the framework would attempt to parse it.

Think's `StreamableResult` (an object with `toUIMessageStream(): AsyncIterable<unknown>`) is closer to what's actually needed, though it loses the plaintext convenience.

**Recommendation:** Define a proper return type:

```typescript
type ChatTurnResult =
  | { stream: AsyncIterable<UIMessageChunk> }
  | { text: string }
  | Response; // backward compat
```

Or simply accept `StreamableResult | Response` and detect via duck typing.

### Issue S5: Persistence timing is opaque

The relationship between `onChatMessage` and persistence is complex and not well-documented:

1. **User messages** are persisted _before_ `onChatMessage` is called (inside `persistMessages` during the WebSocket handler).
2. **Assistant messages** are persisted _after_ the stream completes (inside `_reply`).
3. **Tool approval states** get an early SQL write _during_ streaming (when a tool hits `approval-requested` state) to survive refresh.
4. **`saveMessages`** persists first, then runs `onChatMessage`.

Subclasses have no control over when or how assistant messages are persisted. If a subclass wants to modify the assistant message before persistence (e.g., add metadata), it must use `sanitizeMessageForPersistence` — but that runs after the stream is complete and the message is fully assembled. There's no hook for _during_ streaming.

**Recommendation:** Document the persistence timeline clearly. Consider exposing a `beforePersist(message)` hook or integrating `sanitizeMessageForPersistence` into Think's pipeline.

---

## Client-Side Issues

### Issue C1: Suspense-only initial message fetch

`useAgentChat` uses React's `use()` to suspend while fetching initial messages from `/get-messages`:

```typescript
// packages/ai-chat/src/react.tsx
const initialMessages = initialMessagesPromise
  ? use(initialMessagesPromise) // ← suspends here
  : (optionsInitialMessages ?? []);
```

This creates several problems documented in [#1011](https://github.com/cloudflare/agents/issues/1011) and [#1045](https://github.com/cloudflare/agents/issues/1045):

**Problem 1: No non-suspending option.** There's no `isPending` / `error` return state. Components must be wrapped in `<Suspense>`, and the Suspense boundary location must match the fetch location. This prevents patterns like:

- Fetching in a parent, showing loading in a child
- Keeping the fetch alive when a panel toggles (unmount kills the `use()` suspension)
- Fine-grained loading states (skeleton messages vs full-page spinner)

**Problem 2: No exported fetch function.** The `defaultGetInitialMessagesFetch` function is internal:

```typescript
// packages/ai-chat/src/react.tsx, lines 495–520
async function defaultGetInitialMessagesFetch({ url }: GetInitialMessagesOptions) {
  const getMessagesUrl = new URL(url);
  getMessagesUrl.pathname += "/get-messages";
  const response = await fetch(getMessagesUrl.toString(), { ... });
  return JSON.parse(text) as ChatMessage[];
}
```

Framework route loaders (Next.js, TanStack Router, Remix) can't prefetch messages during route loading. Users must reconstruct the URL manually (`{host}/agents/{agent}/{name}/get-messages`) and pass `getInitialMessages: null` + `messages`, which depends on knowing the internal URL format and isn't a supported pattern.

**Problem 3: No `fallbackMessages`.** Switching between conversations always suspends, even if the user just visited that conversation. There's no SWR-style `fallbackData` / `placeholderData` pattern to show cached messages while revalidating. The issue at [#1045](https://github.com/cloudflare/agents/issues/1045) proposes this pattern:

```typescript
useAgentChat({
  agent,
  fallbackMessages: messageCache.get(conversationId)
});
```

The request cache (`requestCache` Map at module level) provides deduplication across React Strict Mode double-renders, but not stale-while-revalidate semantics.

**Problem 4: No error boundary integration.** If the fetch fails, `use()` throws and must be caught by an Error Boundary. There's no graceful degradation or retry mechanism.

**Recommendation:**

- Export `getAgentMessages({ host, agent, name, credentials?, headers? })` as a standalone fetch function
- Add a non-suspending variant that returns `{ messages, isPending, error }` (like TanStack Query's `useQuery`)
- Support `fallbackMessages` for instant conversation switching with background revalidation
- Optionally rename the current suspending version to `useSuspenseAgentChat` (TanStack Query convention)

### Issue C2: Two hook calls required for basic setup

Every app needs both `useAgent` and `useAgentChat`:

```typescript
const agent = useAgent({
  agent: "ChatAgent",
  name: `session-${userId}`,
  onOpen: () => setStatus("connected"),
  onClose: () => setStatus("disconnected"),
  onError: () => setStatus("disconnected")
});

const { messages, sendMessage, clearHistory, status } = useAgentChat({
  agent,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    /* ... */
  }
});
```

This two-step pattern makes sense architecturally (separate connection from chat), but adds friction for the 90% case. The `useAgent` return value is a `PartySocket` with extra fields (`state`, `setState`, `call`, `stub`) — implementation details that leak into every chat app.

The hook also uses `@ts-expect-error` to access internal `PartySocket` properties:

```typescript
// packages/ai-chat/src/react.tsx, lines 469–474
const agentUrl = new URL(
  `${// @ts-expect-error we're using a protected _url property
  ((agent._url as string | null) || agent._pkurl)
    ?.replace("ws://", "http://")
    .replace("wss://", "https://")}`
);
```

This coupling to `PartySocket` internals is fragile and creates maintenance burden.

**Recommendation:** Provide a combined `useAgentChat({ agent: "ChatAgent", name: "session-1", host })` that manages the connection internally. Keep the split hooks available for advanced use cases (RPC, state management, non-chat agents), but offer a shorthand for the common case. Think could provide `useThinkChat` as its version of this.

### Issue C3: Tool UI is entirely user-rebuilt every time

Every example in the repo reimplements the same tool-state rendering logic. Tool parts have ~8 states, and every app handles them manually:

```typescript
// This pattern appears in every example
for (const part of message.parts) {
  if (part.type === "text") {
    return <Markdown>{part.text}</Markdown>;
  }
  if (isToolUIPart(part)) {
    if (part.state === "output-available") {
      return <div><pre>{JSON.stringify(part.output, null, 2)}</pre></div>;
    }
    if (part.state === "input-available") {
      return <div>Running {getToolName(part)}...</div>;
    }
    if (part.state === "approval-requested") {
      return <div>
        <button onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: true })}>
          Approve
        </button>
        <button onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: false })}>
          Deny
        </button>
      </div>;
    }
    if (part.state === "input-streaming") { /* ... */ }
    if (part.state === "output-error") { /* ... */ }
    if (part.state === "output-denied") { /* ... */ }
    // ... etc
  }
  if (part.type === "reasoning") { /* ... */ }
}
```

The playground's embedded documentation snippets are also stale — they show `toDataStreamResponse`, positional `useAgentChat(agent, ...)`, and `addToolResult` while the real code uses `toUIMessageStreamResponse`, `{ agent, ... }`, and `addToolOutput`. This creates confusion for developers reading the examples.

**Recommendation:**

- Export a `<MessageParts>` component (or `useMessageParts` hook) that handles the state machine with render prop / slot-based customization
- At minimum, export a `getToolPartState(part): "loading" | "streaming" | "complete" | "error" | "denied" | "waiting-approval" | "approved"` utility that simplifies the state detection
- Consider a `<ToolCallCard>` component with sensible defaults and customization slots (header, body, actions, error)

### Issue C4: `isServerStreaming` vs `status` is confusing

`useAgentChat` returns three streaming indicators:

| Field               | Source           | Tracks                                                                 |
| ------------------- | ---------------- | ---------------------------------------------------------------------- |
| `status`            | AI SDK `useChat` | Client-initiated requests only                                         |
| `isServerStreaming` | Agent hook       | Server-initiated streams (saveMessages, auto-continuation, other tabs) |
| `isStreaming`       | Derived          | `status === "streaming" \|\| isServerStreaming`                        |

Users consistently just want to know "is something streaming?" but must understand the distinction. The playground examples use `status === "streaming"` and miss server-initiated streams entirely. Other examples use `isStreaming` correctly but inconsistently.

The AI SDK's `status` field has four values: `"ready"`, `"submitted"`, `"streaming"`, `"error"`. None of these reflect server-initiated activity. When `saveMessages` triggers a turn, the client sees chunks via `broadcastTransition` and `isServerStreaming` goes `true`, but `status` stays `"ready"`.

**Recommendation:** Make `isStreaming` the primary documented API. Consider deprecating direct `status` inspection for streaming detection, or provide clear documentation about when each indicator is meaningful. Alternatively, unify into a single `chatStatus` that covers all states:

```typescript
type ChatStatus =
  | "idle" // No activity
  | "submitting" // Client request in flight
  | "streaming" // Any source streaming (client or server)
  | "awaiting-tool" // Waiting for client tool result or approval
  | "error"; // Last turn errored
```

### Issue C5: No structured error handling

When `onChatMessage` throws on the server, the client receives an error frame:

```typescript
// Server sends:
{ type: "cf_agent_use_chat_response", id, body: error.message, done: true, error: true }
```

On the client, this either:

- Errors the transport's `ReadableStream` (for client-initiated requests)
- Gets processed by `broadcastTransition` with `error: true` (for cross-tab/server streams)

But there's no structured `onChatError` callback in `useAgentChat`. The AI SDK's `useChat` has an `error` state in its return value, but it's unclear how agent-specific errors map to that vs. network errors vs. abort errors.

**Recommendation:** Add `onChatError?: (error: { message: string; requestId: string; source: "server" | "network" }) => void` to `UseAgentChatOptions`. Ensure `error` in the return value distinguishes between chat errors and transport errors.

### Issue C6: `addToolOutput` vs `addToolResult` naming confusion

The hook exposes `addToolOutput` (which calls `addToolResult` internally). The AI SDK exposes `addToolResult` and `addToolApprovalResponse`. The naming is inconsistent:

- `useAgentChat` return: `addToolOutput`, `addToolApprovalResponse`
- AI SDK `useChat` return: `addToolResult`, `addToolApprovalResponse`
- Wire protocol: `CF_AGENT_TOOL_RESULT`
- Server-side: `_applyToolResult`

The `addToolOutput` wrapper exists because it also sends the result to the server (AI SDK's `addToolResult` only updates local state). But the naming difference creates confusion — users reading AI SDK docs find `addToolResult`, then discover `useAgentChat` has `addToolOutput` instead.

**Recommendation:** Either align naming with the AI SDK (`addToolResult` that auto-sends to server), or clearly document the distinction. The type `AddToolOutputOptions` also has fields (`state`, `errorText`) that `addToolResult` doesn't, which further diverges the mental models.

### Issue C7: Module-level `requestCache` leaks across instances

The initial message cache is a module-level `Map`:

```typescript
// packages/ai-chat/src/react.tsx, line 326
const requestCache = new Map<string, Promise<Message[]>>();
```

This is intentional (deduplication across React Strict Mode), but it has side effects:

- Cache keys include `origin + pathname + agent + name` but not `credentials` or `headers`, so different auth contexts share cache entries
- No TTL — cached promises live until the component unmounts and the cleanup effect runs
- In SSR/RSC environments, module-level state persists across requests (request-scoping issues)

**Recommendation:** Consider a WeakRef-based cache or a configurable cache provider. For SSR, the cache should be request-scoped.

### Issue C8: `@ts-expect-error` coupling to PartySocket internals

As noted in C2, `useAgentChat` accesses internal `PartySocket` properties (`_url`, `_pkurl`) to derive the HTTP URL for `/get-messages`:

```typescript
// @ts-expect-error we're using a protected _url property
(agent._url as string | null) || agent._pkurl;
```

This creates fragile coupling to the `PartySocket` implementation. If the internal API changes, `useAgentChat` breaks silently at runtime.

**Recommendation:** Add a public method to `useAgent`'s return value: `getHttpUrl(): string` (or `httpUrl` property). This encapsulates the URL derivation and removes the `@ts-expect-error`.

---

## Cross-Cutting Issues

### Issue X1: Deprecated options accumulating

The hook has accumulated several deprecated options that add cognitive load and increase bundle size:

| Deprecated Option                       | Replacement                         | Status            |
| --------------------------------------- | ----------------------------------- | ----------------- |
| `tools` (with `execute`)                | `onToolCall` callback               | Still functional  |
| `experimental_automaticToolResolution`  | `onToolCall`                        | Still functional  |
| `toolsRequiringConfirmation`            | `needsApproval` on server tools     | Still functional  |
| `autoSendAfterAllConfirmationsResolved` | `sendAutomaticallyWhen` from AI SDK | Still functional  |
| `JSONSchemaType`                        | `JSONSchema7` from `"ai"`           | Re-exported alias |
| `detectToolsRequiringConfirmation()`    | `needsApproval`                     | Exported function |
| `AITool.inputSchema`                    | `AITool.parameters`                 | Warning on use    |

The deprecated `experimental_automaticToolResolution` codepath alone is ~120 lines of `useEffect` logic (lines 864–992) that processes tool calls, sends results to server, manages local state, and handles re-entrancy — all duplicating what `onToolCall` does more cleanly.

**Recommendation:** Plan a major version that removes these. In the interim, consider moving deprecated functionality to `@cloudflare/ai-chat/compat` to reduce the main bundle. The `tools` option (client-defined tool schemas) still has valid use cases in SDKs/platforms with dynamic tools — consider keeping it but renaming or restructuring.

### Issue X2: No conversation / session management

Both AIChatAgent and Think support only one conversation per Durable Object instance. Multi-conversation apps must:

- Create separate DO instances per conversation (via `name` in `useAgent`)
- Manage conversation listing/metadata in the Worker entrypoint or a separate store
- Handle routing, access control, and lifecycle themselves

There's no:

- `listConversations(userId)` — users build this with KV/D1
- Conversation metadata (title, created_at, last_message_at, message_count)
- Archive/delete conversation
- Client-side `useConversationList()` hook

The examples handle this minimally — most use a single hardcoded conversation name or derive it from user ID.

**Recommendation:** This is a feature gap, not an API bug. Consider providing:

- A `ConversationManager` Worker helper that wraps DO instance lifecycle
- Metadata stored in the DO's SQLite (auto-maintained `last_message_at`, message count)
- A `/conversations` HTTP endpoint pattern
- A `useConversations()` client hook

### Issue X3: No typed integration between chat and RPC

`useAgent` provides typed RPC (`call`, `stub`) for invoking methods on the agent:

```typescript
const agent = useAgent<MyAgent>({ agent: "MyAgent", name: "room" });
agent.call("setPreferences", { theme: "dark" }); // typed
```

But `useAgentChat` doesn't integrate with RPC. If an app needs both chat and custom methods (common for agents with configuration, side-panel actions, etc.), it must juggle both APIs:

```typescript
const agent = useAgent<MyAgent>({ agent: "MyAgent", name: "room" });
const chat = useAgentChat({ agent });

// Chat via hook
chat.sendMessage(...);

// Config via RPC — different API surface, same connection
await agent.call("setPreferences", { theme: "dark" });
```

Think's `configure()` / `getConfig()` is a step toward typed configuration, but it's a separate mechanism from RPC.

**Recommendation:** Consider a unified hook that exposes both chat and RPC surfaces. Or provide a `useAgentRPC(agent)` hook that shares the connection with `useAgentChat`.

### Issue X4: Message rendering has no helpers

The AI SDK's `UIMessage` uses a `parts`-based structure with many part types:

```typescript
type UIMessage = {
  id: string;
  role: "user" | "assistant";
  parts: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; reasoning: string }
    | { type: "tool-invocation"; toolCallId: string; toolName: string; state: string; ... }
    | { type: "source"; source: { ... } }
    | { type: "file"; data: string; mimeType: string }
    | { type: "step-start" }
    // ...
  >;
};
```

Every app must implement its own `parts.map(...)` renderer. Common needs that are reimplemented everywhere:

- Text rendering with markdown
- Reasoning collapse/expand
- Tool state machine UI
- Source/citation rendering
- File/image display
- Step boundary visualization
- "Thinking..." placeholder for empty streaming messages

**Recommendation:** Export a `<MessageRenderer>` component with slot-based customization:

```typescript
<MessageRenderer
  message={message}
  renderText={(part) => <Markdown>{part.text}</Markdown>}
  renderTool={(part, helpers) => <ToolCard part={part} {...helpers} />}
  renderReasoning={(part) => <CollapsibleReasoning>{part.reasoning}</CollapsibleReasoning>}
/>
```

Or export utility hooks: `useMessageText(message)`, `useToolParts(message)`, `useReasoning(message)`.

### Issue X5: Stream resume complexity

The stream resume system works correctly but is complex across three layers:

1. **Server**: `ResumableStream` buffers chunks in SQLite, `onConnect` sends `STREAM_RESUMING`, ACK handler replays chunks
2. **Transport**: `reconnectToStream` → `STREAM_RESUME_REQUEST` → wait for `STREAM_RESUMING` or `STREAM_RESUME_NONE` → `STREAM_RESUME_ACK` → `_createResumeStream`
3. **Hook**: `onAgentMessage` handles `STREAM_RESUMING` / `STREAM_RESUME_NONE` fallbacks, `broadcastTransition` processes replay chunks with `replay: true` / `replayComplete: true` flags, `localRequestIdsRef` prevents duplicate handling

The tool continuation variant adds another code path (`expectToolContinuation` → `_createToolContinuationStream`), and the hook has a 5-second timeout for resume that silently resolves to `null`.

This complexity is mostly internal and doesn't leak to users (the `resume: true` default handles everything). But it makes debugging resume issues very difficult, and the fallback path in `onAgentMessage` (lines 1218–1244) that handles `STREAM_RESUMING` when the transport isn't expecting it is particularly subtle.

**Recommendation:** Consider consolidating resume into a single `ResumeManager` that encapsulates the state machine across transport and hook. Add debug logging (gated behind a flag) for resume lifecycle events.

---

## Implications for Think

> **Updated:** The analysis below was written before Session integration. See [think-roadmap.md](./think-roadmap.md) for the current plan. Key changes:
>
> - Session solves S3 (message access helpers — `getMessage`, `getLatestLeaf`, `getBranches`, `getPathLength`)
> - Session solves X2 (conversation management — `SessionManager` provides create/list/delete/rename/fork/search)
> - Context blocks provide structured system prompt composition — beyond what `getSystemPrompt()` alone offers
> - Compaction provides conversation length management — replacing `maxPersistedMessages`
> - Branching provides non-destructive regeneration — better than AIChatAgent's delete-and-rerun

### What Think should adopt from AIChatAgent

See [think-vs-aichat.md](./think-vs-aichat.md) for the full gap analysis. The high-priority items are:

- `chatRecovery` / `onChatRecovery` (fiber-wrapped turns)
- `continueLastTurn()` (continuation as message append)
- `saveMessages()` (programmatic turn entry)
- `onChatResponse` (post-turn lifecycle hook)

### What Think should NOT adopt

1. **The `onFinish` parameter.** Think's `onChatMessage(options?)` is cleaner. If Think adds post-turn metadata, it should go through `onChatResponse` or a dedicated hook, not a callback parameter.

2. **The `Response` return type.** Think's `StreamableResult` is the right abstraction. If backward compat with `Response` is needed, accept both via duck typing.

3. **Deprecated-on-arrival options.** Think should not add `tools` (client tool schemas in hook), `toolsRequiringConfirmation`, or `experimental_automaticToolResolution`. The `onToolCall` + `needsApproval` pattern is the right API.

4. **Complex concurrency without clear need.** Think uses queue-only concurrency. Adding `messageConcurrency` strategies should be demand-driven, not preemptive.

5. **`maxPersistedMessages`.** Replaced by Session's compaction overlays — non-destructive summarization instead of lossy deletion.

6. **`reconcileMessages`.** Session's tree structure with idempotent append and explicit `updateMessage` handles the core cases (ID conflicts, tool state merge) without a separate reconciliation pipeline.

### Where Think can lead

1. **Structured override points.** Think's `getModel()`, `getSystemPrompt()`, `getTools()`, `getMaxSteps()`, `configureSession()`, `assembleContext()` are much better than AIChatAgent's "override `onChatMessage` and wire everything yourself." These should be preserved and enhanced.

2. **Sub-agent RPC (`chat()`).** AIChatAgent doesn't have this. The `chat(userMessage, callback, options?)` method for parent agents to drive sub-agent turns via RPC is a genuine differentiator for multi-agent architectures. This should be enhanced with `saveMessages`-equivalent programmatic turns.

3. **Context blocks and compaction.** Session gives Think persistent, LLM-writable context blocks and non-destructive compaction — features AIChatAgent doesn't have. See [think-sessions.md](./think-sessions.md).

4. **Branching and regeneration.** Session's tree-structured messages provide non-destructive regeneration (alternatives preserved via branches) — strictly better than AIChatAgent's delete-and-rerun approach.

5. **Multi-session and search.** `SessionManager` provides conversation lifecycle, cross-session FTS5 search, usage tracking, and forking — none of which AIChatAgent has.

6. **Dynamic configuration (`configure()` / `getConfig()`).** This is a cleaner pattern than `body` persistence for agent-level settings. It should coexist with `body` (per-request context) rather than replacing it.

7. **Extension system.** `ExtensionManager` + sandboxed Worker tools are unique to Think and have no AIChatAgent equivalent. These should be preserved.

8. **Client layer improvements.** The client-side issues (C1–C8) affect both Think and AIChatAgent equally since they share `useAgentChat`. Think could provide `useThinkChat` as an enhanced combined hook that simplifies setup and adds Think-specific features (config management, extension UI, context block display, branching navigation, session switching).

---

## Summary: Prioritized Improvements

### Tier 1: High impact, fix the pain

| #   | Issue                                                   | Impact                                                       | Effort         |
| --- | ------------------------------------------------------- | ------------------------------------------------------------ | -------------- |
| C1  | Non-suspending hook + exported fetch + fallbackMessages | Unblocks framework integration, fixes conversation switching | Medium         |
| S1  | Drop `onFinish` from `onChatMessage` signature          | Cleaner API, less confusion                                  | Low (breaking) |
| C3  | Tool UI components / utilities                          | Eliminates most repeated code across apps                    | Medium         |
| C2  | Combined `useAgentChat` with built-in connection        | Removes boilerplate for 90% of apps                          | Medium         |

### Tier 2: Significant quality-of-life

| #   | Issue                                             | Impact                                        | Effort |
| --- | ------------------------------------------------- | --------------------------------------------- | ------ |
| S2  | `continuation` flag on `OnChatMessageOptions`     | Enables proper recovery/continuation handling | Low    |
| C4  | Unified streaming status                          | Eliminates subtle streaming detection bugs    | Low    |
| S4  | Accept `StreamableResult \| Response` return type | Better abstraction, Think alignment           | Medium |
| X4  | Message rendering helpers                         | Reduces boilerplate for every chat UI         | Medium |
| C5  | Structured error handling on client               | Proper error UX                               | Low    |

### Tier 3: Polish and completeness

| #   | Issue                                          | Impact                                   | Effort         |
| --- | ---------------------------------------------- | ---------------------------------------- | -------------- |
| S3  | Message access helpers                         | Convenience, less raw array manipulation | Low            |
| X1  | Remove deprecated options (major version)      | Cleaner API surface, smaller bundle      | Medium         |
| C6  | `addToolOutput` naming alignment               | Reduces confusion with AI SDK docs       | Low (breaking) |
| X2  | Conversation management helpers                | Supports multi-conversation apps         | High           |
| X3  | Chat + RPC integration                         | Unified agent interaction                | Medium         |
| C8  | Remove `@ts-expect-error` PartySocket coupling | Maintenance, reliability                 | Low            |
| S5  | Document persistence timeline                  | Clarity for advanced users               | Low            |

### Tier 4: Architectural evolution

| #   | Issue                                 | Impact                         | Effort |
| --- | ------------------------------------- | ------------------------------ | ------ |
| X5  | Resume system consolidation           | Debuggability, maintainability | High   |
| C7  | Request cache improvements (SSR, TTL) | SSR correctness, cache hygiene | Medium |
