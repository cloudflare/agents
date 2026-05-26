# 04 — High-Level Chat Agents: AIChatAgent and Think

Two packages build on the chat protocol internals from section 03 to provide ready-to-use chat agents. `AIChatAgent` (in `packages/ai-chat`) is the flexible base class you extend with your own LLM call. `Think` (in `packages/think`) is a batteries-included agent that wires together the LLM loop, tool execution, extensions, and a virtual filesystem for you.

---

## AIChatAgent (`packages/ai-chat`)

### Main class (`src/index.ts`)

[`AIChatAgent<Env, State>` class — overall structure](../packages/ai-chat/src/index.ts#L1-L200) — imports, exported types (`ChatMessage`, `ChatResponseResult`, etc.), and the class declaration. Extends `Agent` from the core SDK.

[WebSocket message routing — onMessage() dispatch and request handling](../packages/ai-chat/src/index.ts#L600-L800) and [WebSocket routing — tool result, approval, and stream resume handlers](../packages/ai-chat/src/index.ts#L800-L1000) — `onMessage()` override. Parses incoming `CF_AGENT_*` messages and dispatches to `_handleChatRequest()`, `_handleToolResult()`, `_handleToolApproval()`, `_handleStreamResumeRequest()`, etc.

[Stream resumption flow](../packages/ai-chat/src/index.ts#L1000-L1200) — when a client reconnects after a disconnect, the agent sends `CF_AGENT_STREAM_RESUMING`, waits for the `CF_AGENT_STREAM_RESUME_ACK`, and then replays buffered chunks from the `ResumableStream`. If no live stream is running, it returns `CF_AGENT_STREAM_RESUME_NONE`.

[`onChatMessage()` abstract method and `onChatResponse()` hook](../packages/ai-chat/src/index.ts#L2000-L2200) — `onChatMessage()` is **the one method you must implement**. It receives the latest message list and should return a `Response` from `streamText()` (or `generateText()`). `onChatResponse()` is a no-op hook called after each turn completes; override for logging or post-processing. Also contains `sanitizeMessageForPersistence()` and agent-tool output helpers (`formatAgentToolInput`, `getAgentToolOutput`, `getAgentToolSummary`).

[`startAgentToolRun()` — agent-as-tool lifecycle](../packages/ai-chat/src/index.ts#L2200-L2550) — implements the pattern where another agent invokes this agent as a tool. Writes a `running` row to `cf_ai_chat_agent_tool_runs`, calls `saveMessages()` to drive the turn, and updates the row to `completed`/`aborted`/`error` when done. `inspectAgentToolRun()` lets the parent poll status.

[Agent-tool helpers — tailer streams, stored chunk access, and cancel](../packages/ai-chat/src/index.ts#L2550-L2700) — `cancelAgentToolRun()`, `inspectAgentToolRun()`, SQLite helpers for reading run rows and stored chunks, and the live-chunk forwarder mechanism used by streaming tail readers.

[`saveMessages()` programmatic API](../packages/ai-chat/src/index.ts#L2700-L2850) — run a chat turn without a WebSocket connection. Accepts a message array or a function that derives the next message list from `this.messages`. Waits for any active turn to finish, then calls `onChatMessage()` and returns `{ requestId, status }`. Useful for scheduled turns, webhooks, or agent-to-agent calls.

[`continueLastTurn()` and `_retryLastUserTurn()`](../packages/ai-chat/src/index.ts#L2850-L3000) — `continueLastTurn()` triggers a continuation turn that appends to the last assistant message without inserting a new user message (the same mechanism used by tool auto-continuation). `_retryLastUserTurn()` re-runs inference for an unanswered user message.

[Chat recovery via fibers — `_handleInternalFiberRecovery()` and `onChatRecovery()`](../packages/ai-chat/src/index.ts#L3000-L3250) — after a Durable Object hibernation, the framework calls `_handleInternalFiberRecovery()` for any interrupted `__cf_internal_chat_turn` fiber. It unwraps the stored `ChatFiberSnapshot`, looks up the partial stream, and calls the overridable `onChatRecovery()` hook so the subclass can decide whether to persist, continue, or handle recovery itself. Schedules `_chatRecoveryContinue` or `_chatRecoveryRetry` accordingly.

[`_chatRecoveryRetry()`, `_getPartialStreamText()`, and `persistMessages()`](../packages/ai-chat/src/index.ts#L3250-L3500) — `_chatRecoveryRetry()` re-runs the last unanswered user turn after recovery. `_getPartialStreamText()` reconstructs text and parts from stored stream chunks. `persistMessages()` is the core incremental persistence helper: reconciles the incoming list against `this.messages`, upserts only changed rows into SQLite, and optionally deletes stale rows.

[Message row size enforcement — `_enforceRowSizeLimit()`, `_truncateTextParts()`, and `_findAndUpdateToolPart()`](../packages/ai-chat/src/index.ts#L3500-L3700) — `_enforceRowSizeLimit()` compacts tool outputs and truncates text parts when a serialized message approaches the SQLite row size cap. `_findAndUpdateToolPart()` is the shared helper for both tool result and tool approval updates: searches the streaming message first, then retries persisted messages with backoff, applies the mutation, and broadcasts `CF_AGENT_MESSAGE_UPDATED`.

[`_applyToolResult()`, `_streamSSEReply()` — streaming the LLM response](../packages/ai-chat/src/index.ts#L3700-L3999) — `_applyToolResult()` applies a client-sent tool result to the stored tool part (transitions `input-available` → `output-available`). `_streamSSEReply()` reads AI SDK v5 SSE chunks, applies each to the in-memory `_streamingMessage` via `applyChunkToParts`, stores them in `ResumableStream`, and broadcasts them to connected clients. Handles approval-persist, cross-message tool output fallback, and abort.

[`_streamSSEReply()` continued — chunk broadcast, error path, and abort handling](../packages/ai-chat/src/index.ts#L4000-L4299) — second half of the SSE streaming loop: filtering replay chunks to avoid client-side double-application, broadcasting each stored chunk body, sending the final `done: true` message, and handling error and abort exit paths.

[`_sendPlaintextReply()`, `_applyToolApproval()`, `_reply()`, and `destroy()`](../packages/ai-chat/src/index.ts#L4300-L4593) — `_sendPlaintextReply()` handles plain-text (non-SSE) responses from `generateText()`. `_applyToolApproval()` transitions an approval-requested tool part to `approval-responded` or `output-denied`. `_reply()` is the top-level reply dispatcher: starts the stream, picks SSE vs plaintext, persists the final assistant message, and enqueues the `onChatResponse` result. `destroy()` aborts all in-flight requests.

### Chat implementation internals (`src/index.ts` continued)

[Concurrency helpers and merge logic](../packages/ai-chat/src/index.ts#L1200-L1499) — `_startStream`, `_completeStream`, `_storeStreamChunk`, and `_restoreActiveStream` delegate to `ResumableStream`. `_persistOrphanedStream()` reconstructs a partial assistant message from stored stream chunks after hibernation. `_restoreRequestContext()` and `_persistRequestContext()` save `_lastBody`/`_lastClientTools` to SQLite so they survive hibernation. Message-merge helpers (`_getMergedQueuedUserMessages`, `_mergeUserMessages`) consolidate overlapping user submits under the `"merge"` concurrency strategy.

[Concurrency decision, submission queue, and auto-continuation scheduling](../packages/ai-chat/src/index.ts#L1500-L1799) — `_getSubmitConcurrencyDecision()` consults `SubmitConcurrencyController` to decide whether to drop, debounce, or merge an incoming submit. `_enqueueAutoContinuation()` stores a deferred continuation request in `ContinuationState`, `_queueAutoContinuation()` schedules it through `TurnQueue`. These work together so the agent can process overlapping submits without conflicting turns.

[`_runExclusiveChatTurn()`, `_enqueueAutoContinuation()`, and `_queueAutoContinuation()`](../packages/ai-chat/src/index.ts#L1800-L2000) — `_runExclusiveChatTurn()` gates every turn through `TurnQueue` so streams never overlap, and drains the `_pendingChatResponseResults` queue (firing `onChatResponse`) when the lock is released. `_queueAutoContinuation()` runs the full auto-continuation turn through the same exclusive gate, calling `onChatMessage()` with `continuation: true` and then `_reply()`.

### React integration (`src/react.tsx`)

[Deprecated types, tool part helpers, and `getAgentMessages()`](../packages/ai-chat/src/react.tsx#L1-L200) — deprecated `AITool` type and `extractClientToolSchemas()` for legacy client-tool registration. Tool part state helpers exported for UI rendering: `getToolPartState()` (maps internal states to `"loading"`, `"waiting-approval"`, `"complete"`, etc.), `getToolCallId()`, `getToolInput()`, `getToolOutput()`, `getToolApproval()`. Also `getAgentMessages()`, a standalone fetch helper for loading chat history from the agent's `/get-messages` endpoint (useful in framework loaders before the component tree mounts).

[`UseAgentChatOptions` type and helper functions](../packages/ai-chat/src/react.tsx#L200-L499) — the full `UseAgentChatOptions` interface extending `@ai-sdk/react`'s `UseChatOptions` with agent-specific options: `agent` (WebSocket connection), `onToolCall`, `autoContinueAfterToolResult`, `resume`, `body`, `prepareSendMessagesRequest`, and others. Also contains utility functions used internally by `useAgentChat` (`agentNameToKebab`, `findLastAssistantMessage`, `moveMessageToEnd`, `prependMissingHydratedMessages`, `detectToolsRequiringConfirmation`).

[`useAgentChat()` hook — WebSocket transport setup and initial message hydration](../packages/ai-chat/src/react.tsx#L500-L799) — the `useAgentChat()` hook body. Creates a singleton `WebSocketChatTransport` (kept stable across renders so stream resume resolvers are never orphaned), fetches initial messages from `/get-messages`, and integrates the transport into `@ai-sdk/react`'s `useChat()`. Also handles the late-seed effect that applies server history after the component mounts when the URL was not ready on first render.

[`useAgentChat()` — streaming protection, hydration deduplication, and tool resolution](../packages/ai-chat/src/react.tsx#L800-L1050) — `protectStreamingAssistantTail()` temporarily moves the actively-streaming assistant message to the end of the list so incoming `CF_AGENT_CHAT_MESSAGES` broadcasts from other tabs cannot displace it mid-stream. `resetMatchingHydratedAssistantForReplay()` clears a hydrated assistant message when a stream replay is detected so parts are not duplicated. `collapseHydratedReplayTextParts()` removes a prefix text part that was already present from SSR/hydration once replay rebuilds it. `stopWithToolContinuationAbort` wraps `stop()` to also abort any active tool-continuation transport stream.

[`useAgentChat()` — deprecated auto-resolution effect, local state reset, and tool output helpers](../packages/ai-chat/src/react.tsx#L1050-L1200) — deprecated `experimental_automaticToolResolution` effect (replaced by `onToolCall`). `resetLocalChatState()` is the shared reset called on both `clearHistory()` and `CF_AGENT_CHAT_CLEAR` broadcasts. Also contains the streaming-message protection restore logic and `resetMatchingHydratedAssistantForReplay`.

[`useAgentChat()` — `onToolCall` effect, `sendToolOutputToServer()`, and `sendToolApprovalToServer()`](../packages/ai-chat/src/react.tsx#L1200-L1499) — the `onToolCall` effect fires when tool parts enter `input-available` state and dispatches to the caller's `onToolCall` callback with an `addToolOutput` helper. `sendToolOutputToServer()` serialises a `CF_AGENT_TOOL_RESULT` message over the WebSocket and optionally starts a tool-continuation stream. `sendToolApprovalToServer()` sends `CF_AGENT_TOOL_APPROVAL`.

[`useAgentChat()` — `onAgentMessage` handler and `BroadcastStreamState` transitions](../packages/ai-chat/src/react.tsx#L1500-L1799) — the unified `onAgentMessage` WebSocket event handler. Dispatches on message type: `CF_AGENT_CHAT_CLEAR`, `CF_AGENT_CHAT_MESSAGES`, `CF_AGENT_MESSAGE_UPDATED`, `CF_AGENT_STREAM_RESUMING`, and `CF_AGENT_USE_CHAT_RESPONSE`. For response chunks, drives `broadcastTransition()` against `streamStateRef` (a `BroadcastStreamState` machine) so secondary tabs observing another tab's stream receive and reassemble the chunk sequence correctly.

[`useAgentChat()` — deprecated `addToolResult` wrapper, `addToolApprovalResponse`, messages with tool results, and return value](../packages/ai-chat/src/react.tsx#L1800-L2206) — deprecated `addToolResultAndSendMessage` wraps the AI SDK's `addToolResult` with server notification and optional legacy auto-send. `addToolApprovalResponseAndNotifyServer` finds the tool call by approval ID and calls `sendToolApprovalToServer` before updating local state. `messagesWithToolResults` merges optimistic `clientToolResults` state into the message array so tool parts show `output-available` immediately. `hasPendingClientToolCalls` drives `isStreaming` while an `onToolCall` handler is running. The final `return` assembles the public hook surface including `sendMessage`, `stop`, `addToolOutput`, `addToolApprovalResponse`, `clearHistory`, and `isStreaming`.

### WebSocket transport (`src/ws-chat-transport.ts`)

The React hook uses an explicit `ChatTransport` object rather than HTTP, which allows it to multiplex a single WebSocket connection with the agent.

[`AgentConnection` interface](../packages/ai-chat/src/ws-chat-transport.ts#L1-L100) — the minimal surface the transport needs from a connected agent: `send()`, `addEventListener()`, `removeEventListener()`. This matches the object returned by the `useAgent()` hook in `packages/agents/src/react.tsx`.

[WebSocketChatTransport — submitMessage(), cancelActiveServerTurn(), and sendMessages()](../packages/ai-chat/src/ws-chat-transport.ts#L100-L350) and [WebSocketChatTransport — reconnectToStream() and stream resumption handshake](../packages/ai-chat/src/ws-chat-transport.ts#L350-L600) and [WebSocketChatTransport — tool continuation streams and _createResumeStream()](../packages/ai-chat/src/ws-chat-transport.ts#L600-L788) — implements the AI SDK's `ChatTransport<ChatMessage>` interface. On `submitMessage()` it serialises a `CF_AGENT_USE_CHAT_REQUEST` and writes it over the WebSocket. It then listens for `CF_AGENT_USE_CHAT_RESPONSE` messages and feeds each chunk to the AI SDK's internal stream. The class also handles the stream resumption handshake (`STREAM_RESUMING` → `STREAM_RESUME_ACK`) and client-tool round-trips.

### Message protocol types (`src/types.ts`)

[`MessageType` enum](../packages/ai-chat/src/types.ts#L1-L161) — the `CF_AGENT_*` constants as a TypeScript enum (compare with the plain object in `packages/agents/src/types.ts`). Also defines `OutgoingMessage` (server→client) and `IncomingMessage` (client→server) types that spell out the full shape of each wire message including optional fields like `done`, `continuation`, `replay`, and `replayComplete`.

### V4 → V5 message migration (`src/ai-chat-v5-migration.ts`)

[`autoTransformMessages()` and `STATE_MAP`](../packages/ai-chat/src/ai-chat-v5-migration.ts#L1-L161) — if you have messages persisted in the old AI SDK v4 format (with `toolInvocations` arrays and string `state` fields), this function transforms them to v5's part-based format. Called automatically when loading history.

[Migration implementation details](../packages/ai-chat/src/ai-chat-v5-migration.ts#L162-L404) — the per-message transformation: converts `content` strings to `text` parts, maps `toolInvocations` to the new tool part structure using `STATE_MAP`, and handles `CorruptArrayMessage` cases where `content` is accidentally stored as an array instead of a string.

---

## Think (`packages/think`)

`Think` is a higher-level agent that packages the full agentic loop: LLM inference, tool use, context blocks, FTS5 search, extension Workers, and virtual filesystem. You write a few config overrides and get a fully functioning coding/reasoning agent.

### Think internals (`src/think.ts` continued)

[Message history and FTS5 search](../packages/think/src/think.ts#L800-L1000) — Think maintains a SQLite table with FTS5 indexing over message content. The `search(query)` method runs a full-text query and returns ranked results. Context blocks can have a search provider attached, enabling semantic memory retrieval.

[Think turn loop — build context, call model, and stream chunks](../packages/think/src/think.ts#L1200-L1499) and [Think turn loop — tool call accumulation, execution, and loop back](../packages/think/src/think.ts#L1500-L1799) and [Think turn loop — hook dispatch and loop termination](../packages/think/src/think.ts#L1800-L2000) — the full agentic loop: build context → run model → stream chunks → accumulate tool calls → execute tools → loop back with results. Hooks are called at each phase. The loop terminates when the model produces no new tool calls.

[Extension hook dispatch](../packages/think/src/think.ts#L2000-L2100) — for each lifecycle event, Think iterates over extension Workers that subscribed to the hook, serialises the event as a `TurnContextSnapshot`, and calls the extension's hook handler over RPC. Results are applied back to the turn context.

[Host bridge methods](../packages/think/src/think.ts#L2100-L2200) — methods that Think exposes to extension Workers via `HostBridgeLoopback`. These are the controlled back-door through which extensions can affect Think's state without full access.

[Think recovery — saving in-progress fiber state on hibernation](../packages/think/src/think.ts#L4400-L4699) and [Think recovery — restoring turn on wakeup via ChatRecoveryContext](../packages/think/src/think.ts#L4700-L4999) and [Think — stream finalisation, database bookkeeping, and fiber cleanup (part 1)](../packages/think/src/think.ts#L5000-L5299) and [Think — stream finalisation and fiber cleanup (part 2)](../packages/think/src/think.ts#L5300-L5421) — how Think saves in-progress fiber state when the Durable Object hibernates mid-turn, and how it recovers the turn on wakeup. The `ChatRecoveryContext` (from `packages/agents/src/chat/recovery.ts`) captures enough state to re-establish the stream.

### Core class (`src/think.ts`)

[Core architecture and documentation header](../packages/think/src/think.ts#L1-L200) — the opening comment explains Think's design philosophy, capabilities (tree-structured messages, multi-session SQLite, context blocks, fiber recovery), and how it relates to `AIChatAgent`.

[`getModel()`, `getSystemPrompt()`, `getTools()` — configuration overrides](../packages/think/src/think.ts#L1000-L1100) — the three methods most subclasses need to override. `getModel()` returns the AI SDK model to use. `getSystemPrompt()` returns the system prompt string. `getTools()` returns the `ToolSet`.

[System prompt building and Think capability block](../packages/think/src/think.ts#L1100-L1200) — Think auto-generates a structured system prompt section that tells the LLM about the available context blocks and workspace tools. You can inject this into your own prompt via `getThinkBlock()`.

[Lifecycle hooks](../packages/think/src/think.ts#L2000-L2100) — Think exposes richer hooks than `AIChatAgent`:
- `beforeTurn(ctx)` — inspect/mutate the turn context before inference
- `beforeStep(ctx)` — called before each reasoning step
- `beforeToolCall(ctx, call)` — intercept a tool call before execution
- `afterToolCall(ctx, call, result)` — inspect the result after execution
- `onStepFinish(snapshot)` — per-step analytics
- `onChunk(snapshot)` — per-chunk callbacks for streaming analytics
- `onChatResponse(result)` — post-turn hook

[Sub-agent RPC entry point — `chat()` method](../packages/think/src/think.ts#L2100-L2200) — when Think is used as a sub-agent (called over RPC by another agent), this method is the entry point. It streams responses via a callback rather than a WebSocket.

[Think — context block initialisation and session-backed SQLite setup](../packages/think/src/think.ts#L400-L699) and [Think — message history schema and FTS5 search index setup](../packages/think/src/think.ts#L700-L800) — persistent key-value memory that the LLM can read and write. Each block has a label and a type (`"string"`, `"json"`, `"markdown"`, etc.). They are stored in SQLite and injected into the system prompt on each turn so the LLM accumulates knowledge across sessions.

[Session-backed SQLite storage](../packages/think/src/think.ts#L800-L1000) — Think maintains a richer message history than `AIChatAgent`: FTS5 full-text search over messages, non-destructive compaction, and multi-session support (each conversation is a separate session).

[Programmatic turns — `submitMessages()`](../packages/think/src/think.ts#L3000-L3100) — same as `AIChatAgent`'s `submitMessages()`, but with Think's full lifecycle hooks applied.

[Think recovery — saving in-progress fiber state on hibernation](../packages/think/src/think.ts#L4400-L4699) and [Think recovery — restoring turn on wakeup via ChatRecoveryContext](../packages/think/src/think.ts#L4700-L4999) and [Think — stream finalisation, database bookkeeping, and fiber cleanup (part 1)](../packages/think/src/think.ts#L5000-L5299) and [Think — stream finalisation and fiber cleanup (part 2)](../packages/think/src/think.ts#L5300-L5421) — end-of-stream bookkeeping: updating the database, broadcasting the final message list, cleaning up fibers.

### Extensions (`src/extensions/`)

Think supports dynamically-loaded *extension Workers* that can add tools, context blocks, and lifecycle hooks without redeploying the main agent.

[`ExtensionManifest` type in `types.ts`](../packages/think/src/extensions/types.ts#L1-L130) — what an extension declares: its name, the permissions it needs (network access, workspace read/write, context access), the context block labels it owns, and the lifecycle hook names it subscribes to.

[ExtensionManager — class setup, load(), and restore()](../packages/think/src/extensions/manager.ts#L1-L210) and [ExtensionManager — unload(), getContextLabels(), getHookSubscribers(), getTools(), and wrapExtensionSource()](../packages/think/src/extensions/manager.ts#L210-L414) — loads and manages the set of active extensions. 

[`load()` method](../packages/think/src/extensions/manager.ts#L100-L200) — loads an extension from JavaScript source text. The source is wrapped in a `WorkerEntrypoint` class and installed as a dynamic Worker binding. Once loaded, its tools are available in `getTools()` and its context labels in `getContextLabels()`.

[`restore()` method](../packages/think/src/extensions/manager.ts#L200-L300) — restores loaded extensions from Durable Object storage after a hibernation cycle. Think calls this in `onStart()`.

[`getHookSubscribers()` and hook dispatch](../packages/think/src/extensions/manager.ts#L300-L414) — when a lifecycle event fires (e.g. `afterToolCall`), Think uses this to find which extensions subscribed to it and calls their hook handler via RPC.

[`HostBridgeLoopback` class in `host-bridge.ts`](../packages/think/src/extensions/host-bridge.ts#L1-L213) — a `WorkerEntrypoint` that extensions call back into to access controlled Think capabilities (workspace file operations, context reads/writes, message history). Permission checks (`#requireWorkspace()`, `#requireContextRead()`, etc.) enforce the declared manifest.

[Bridge provider adapters in `bridge-provider.ts`](../packages/think/src/extensions/bridge-provider.ts#L1-L87) — adapt the host bridge's RPC calls into the `ContextProvider` interface used by the session system.

[Hook snapshot types in `hook-proxy.ts`](../packages/think/src/extensions/hook-proxy.ts#L1-L251) — `TurnContextSnapshot`, `ToolCallStartSnapshot`, etc. are serialisable snapshots of Think's internal turn context. Sent to extension Workers over RPC so they can react to events without holding live references.

### Tools (`src/tools/`)

Think packages a set of standard tools that most coding agents need.

[WorkspaceLike type, createWorkspaceTools() factory, and read tool](../packages/think/src/tools/workspace.ts#L1-L300) and [Workspace write, edit, and list tools](../packages/think/src/tools/workspace.ts#L300-L599) and [Workspace find, grep, and delete tools](../packages/think/src/tools/workspace.ts#L600-L800) — `createWorkspaceTools(workspace)` returns a `ToolSet` with `read`, `write`, `edit`, `list`, `find`, `grep`, and `delete` tools. Each tool is a thin wrapper around the `Workspace` filesystem (see section 06). The `read` tool handles images and PDFs as multimodal content.

[Browser automation tools in `browser.ts`](../packages/think/src/tools/browser.ts#L1-L131) — `createBrowserTools()` returns `browser_search` and `browser_execute`. The LLM writes JavaScript that runs in a sandboxed Worker with access to a Chrome DevTools Protocol session. Delegates to `createBrowserToolHandlers()` from `packages/agents/src/browser/`.

[Code execution tool in `execute.ts`](../packages/think/src/tools/execute.ts#L1-L168) — `createExecuteTool()` returns a single `execute` tool. The LLM writes JavaScript that runs inside a `DynamicWorkerExecutor`. The tool can optionally expose the workspace filesystem API (read, write, glob) to the generated code. The `codemode.*` prefix namespaces the operations.

[Extension management tools in `extensions.ts`](../packages/think/src/tools/extensions.ts#L1-L129) — `createExtensionTools()` returns `load_extension` and `list_extensions`. The LLM can call `load_extension` to dynamically add capabilities to itself at runtime.
