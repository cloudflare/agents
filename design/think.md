# Think

An opinionated `Agent` base class for AI assistants. Think owns the chat lifecycle — the agentic loop, message persistence, streaming, client tools, resumable streams, durable recovery, and extensions — on Durable Object SQLite.

**Status:** experimental (`@cloudflare/think`).

This file records how Think is put together and why. For API usage see [`docs/think/index.md`](../docs/think/index.md) and the pages it links; for recovery behavior shared with `AIChatAgent` see [`docs/agents/chat-agents.md#stream-recovery`](../docs/agents/chat-agents.md#stream-recovery).

## Problem

Every chat agent needs the same infrastructure: durable message storage, streaming with cancellation, a tool loop with step limits, client-side tools and approvals, stream resumption after reconnect, and recovery when the Durable Object is evicted mid-turn. `Agent` provides the Durable Object primitives but no opinion on how to run a chat. `AIChatAgent` provides the protocol plumbing but leaves the model call to the subclass.

Think is the opinion: the subclass declares a model, tools, and context, and Think runs the turn.

## How it works

### Composition

```
Agent (agents)                     Lifecycle, Tasks, Scheduler, MCP, WebSockets, state
  └─ Think<Env, State, Props>      chat lifecycle, turn pipeline, tools, extensions
       └─ YourAgent                getModel(), getTools(), configureContext(), hooks
```

Think extends `Agent` and installs two Lifecycle capabilities in its constructor:

- **Sessions** (`agents/sessions`) stores settled messages as a tree, with compaction overlays and on-demand FTS5 search. See [sessions.md](./sessions.md).
- **Streams** (`createChatStreams()` from `agents/chat`) stores in-flight output. `ResumableStream` from `agents/chat` is layered over it for chunk replay.

It also registers Task definitions on the inherited `this.tasks` capability: `__cf_internal_chat_turn` for chat turns, `__cf_internal_chat_recovery` for recovery continuations, and one for messenger replies. Prompt context blocks come from `agents/context`. The streaming, reconciliation, protocol, and recovery primitives are the shared layer in `agents/chat` — see [chat-shared-layer.md](./chat-shared-layer.md).

Think wraps `onStart` in its constructor, so subclasses override `onStart()` without calling `super.onStart()`. Startup initializes the workspace (unless the subclass assigned one), configures the Session through `configureSession()`, loads context blocks from `configureContext()`, restores extensions, sets up the chat protocol handlers and channels, runs the subclass `onStart`, then reconciles declarative scheduled tasks.

### Entry paths

Every way to start a turn converges on one private inference loop:

| Path                      | Entry                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| Browser WebSocket         | `cf_agent_use_chat_request` frames from `useAgentChat` (`@cloudflare/think/react`)                      |
| Parent agent RPC          | `chat(message, callback, options)` streaming through a `StreamCallback`                                 |
| Programmatic              | `runTurn()`, `saveMessages()`, `submitMessages()`, `continueLastTurn()`; `addMessages()` without a turn |
| Tool results and approval | auto-continuation after `cf_agent_tool_result` / `cf_agent_tool_approval`                               |
| Messengers                | Chat SDK webhooks declared by `getMessengers()` (`@cloudflare/think/messengers`)                        |
| Scheduled tasks           | `getScheduledTasks()` prompt tasks (durable submissions) or deterministic handlers                      |
| Workflows                 | `ThinkWorkflow` `step.prompt()` (`@cloudflare/think/workflows`)                                         |
| Recovery                  | chat-recovery Task continuations after an interrupted turn                                              |

`StreamCallback` is `onStart`, `onEvent`, `onDone`, `onError`, plus optional `onInterrupted` for a turn handed to bounded recovery. `messageConcurrency` (`"queue"` by default; also `"latest"`, `"merge"`, `"drop"`, and debounce) decides how overlapping submits behave. `TurnQueue` from `agents/chat` serializes turns and invalidates queued work when the chat is cleared.

### The turn pipeline

For each model run Think:

1. Optionally waits for MCP connections (`waitForMcpConnections`).
2. Merges tools, later sources overriding earlier ones on name collisions: workspace tools (plus `bash` unless `workspaceBash = false`), `fetchTools`, `getTools()`, compiled `getActions()`, extension tools, context tools, skill tools, MCP tools (when `includeMcpTools`), and client tool schemas.
3. Applies the active channel's tool filter and instructions from `configureChannels()`.
4. Builds the system prompt from the frozen context-block prompt, falling back to `getSystemPrompt()` when no context blocks are configured.
5. Assembles model messages from the Session path, with compaction overlays applied.
6. Calls `beforeTurn(ctx)`, then extension `beforeTurn` hooks. The returned `TurnConfig` can replace the model, system prompt, or messages and add tools.
7. Runs `streamText` with `stopWhen: stepCountIs(maxSteps)` (default 10), threading `beforeStep`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, and `onChunk`.

After the turn, `onChatResponse(result)` fires from every path; `onChatError(error, ctx)` customizes failures, and `classifyChatError` tells recovery which errors are context-window overflows (`contextOverflow`). There is no `onChatMessage` override: a subclass customizes pieces through hooks rather than replacing the loop.

`getModel()` throws until overridden. It may return a `LanguageModel` or a string; `resolveModel()` turns a string into a model through the bundled `workers-ai-provider` over `getAIBinding()` (default `env.AI`), routing `"<provider>/<model>"` slugs through AI Gateway with options from `getGateway()`.

### Streaming and persistence

The `streamText` result is iterated as a UI message stream. Each chunk is applied to a `StreamAccumulator`, stored in the resumable stream, and broadcast to connected clients except those waiting to resume. The RPC path uses its own accumulator and forwards chunks to the `StreamCallback`.

When a turn finishes, Think persists the assistant message and settles and deletes its resumable stream in one SQLite transaction (the cutover), so a crash leaves either the stream (recovery rebuilds the message from it) or the message, never both. The transcript broadcast (`cf_agent_chat_messages`) is sent before the terminal `done` frame, because clients switch to ready on `done` and a later snapshot would overwrite a message the user sent in between ([#2119](https://github.com/cloudflare/agents/issues/2119)).

Writes go through the Sessions pipeline, which sanitizes provider metadata and strips reserved metadata keys. Sessions never truncates: media parts move to content-addressed attachment rows, and a message too large for one row is split across continuation rows. Incoming client messages are reconciled against the server path with `reconcileMessages` before they are written.

`mediaEviction` (on by default) is Think's own context-window policy above storage. Aged media is replaced in the conversation with an `[evicted <mediaType>, <bytes> bytes; preserved at <path>]` marker and the bytes are written to the Workspace under `/attachments/evicted/`. `hydrationByteBudget` (32 MiB) bounds the startup read that fills the in-isolate `messages` projection; the Sessions change feed keeps that projection coherent afterwards.

Regeneration (`trigger: "regenerate-message"`) appends a new assistant message under the same user parent, so earlier responses remain as branches readable with `session.getBranches()`. `continueLastTurn()` creates a new assistant message, except recovery continuations, which stream into the interrupted message.

### Durable execution

Durable chat recovery is always on. Every chat turn runs as a `__cf_internal_chat_turn` Task, and `chatRecovery` accepts `true` (the default) or a tuning object, not `false`. When the object restarts and finds an interrupted turn, the shared `ChatRecoveryEngine` from `agents/chat` classifies it, persists any settled partial, calls `onChatRecovery(ctx)`, and dispatches a retry or continuation as a `__cf_internal_chat_recovery` Task run under an incident budget. Clients see `cf_agent_chat_recovering` while this happens. Facet-hosted Think instances keep a root-owned Scheduler compatibility path until Tasks supports routed child wakes. See [chat-shared-layer.md](./chat-shared-layer.md#recovery-enginets) and [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md).

`submitMessages()` adds durable acceptance with idempotency keys and status inspection; see [think-durable-submissions.md](./think-durable-submissions.md).

### Client tools

The browser sends tool schemas with the chat request. Think converts them with `createToolsFromClientSchemas()` and merges them last. The latest schemas and request body are persisted in `think_config` (`lastClientTools`, `lastBody`) so they survive hibernation and apply to auto-continuations.

Tool results and approvals update the matching tool part through the shared `applyToolUpdate` helpers, persist it, and broadcast `cf_agent_message_updated`. When the client asks to continue, the shared `AutoContinuationController` coalesces results for 50 ms and then runs one continuation turn.

### Wire protocol

Think speaks the same protocol as `AIChatAgent`; the constants are `CHAT_MESSAGE_TYPES` in `agents/chat`.

| Direction       | Message type                     | Purpose                                                       |
| --------------- | -------------------------------- | ------------------------------------------------------------- |
| Client → Server | `cf_agent_use_chat_request`      | Send a chat request (`{ messages, clientTools?, ...body }`)   |
| Client → Server | `cf_agent_chat_clear`            | Clear the conversation                                        |
| Client → Server | `cf_agent_chat_request_cancel`   | Cancel a request by ID                                        |
| Client → Server | `cf_agent_tool_result`           | Client tool result                                            |
| Client → Server | `cf_agent_tool_approval`         | Tool approval or denial                                       |
| Client → Server | `cf_agent_stream_resume_request` | Ask whether a stream can be resumed                           |
| Client → Server | `cf_agent_stream_resume_ack`     | Acknowledge a resumable stream and receive the replay         |
| Server → Client | `cf_agent_use_chat_response`     | Stream chunk (`done: false`) or terminal frame (`done: true`) |
| Server → Client | `cf_agent_chat_messages`         | Full transcript broadcast                                     |
| Server → Client | `cf_agent_chat_clear`            | Conversation cleared                                          |
| Server → Client | `cf_agent_message_updated`       | One message changed (tool result or approval applied)         |
| Server → Client | `cf_agent_stream_resuming`       | An active stream can be resumed                               |
| Server → Client | `cf_agent_stream_pending`        | A turn is accepted but has not started streaming              |
| Server → Client | `cf_agent_stream_resume_none`    | Nothing to resume                                             |
| Server → Client | `cf_agent_chat_recovering`       | A durable turn is being recovered                             |

`useAgentChat` from `@cloudflare/think/react` wraps the shared hook in `agents/chat/react`. It omits `syncMessagesToServer`, because the Session tree is server-authoritative; `setMessages` changes only the local view and `clearHistory()` performs a persisted clear.

### Configuration

`configure()` / `getConfig()` store a JSON-serializable blob under `_think_config` in the Think-private `think_config` table and cache it in memory. Legacy keys from `assistant_config` are lifted into `think_config` on startup. A parent can configure a child over RPC. Values that should reach clients belong in `Agent` state instead; `configure` stays server-side.

### One conversation per instance

A Think instance holds one conversation on the default Sessions handle. Multi-chat products compose Durable Objects: a per-user directory owns the chat list and shared resources (workspace, MCP), and each conversation is its own Think instance. `examples/assistant` implements this with facet children; [rfc-user-chat-durable-objects.md](./rfc-user-chat-durable-objects.md) records the accepted move to top-level chat Durable Objects. The user guide is [`docs/think/multi-chat.md`](../docs/think/multi-chat.md).

## Tools

### Workspace

`this.workspace` is typed `WorkspaceLike`. By default it is a `Workspace` from `@cloudflare/shell` over the object's SQLite; a subclass can assign its own, for example one with R2 spillover or a proxy to a parent-owned workspace. Workspace tools (`read`, `write`, `edit`, `list`, `find`, `grep`, `delete`, and `bash`) are merged into every turn. The factories are exported from `@cloudflare/think/tools/workspace` for custom backends.

### Code execution (`@cloudflare/think/tools/execute`)

`createExecuteTool(this, overrides?)` builds a codemode runtime from the agent (`ctx`, `env.LOADER`, optional `env.BROWSER`) and returns the `execute` tool. The model writes JavaScript that runs in a Dynamic Worker with `tools.*`, `state.*` (the workspace), and `cdp.*` connectors. The runtime is assigned to `this.codemode`, which backs the `approveExecution` / `rejectExecution` / `pendingExecutions` callables for approval-gated sandbox tools. See [think-execute-hitl.md](./think-execute-hitl.md).

### Fetch tools (`@cloudflare/think/tools/fetch`)

Opt-in, read-only HTTP reads. `createFetchTools()` generates a generic `fetch_url` tool (when a public `allowlist` is set) plus one `fetch_<name>` per binding target. The `fetchTools` property wires them in after workspace tools, injecting `this.workspace` for spill and a `tool:fetch` observability event.

Key decisions: named tools so per-target policy is baked in; `GET` only, because mutations belong in approval-gated actions and recovery can replay a turn; SSRF defenses for the public path (private, loopback, link-local, and `*.internal` targets blocked, credentials rejected, IPv4 shorthand normalized); `maxBytes`, `maxModelChars`, and workspace spill as size knobs; allowlist-aware redirects with cross-origin header stripping; results returned as `{ ok, ... }` values rather than thrown.

### Browser tools (`@cloudflare/think/tools/browser`)

Re-exports from `agents/browser`. `createBrowserTools()` provides the durable `browser_execute` tool (CDP through a codemode runtime; needs a Browser Run binding and a Worker Loader) and, by default, the stateless Quick Action tools. `createQuickActionTools()` provides only the Quick Actions (`browser_markdown`, `browser_extract`, `browser_links`, `browser_scrape`, and optionally `browser_content`) and needs only the `browser` binding.

### Sandbox tools (`@cloudflare/think/tools/sandbox`)

`createSandboxTools()` is a placeholder: it logs a warning once and returns no tools.

### Extensions

With `extensionLoader` set, Think creates an `ExtensionManager` (`@cloudflare/think/extensions`):

1. **Loading** wraps extension source in a Worker module with `describe()` / `execute()` RPC and loads it through `WorkerLoader` with permission-gated bindings.
2. **Tool discovery** exposes the described tools as AI SDK tools named `{extensionName}_{toolName}`.
3. **Persistence** stores the manifest and source in Durable Object storage; `restore()` rebuilds them after hibernation.
4. **Permissions** declare `network` hosts and `workspace` access (`read`, `read-write`, or `none`). Workspace access goes through `HostBridgeLoopback`, a `WorkerEntrypoint` that resolves the agent through `ctx.exports`.

`createExtensionTools()` (`@cloudflare/think/tools/extensions`) gives the model `load_extension` and `list_extensions`. `getExtensions()` declares extensions in code, and extensions can contribute lifecycle hooks.

### Other capabilities

These have their own user docs under `docs/think/`:

- **Actions** (`getActions()`, `action()`): tools with an idempotency ledger (`cf_think_action_ledger`), approvals (`cf_think_action_pending_approvals`), and authorization.
- **Channels and messengers**: per-surface policy (`configureChannels()`) and Chat SDK webhook ingress with durable reply delivery.
- **Scheduled tasks**: `getScheduledTasks()` reconciled into `cf_think_scheduled_tasks` on startup.
- **Agent tools**: running Think or `AIChatAgent` children as tools, with run state in `cf_agent_tool_child_runs` and `cf_agent_tool_milestones`. See [agent-tools.md](./agent-tools.md).
- **Skills**: `getSkills()` and `getSkillScriptRunner()` over `agents/skills`. See [skills.md](./skills.md).

### Reply attachments (`ctx.attachReply`)

Actions can record advisory delivery metadata for the current reply with `ctx.attachReply(attachment)`. The attachment never changes the model-visible tool output, and surfaces that do not understand a type ignore it. Think JSON-normalizes attachments on record, caps how many one turn can record, deep-copies snapshots on read, and exposes the producing attempt's attachments through `onChatResponse(result).attachments` and `replyAttachments(requestId?)`. Policy callbacks receive a no-op recorder, and attachments from an `execute` that later fails are discarded. `durable-pause` approved actions do not carry attachments across the continuation turn. Rendering belongs to channels and voice.

## SQLite tables

| Table                                                     | Owner             | Purpose                                                     |
| --------------------------------------------------------- | ----------------- | ----------------------------------------------------------- |
| `cf_agents_session_messages` / `_message_chunks`          | Sessions          | Message tree and continuation rows for large messages       |
| `cf_agents_session_compactions`                           | Sessions          | Compaction overlays                                         |
| `cf_agents_session_attachment_meta` / `_chunks` / `_refs` | Sessions          | Content-addressed media payloads and their references       |
| `cf_agents_session_fts`                                   | Sessions          | FTS5 index, created on first `search()`                     |
| `cf_agents_context_blocks`                                | Context           | Context blocks and the frozen system prompt                 |
| `cf_agents_streams` / `cf_agents_stream_blocks`           | Streams           | Resumable in-flight output                                  |
| `cf_agents_task_runs` / `cf_agents_task_steps`            | Tasks (inherited) | Chat-turn, recovery, and messenger-reply runs               |
| `think_config`                                            | Think             | `configure()` blob, client tools, request body, skill state |
| `cf_think_submissions`                                    | Think             | Durable submissions                                         |
| `cf_think_scheduled_tasks`                                | Think             | Declarative scheduled task state                            |
| `cf_think_action_ledger` / `_pending_approvals`           | Think             | Action idempotency and approvals                            |
| `cf_agent_tool_child_runs` / `cf_agent_tool_milestones`   | Think             | Agent-tool runs                                             |

## Current distinctions from AIChatAgent

Think and `AIChatAgent` share Sessions, Streams, reconciliation, concurrency strategies, durable recovery, programmatic turns, and the client protocol and hook. The remaining differences are intentional:

- Think owns model selection, the tool loop, context assembly, and compaction. `AIChatAgent` exposes `onChatMessage() → Response` and leaves the model call to the subclass.
- Think treats regeneration as a new branch. `AIChatAgent` keeps destructive regeneration and `maxPersistedMessages`.
- `AIChatAgent` converts legacy message shapes (`autoTransformMessages`) and accepts client transcript sync. Think expects current UI messages and is server-authoritative.
- Think adds workspace tools, extensions, actions, channels, messengers, submissions, scheduled tasks, workflows, and `chat()` RPC.

See [think-vs-aichat.md](./think-vs-aichat.md).

## Key decisions

### A base class instead of a mixin

The message store, streaming protocol, persistence pipeline, recovery, and error handling are intertwined. A mixin would have to compose with others that also wrap `onMessage`, `onStart`, and storage. A base class makes the lifecycle explicit.

### Hooks instead of an `onChatMessage` override

Every entry path funnels through one pipeline, so a hook fires the same way for WebSocket, RPC, programmatic, messenger, and recovery turns. Replacing the whole loop would bypass tool merging, recovery, and persistence rules that the other paths depend on.

### Shared primitives from `agents/chat`

`StreamAccumulator`, `ResumableStream`, `TurnQueue`, reconciliation, and the recovery engine are shared with `AIChatAgent` so fixes land once. See [chat-shared-layer.md](./chat-shared-layer.md).

### Idempotent message IDs

Sessions treats an append of an existing ID as a no-op and exposes an explicit update. Retries and reconnects can repeat an append safely, while assistant updates stay deliberate.

### A live message projection

Think keeps an in-isolate message array for its model and client paths. The Sessions change feed patches it after durable writes; SQLite remains authoritative across eviction.

### The loopback pattern for extensions

Extension Workers loaded through `WorkerLoader` can only receive `Fetcher` / `ServiceStub` bindings, not `RpcStub`. `HostBridgeLoopback` carries serializable props and resolves the agent at call time. See [loopback.md](./loopback.md).

## Tradeoffs

**Think is opinionated.** It assumes AI SDK UI messages, `streamText`, and the `cf_agent_chat_*` protocol. Agents that need a different message format or loop should use `AIChatAgent` or `Agent` directly.

**Some host paths still materialize arrays.** Startup hydration is byte-budgeted, but reconciliation, client transcript snapshots, and model assembly still use arrays. [sessions.md](./sessions.md) records which paths could move to streamed reads.

**Reconciliation is host-owned.** Client-generated IDs and tool states are wire-protocol concerns, so Think reconciles before writing to Sessions rather than inside storage.

**Extension network permission is all-or-nothing.** `permissions.network` declares hosts, but enforcement is binary: no network or full network.

## Testing

Tests live in `packages/think/src/`:

- `tests/` — Workers-runtime tests through `@cloudflare/vitest-pool-workers`, covering the turn loop, WebSocket protocol, client tools, recovery and eviction, submissions, actions, channels, messengers, scheduled tasks, extensions, tools, and workflows.
- `e2e-tests/` — process-level recovery tests against `wrangler dev` (chat, submission, workflow, messenger, stall, and action recovery).
- `react-tests/` — `useAgentChat` stream resume.
- `tests-d/` and `*.test-d.ts` — type tests.

## Package exports

| Import path                             | Purpose                                                    |
| --------------------------------------- | ---------------------------------------------------------- |
| `@cloudflare/think`                     | `Think`, `Session`, `Workspace`, `action`, `skills`, types |
| `@cloudflare/think/react`               | `useAgentChat` and tool part helpers                       |
| `@cloudflare/think/extensions`          | `ExtensionManager`, `HostBridgeLoopback`                   |
| `@cloudflare/think/workflows`           | `ThinkWorkflow`                                            |
| `@cloudflare/think/messengers`          | Messenger helpers and `ThinkMessengerStateAgent`           |
| `@cloudflare/think/messengers/telegram` | Telegram messenger                                         |
| `@cloudflare/think/tools/workspace`     | Workspace tool factories                                   |
| `@cloudflare/think/tools/execute`       | `createExecuteTool`, `createExecuteRuntime`                |
| `@cloudflare/think/tools/fetch`         | `createFetchTools`                                         |
| `@cloudflare/think/tools/browser`       | `createBrowserTools`, `createQuickActionTools`             |
| `@cloudflare/think/tools/extensions`    | `createExtensionTools`                                     |
| `@cloudflare/think/tools/sandbox`       | `createSandboxTools` (placeholder)                         |

## Inspiration

Think's design — skills, extensions, tree-structured sessions, compaction, and context engineering — was inspired by [pi](https://pi.dev), a minimal terminal coding agent by Mario Zechner / Earendil Inc.

## History

- [think-roadmap.md](./think-roadmap.md) — the original five-phase implementation plan (historical)
- [chat-shared-layer.md](./chat-shared-layer.md) — primitives Think shares with `AIChatAgent`
- [sessions.md](./sessions.md) and [rfc-sessions.md](./rfc-sessions.md) — Sessions as a Lifecycle capability
- [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md) — shared recovery engine
- [rfc-think-multi-session.md](./rfc-think-multi-session.md) (rejected) and [rfc-user-chat-durable-objects.md](./rfc-user-chat-durable-objects.md) (accepted) — multi-chat topology
- [loopback.md](./loopback.md) — extension host bridge
- [workspace.md](./workspace.md) — the Workspace behind Think's file tools
