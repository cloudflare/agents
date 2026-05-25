# 04 — High-Level Chat Agents: AIChatAgent and Think

Two packages build on the chat protocol internals from section 03 to provide ready-to-use chat agents. `AIChatAgent` (in `packages/ai-chat`) is the flexible base class you extend with your own LLM call. `Think` (in `packages/think`) is a batteries-included agent that wires together the LLM loop, tool execution, extensions, and a virtual filesystem for you.

---

## AIChatAgent (`packages/ai-chat`)

### Main class (`src/index.ts`)

[`AIChatAgent<Env, State>` class — overall structure](../packages/ai-chat/src/index.ts#L1-L200) — imports, exported types (`ChatMessage`, `ChatResponseResult`, etc.), and the class declaration. Extends `Agent` from the core SDK.

[WebSocket message routing](../packages/ai-chat/src/index.ts#L600-L1000) — `onMessage()` override. Parses incoming `CF_AGENT_*` messages and dispatches to `_handleChatRequest()`, `_handleToolResult()`, `_handleToolApproval()`, `_handleStreamResumeRequest()`, etc.

[Stream resumption flow](../packages/ai-chat/src/index.ts#L1000-L1200) — when a client reconnects after a disconnect, the agent sends `CF_AGENT_STREAM_RESUMING`, waits for the `CF_AGENT_STREAM_RESUME_ACK`, and then replays buffered chunks from the `ResumableStream`. If no live stream is running, it returns `CF_AGENT_STREAM_RESUME_NONE`.

[`submitMessages()` programmatic API](../packages/ai-chat/src/index.ts#L2000-L2200) — run a chat turn without a WebSocket connection. Useful for testing, webhooks, or agent-to-agent calls. Returns a `ChatResponseResult`.

[`onChatMessage()` abstract method](../packages/ai-chat/src/index.ts#L2100-L2200) — **this is the one method you must implement**. It receives the current message list and should call `streamText()` from the AI SDK, returning the resulting `AsyncIterable<string>`. Everything else (chunking, persistence, broadcasting) is handled by the base class.

[`onChatResponse()` hook](../packages/ai-chat/src/index.ts#L2200-L2300) — called after each turn completes. Override to do logging, trigger downstream agents, or post-process the result.

[Tool approval workflow](../packages/ai-chat/src/index.ts#L3500-L3700) — when a tool is marked `requiresApproval: true`, the agent pauses the turn, sends a `TOOL_APPROVAL` request to the client, and waits for the user's `yes`/`no` response before continuing.

[Auto-continuation](../packages/ai-chat/src/index.ts#L1000-L1200) — after a tool result arrives, `ContinuationState` (from section 03) kicks off another LLM call automatically so the model can continue reasoning with the new data.

[Message persistence — `saveMessages()` hook](../packages/ai-chat/src/index.ts#L3700-L3999) — called after each turn. Override to persist messages to your own store. The default implementation saves to SQLite in the agent's Durable Object storage.

### Chat implementation internals (`src/index.ts` continued)

[`_handleChatRequest()` — the main turn handler](../packages/ai-chat/src/index.ts#L1200-L2000) — the full implementation of processing a user message: checking concurrency policy via `SubmitConcurrencyController`, running the turn inside `TurnQueue`, calling `onChatMessage()`, accumulating stream chunks via `StreamAccumulator`, broadcasting partial messages to all connected clients, and persisting the final message.

[`_handleToolResult()` and continuation dispatch](../packages/ai-chat/src/index.ts#L2300-L2700) — when a client sends a tool result (`CF_AGENT_TOOL_RESULT`), this method finds the matching pending tool call, updates it in the message array, and triggers the continuation turn (the follow-up LLM call with the result).

[`_handleToolApproval()` — human-in-the-loop](../packages/ai-chat/src/index.ts#L2700-L3000) — receives a `CF_AGENT_TOOL_APPROVAL` from the client, updates the tool part to `"approval-responded"`, and resumes the paused turn.

[`_handleStreamResumeRequest()` — reconnection](../packages/ai-chat/src/index.ts#L3000-L3500) — checks whether there is an active `ResumableStream` for this connection, sends `CF_AGENT_STREAM_RESUMING`, waits for the ACK, and calls `stream.replay()` to replay stored chunks then hand off to the live stream.

[Message broadcasting and multi-client sync](../packages/ai-chat/src/index.ts#L3700-L4593) — how the agent broadcasts updated message arrays to all connected WebSocket clients simultaneously. Includes the logic for `BroadcastStreamState` (secondary tabs observing a stream started by the primary tab).

### React integration (`src/react.tsx`)

[`useAgentChat(agent, options)` React hook](../packages/ai-chat/src/react.tsx#L1-L200) — the simplest browser integration. Returns the same API as `@ai-sdk/react`'s `useChat` hook but over a WebSocket instead of HTTP. The transport layer is `WebSocketChatTransport`.

[`WebSocketChatTransport` class](../packages/ai-chat/src/react.tsx#L200-L800) — implements the `ChatTransport` interface from `@ai-sdk/react`. Sends `CF_AGENT_USE_CHAT_REQUEST` messages, receives stream chunks, and handles the `STREAM_RESUMING` handshake on reconnect.

### React hook internals (`src/react.tsx` continued)

[Connection lifecycle management in `useAgentChat`](../packages/ai-chat/src/react.tsx#L200-L800) — how the hook manages the WebSocket connection: establishing it on mount, reconnecting on error, and tearing it down on unmount. Also covers how `prepareBody` (a callback for injecting auth headers) is wired into the transport.

[Client tool schema extraction](../packages/ai-chat/src/react.tsx#L800-L1200) — `extractClientToolSchemas()` scans the `tools` option passed to `useAgentChat` and identifies any that have a browser-side `execute` function. These are sent to the server so it can generate AI SDK tool objects without execute functions for them; when the LLM calls one, the call is forwarded back to the browser.

[`useAgentChat` options and return value](../packages/ai-chat/src/react.tsx#L1200-L2207) — the full options type (extends `@ai-sdk/react`'s `UseChatOptions`), the additional agent-specific options (`agent`, `prepareBody`, `onToolCall`), and the full return type including `sendMessage`, `stop`, `reload`, and the message array.

### WebSocket transport (`src/ws-chat-transport.ts`)

The React hook uses an explicit `ChatTransport` object rather than HTTP, which allows it to multiplex a single WebSocket connection with the agent.

[`AgentConnection` interface](../packages/ai-chat/src/ws-chat-transport.ts#L1-L100) — the minimal surface the transport needs from a connected agent: `send()`, `addEventListener()`, `removeEventListener()`. This matches the object returned by the `useAgent()` hook in `packages/agents/src/react.tsx`.

[`WebSocketChatTransport` class](../packages/ai-chat/src/ws-chat-transport.ts#L100-L788) — implements the AI SDK's `ChatTransport<ChatMessage>` interface. On `submitMessage()` it serialises a `CF_AGENT_USE_CHAT_REQUEST` and writes it over the WebSocket. It then listens for `CF_AGENT_USE_CHAT_RESPONSE` messages and feeds each chunk to the AI SDK's internal stream. The class also handles the stream resumption handshake (`STREAM_RESUMING` → `STREAM_RESUME_ACK`) and client-tool round-trips.

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

[Turn execution loop](../packages/think/src/think.ts#L1200-L2000) — the full agentic loop: build context → run model → stream chunks → accumulate tool calls → execute tools → loop back with results. Hooks are called at each phase. The loop terminates when the model produces no new tool calls.

[Extension hook dispatch](../packages/think/src/think.ts#L2000-L2100) — for each lifecycle event, Think iterates over extension Workers that subscribed to the hook, serialises the event as a `TurnContextSnapshot`, and calls the extension's hook handler over RPC. Results are applied back to the turn context.

[Host bridge methods](../packages/think/src/think.ts#L2100-L2200) — methods that Think exposes to extension Workers via `HostBridgeLoopback`. These are the controlled back-door through which extensions can affect Think's state without full access.

[Recovery and hibernation handling](../packages/think/src/think.ts#L4400-L5421) — how Think saves in-progress fiber state when the Durable Object hibernates mid-turn, and how it recovers the turn on wakeup. The `ChatRecoveryContext` (from `packages/agents/src/chat/recovery.ts`) captures enough state to re-establish the stream.

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

[Context blocks](../packages/think/src/think.ts#L400-L800) — persistent key-value memory that the LLM can read and write. Each block has a label and a type (`"string"`, `"json"`, `"markdown"`, etc.). They are stored in SQLite and injected into the system prompt on each turn so the LLM accumulates knowledge across sessions.

[Session-backed SQLite storage](../packages/think/src/think.ts#L800-L1000) — Think maintains a richer message history than `AIChatAgent`: FTS5 full-text search over messages, non-destructive compaction, and multi-session support (each conversation is a separate session).

[Programmatic turns — `submitMessages()`](../packages/think/src/think.ts#L3000-L3100) — same as `AIChatAgent`'s `submitMessages()`, but with Think's full lifecycle hooks applied.

[Stream finalisation and message persistence](../packages/think/src/think.ts#L4400-L5421) — end-of-stream bookkeeping: updating the database, broadcasting the final message list, cleaning up fibers.

### Extensions (`src/extensions/`)

Think supports dynamically-loaded *extension Workers* that can add tools, context blocks, and lifecycle hooks without redeploying the main agent.

[`ExtensionManifest` type in `types.ts`](../packages/think/src/extensions/types.ts#L1-L130) — what an extension declares: its name, the permissions it needs (network access, workspace read/write, context access), the context block labels it owns, and the lifecycle hook names it subscribes to.

[`ExtensionManager` class in `manager.ts`](../packages/think/src/extensions/manager.ts#L1-L414) — loads and manages the set of active extensions. 

[`load()` method](../packages/think/src/extensions/manager.ts#L100-L200) — loads an extension from JavaScript source text. The source is wrapped in a `WorkerEntrypoint` class and installed as a dynamic Worker binding. Once loaded, its tools are available in `getTools()` and its context labels in `getContextLabels()`.

[`restore()` method](../packages/think/src/extensions/manager.ts#L200-L300) — restores loaded extensions from Durable Object storage after a hibernation cycle. Think calls this in `onStart()`.

[`getHookSubscribers()` and hook dispatch](../packages/think/src/extensions/manager.ts#L300-L414) — when a lifecycle event fires (e.g. `afterToolCall`), Think uses this to find which extensions subscribed to it and calls their hook handler via RPC.

[`HostBridgeLoopback` class in `host-bridge.ts`](../packages/think/src/extensions/host-bridge.ts#L1-L213) — a `WorkerEntrypoint` that extensions call back into to access controlled Think capabilities (workspace file operations, context reads/writes, message history). Permission checks (`#requireWorkspace()`, `#requireContextRead()`, etc.) enforce the declared manifest.

[Bridge provider adapters in `bridge-provider.ts`](../packages/think/src/extensions/bridge-provider.ts#L1-L87) — adapt the host bridge's RPC calls into the `ContextProvider` interface used by the session system.

[Hook snapshot types in `hook-proxy.ts`](../packages/think/src/extensions/hook-proxy.ts#L1-L251) — `TurnContextSnapshot`, `ToolCallStartSnapshot`, etc. are serialisable snapshots of Think's internal turn context. Sent to extension Workers over RPC so they can react to events without holding live references.

### Tools (`src/tools/`)

Think packages a set of standard tools that most coding agents need.

[Workspace tools in `workspace.ts`](../packages/think/src/tools/workspace.ts#L1-L800) — `createWorkspaceTools(workspace)` returns a `ToolSet` with `read`, `write`, `edit`, `list`, `find`, `grep`, and `delete` tools. Each tool is a thin wrapper around the `Workspace` filesystem (see section 06). The `read` tool handles images and PDFs as multimodal content.

[Browser automation tools in `browser.ts`](../packages/think/src/tools/browser.ts#L1-L131) — `createBrowserTools()` returns `browser_search` and `browser_execute`. The LLM writes JavaScript that runs in a sandboxed Worker with access to a Chrome DevTools Protocol session. Delegates to `createBrowserToolHandlers()` from `packages/agents/src/browser/`.

[Code execution tool in `execute.ts`](../packages/think/src/tools/execute.ts#L1-L168) — `createExecuteTool()` returns a single `execute` tool. The LLM writes JavaScript that runs inside a `DynamicWorkerExecutor`. The tool can optionally expose the workspace filesystem API (read, write, glob) to the generated code. The `codemode.*` prefix namespaces the operations.

[Extension management tools in `extensions.ts`](../packages/think/src/tools/extensions.ts#L1-L129) — `createExtensionTools()` returns `load_extension` and `list_extensions`. The LLM can call `load_extension` to dynamically add capabilities to itself at runtime.
