# Think — Coding Agent

Experimental exploration of building a coding agent entirely on Workers, Durable Objects, and the Agents SDK. The goal is a durable, multi-thread personal assistant that can read and write files, run shell commands, and reason through complex tasks — all without leaving the Workers runtime.

## Architecture

```
ThinkAgent (Agent — session orchestrator)
  ├── threads table   (own SQLite)
  ├── workspaces table
  ├── WebSocket transport to browser
  │
  ├── Chat facet "thread-abc" (AgentFacet — isolated SQLite)
  │     ├── Message persistence + incremental diffing
  │     ├── AgentLoop (multi-step LLM execution + streaming)
  │     └── Tool state tracking
  │
  ├── Chat facet "thread-def" (independent conversation)
  │
  └── Workspace facet "ws-xyz" (AgentFacet — isolated SQLite + R2)
        ├── Virtual filesystem (files, directories, metadata)
        ├── Hybrid storage: inline SQLite < 1.5 MB, R2 overflow ≥ 1.5 MB
        └── Bash execution via just-bash
```

### Layers

**AgentFacet** (`src/agent-facet.ts`) — base class for all facets. Extends `DurableObject` with:

- `this.sql` tagged template (same API as `Agent`)
- Full scheduling: delayed, Date, cron, interval — with overlap detection and hung-schedule timeout
- Abort controller lifecycle, `this.retry()` with jittered exponential backoff
- `onError()` hook, `onStart()` lifecycle, `destroyed` flag

**Chat** (`src/chat.ts`) — extends `AgentFacet`. One conversation thread:

- Message CRUD + batch `persistMessages()` with incremental diffing
- Row size limits (1.8 MB cap, generic truncation of largest strings)
- `maxPersistedMessages` with oldest-first eviction
- OpenAI message sanitization (strips `itemId`, empty reasoning parts, provider metadata)
- Three execution modes: `runStep()` (single call), `run()` (multi-step non-streaming), `streamInto()` (multi-step streaming — the primary interactive path)

**AgentLoop** (`src/agent-loop.ts`) — standalone class, no DO/transport dependencies:

- `step()` — single LLM call, no tool loop
- `run()` — multi-step loop via `generateText + stopWhen`
- `stream()` — multi-step loop via `streamText + stopWhen`, emits NDJSON
- `prepareStep` context trimming: tool results capped at 8k chars, message window capped at 40 messages (keeps first + 25 most recent)
- Stops when the model generates text, calls `done`, or hits `maxSteps`

**ThinkAgent** (`src/server.ts`) — extends `Agent`. The session orchestrator:

- Thread and workspace registries in its own SQLite
- Routes agent runs to per-thread `Chat` facets; pipes streaming NDJSON to connected clients
- Workspace attach/detach: a workspace can move between threads
- All public methods are RPC-callable — a parent gadget can drive it without WebSockets

**Workspace** (`src/workspace.ts`) — extends `AgentFacet`. A durable, attachable filesystem:

- Virtual filesystem: files, directories, metadata — all in SQLite
- Hybrid storage: files < 1.5 MB stored inline; files ≥ 1.5 MB stored in R2 (avoids SQLite row limit)
- `bash()` via `just-bash` — full bash in the Workers runtime, bridged to the virtual filesystem
- Shareable: one workspace can be attached to multiple threads, or detached and reattached later

### Streaming pipeline

```
Chat.streamInto(writable)
  └── AgentLoop.stream(messages)         runs streamText + stopWhen
        └── fullStream events
              ├── text-delta    → {"t":"text","d":"..."}   \
              ├── reasoning-delta → {"t":"think","d":"..."} } NDJSON
              └── tool-call     → {"t":"tool","n":"..."}   /
                                                            ↓
ThinkAgent.onMessage(RUN)               reads the TransformStream
  └── parses NDJSON
        ├── STREAM_DELTA    → broadcast to all clients
        ├── REASONING_DELTA → broadcast
        └── TOOL_CALL       → broadcast (shows live tool badge in UI)
```

The `Chat` facet writes into a `WritableStream<Uint8Array>` owned by `ThinkAgent` (not the other way around). This keeps the Workers RPC connection alive for the full duration — returning a `ReadableStream` across RPC causes premature disconnection.

### Tools

`buildFileTools(workspace)` (`src/tools.ts`) returns the default tool set:

| Tool         | Description                                            |
| ------------ | ------------------------------------------------------ |
| `readFile`   | Read a file from the workspace                         |
| `writeFile`  | Write (or create) a file                               |
| `deleteFile` | Delete a single file                                   |
| `fileExists` | Check whether a path exists                            |
| `stat`       | Get file/directory metadata                            |
| `listFiles`  | List directory contents (paginated)                    |
| `mkdir`      | Create a directory                                     |
| `rm`         | Remove file or directory tree                          |
| `bash`       | Run a bash command in the workspace filesystem         |
| `done`       | Signal task completion with a summary (stops the loop) |

The `done` tool has no `execute` — calling it terminates the agent loop. The model provides a `summary` string that becomes the persisted assistant message.

### WebSocket protocol

| Direction | Message                                                      | Meaning                              |
| --------- | ------------------------------------------------------------ | ------------------------------------ |
| S → C     | `THREADS`                                                    | Full thread list                     |
| S → C     | `WORKSPACES`                                                 | Full workspace list                  |
| S → C     | `SYNC`                                                       | Messages for a thread                |
| S → C     | `CLEAR`                                                      | Thread was cleared                   |
| S → C     | `STREAM_DELTA`                                               | Text token during streaming          |
| S → C     | `REASONING_DELTA`                                            | Reasoning/thinking token             |
| S → C     | `TOOL_CALL`                                                  | Agent invoked a tool (live progress) |
| S → C     | `STREAM_END`                                                 | Streaming complete                   |
| C → S     | `ADD` / `DELETE` / `CLEAR_REQUEST`                           | Message operations                   |
| C → S     | `CREATE_THREAD` / `DELETE_THREAD` / `RENAME_THREAD`          | Thread management                    |
| C → S     | `CREATE_WORKSPACE` / `DELETE_WORKSPACE` / `RENAME_WORKSPACE` | Workspace management                 |
| C → S     | `ATTACH_WORKSPACE` / `DETACH_WORKSPACE`                      | Attach workspace to thread           |
| C → S     | `GET_MESSAGES`                                               | Request messages for a thread        |
| C → S     | `RUN`                                                        | Trigger the agent loop on a thread   |

URL routing: `/#threadId` maps to the active thread — survives refresh, supports back/forward.

### Why facets

Facets (`ctx.facets`, experimental) give each thread and workspace its own SQLite, co-located with the parent DO:

- Thread and workspace isolation is structural, not by-convention
- The parent controls lifecycle (create, delete) and capability grants
- Each facet inherits scheduling, SQL, retry from `AgentFacet`
- Works locally with the `"experimental"` compatibility flag

### Storage strategy

| Data                        | Where                                                    |
| --------------------------- | -------------------------------------------------------- |
| Thread / workspace registry | `ThinkAgent` SQLite                                      |
| Messages                    | `Chat` facet SQLite                                      |
| Schedule state              | `AgentFacet` SQLite                                      |
| Workspace entries < 1.5 MB  | `Workspace` facet SQLite (inline)                        |
| Workspace entries ≥ 1.5 MB  | R2 bucket (`WORKSPACE_FILES`), key `{workspaceId}{path}` |

R2/SQLite write ordering: R2 `put` first; if the subsequent SQL update fails, the R2 object is cleaned up so no orphans are left.

## Files

```
src/
  agent-facet.ts   AgentFacet — base class (sql, scheduling, abort, retry)
  agent-loop.ts    AgentLoop  — multi-step LLM execution + streaming
  chat.ts          Chat       — conversation facet (messages, streaming, persistence)
  server.ts        ThinkAgent — orchestrator (threads, workspaces, WebSocket)
  shared.ts        Types and WebSocket protocol
  tools.ts         Default tool set (filesystem + bash + done)
  workspace.ts     Workspace  — virtual filesystem facet (SQLite + R2 + just-bash)
  client.tsx       React UI   — thread sidebar, workspace panel, streaming UI
  index.tsx        React entry point
  styles.css       Tailwind + Kumo + Streamdown theme

tests/
  agent-facet.test.ts  AgentFacet via DO stub (sql, scheduling, destroy)
  core.test.ts         Chat via DO stub (CRUD, batch, streaming, resilience)
  workspace.test.ts    Workspace via DO stub (filesystem, R2 hybrid, bash, pagination)
  sync.test.ts         ThinkAgent via WebSocket + RPC (threads, workspaces, streaming)

e2e/
  sync.spec.ts         Full-stack Playwright tests (Wrangler dev)
```

## Run

```bash
npm install
npm run dev
```

## Test

```bash
npm run test:workers   # vitest-pool-workers (all unit/integration tests)
npm run test:e2e       # Playwright end-to-end (requires wrangler dev)
```

## Design influences

- **PI / OpenClaw** — layered agent framework (pi-agent-core → pi-coding-agent). Same separation of concerns: LLM provider → agent loop → session/tools. Key ideas: step-at-a-time loop, composable tools, `steer` vs `followUp` (interrupt vs queue), extensions as lifecycle hooks.
- **@cloudflare/ai-chat** — message persistence patterns (incremental diffing, row size limits, OpenAI sanitization, tool state tracking). Adapted for facet isolation rather than single-DO-does-everything.
- **Gadgets experiments** — facet architecture, parent-child RPC, structural capability control, workspace-as-shareable-attachment.
