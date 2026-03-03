# Coding Agent

A general-purpose coding agent built on the Agents SDK. Code is the universal medium of action — the same primitives that edit files and run scripts can manage calendars, negotiate purchases, analyze data, and automate workflows. This document describes what we're building and how we'll get there.

## The idea

Coding agents like pi, OpenCode, Claude Code, and Codex prove that an LLM with file I/O, code execution, and persistent memory is a general-purpose machine. OpenClaw (100k+ GitHub stars) proved the demand — people want AI agents that "actually do things."

These tools all run locally on a machine. That works, but it means:

- One user per machine (or expensive VPS per user)
- Always-on hardware ($hundreds/month)
- No hibernation — paying for idle
- Local-only state, no sharing or collaboration
- Manual setup, updates, dependency management

The Agents SDK already has every primitive needed to build this as a platform:

| Primitive              | What it provides                                       |
| ---------------------- | ------------------------------------------------------ |
| Durable Objects        | Per-agent isolation, globally distributed              |
| Hibernation            | $0 when idle, wakes on message or alarm                |
| DO SQLite              | Persistent state, queryable, transactional             |
| Workspace              | Durable filesystem (SQLite + R2) with change events    |
| Dynamic Worker Loaders | Sandboxed code execution, ms startup, arbitrary JS     |
| Codemode               | LLM writes code that calls tools via RPC               |
| workers-builder        | Runtime npm dependency resolution + esbuild bundling   |
| Browser Rendering      | Headless browser for web automation                    |
| Containers/Sandboxes   | Real OS for heavy tools (git, compilers, test runners) |
| DO Alarms              | Scheduled/proactive execution (heartbeat)              |
| WebSockets             | Real-time streaming to any client                      |
| MCP                    | External tool integration                              |
| Callable methods       | Agent-to-agent RPC                                     |

We're not building "OpenClaw on Workers." We're building the framework that makes it trivial for anyone to build their own coding agent — personalized, persistent, hibernatable, globally distributed — without buying hardware.

## Architecture

```
┌──────────────────── CodingAgent (Durable Object) ───────────────────┐
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────────┐  │
│  │  Workspace   │  │   Memory     │  │    Session Manager         │  │
│  │  (files,     │  │  (SQLite,    │  │  (conversation trees,      │  │
│  │   R2 spill)  │  │  embeddings) │  │   branching, compaction)   │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬───────────────┘  │
│         │                 │                        │                  │
│  ┌──────┴─────────────────┴────────────────────────┴──────────────┐  │
│  │                       Agentic Loop                             │  │
│  │  1. Context assembly (system prompt + memory + skills + history)│  │
│  │  2. Model inference (Workers AI / OpenAI / Anthropic / etc.)   │  │
│  │  3. Tool execution or text reply                               │  │
│  │  4. Persist results, repeat until done                         │  │
│  └──────────────────────────┬─────────────────────────────────────┘  │
│                              │                                       │
│  ┌───────────────────────────┴────────────────────────────────────┐  │
│  │                         Tools                                  │  │
│  │                                                                │  │
│  │  Built-in (Workspace-backed):                                  │  │
│  │    read, write, edit, list, find, grep, diff                   │  │
│  │                                                                │  │
│  │  Code execution:                                               │  │
│  │    Dynamic Isolate + workers-builder (sandboxed JS with deps)  │  │
│  │                                                                │  │
│  │  Browser:                                                      │  │
│  │    Cloudflare Browser Rendering (navigate, extract, automate)  │  │
│  │                                                                │  │
│  │  Heavy compute (when needed):                                  │  │
│  │    Cloudflare Containers (git, npm, compilers, test runners)   │  │
│  │                                                                │  │
│  │  Extensions (Dynamic Worker Loaders):                          │  │
│  │    Sandboxed Workers with npm deps, loaded on demand           │  │
│  │                                                                │  │
│  │  MCP:                                                          │  │
│  │    External tool servers                                       │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────────────┐   │
│  │  Alarms     │  │  Schedule   │  │  Skills (on-demand Markdown) │   │
│  │ (heartbeat) │  │  (cron)     │  │  loaded when relevant        │   │
│  └────────────┘  └────────────┘  └──────────────────────────────┘   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                WebSocket + HTTP handlers                       │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
        ↑ WS              ↑ HTTP              ↑ Webhook
   ┌────┴────┐      ┌─────┴─────┐       ┌────┴────────┐
   │ Web UI  │      │ Telegram  │       │ Slack/Email  │
   │         │      │ WhatsApp  │       │ Discord/etc  │
   └─────────┘      └───────────┘       └──────────────┘
```

## Execution tiers

Not every task needs the same level of capability. The agent should escalate to heavier execution tiers only when needed.

### Tier 0 — Workspace only (no isolate)

File I/O, listing, glob, diff. Pure Workspace operations, no code execution. Used for reading, writing, and editing files directly via tools.

### Tier 1 — Dynamic Isolate (sandboxed JS)

LLM-generated JavaScript runs in a Dynamic Worker Loader isolate. Tool calls RPC back to the host. Network blocked by default. Used for data transformation, analysis, multi-step file operations, regex search. Codemode already implements this.

### Tier 2 — Dynamic Isolate + workers-builder (JS with npm deps)

Same as Tier 1, but the code can import npm packages. workers-builder fetches from registry and bundles with esbuild at runtime. Used for tasks that need libraries: parsing (cheerio), validation (zod), git (isomorphic-git), templating, etc.

### Tier 3 — Browser Rendering

Cloudflare Browser Rendering provides a headless Chromium instance. Used for web scraping, form filling, screenshot capture, data extraction. The agent gets a `browser` tool that navigates, clicks, extracts.

### Tier 4 — Container/Sandbox

A real OS environment for heavy tools. Used when the agent needs git (real), npm/yarn, compilers (tsc, cargo, go), test runners (vitest, jest, pytest), linters, or any native binary. The container syncs with the Workspace — files edited in the Workspace are available in the container, and vice versa.

The agent should be usable and useful at Tier 0-2 alone. Tiers 3-4 are additive capabilities that unlock more use cases but aren't required for the core experience.

## Key ideas from prior art

### From pi (coding agent)

- **Operations interfaces**: Every tool has a clean abstraction (ReadOperations, WriteOperations, EditOperations, BashOperations, GrepOperations, FindOperations, LsOperations). The same tool works against different backends. We implement these against Workspace.
- **Edit tool with fuzzy matching**: BOM handling, line ending normalization, exact match with fuzzy fallback. Production-quality text editing. Port this — it's pure string logic.
- **Session trees**: Append-only conversation trees with branching and compaction. Elegant model for exploring alternatives without losing history.
- **Context assembly**: Layered system prompt — base instructions + tool descriptions + project context files + skills + runtime info. The quality of context assembly directly determines agent quality.
- **Output truncation**: truncateHead, truncateTail, truncateLine. Prevents context window blowup from large tool outputs. Essential.
- **Streaming tool output**: onUpdate callback during long operations for real-time UX.
- **Compaction with summarization**: When context overflows, summarize older messages rather than truncating them. Preserves semantic content.

### From OpenClaw (general-purpose agent)

- **Skills as Markdown files loaded on demand**: The agent sees a compact list of available skills (name + description). Only loads the full skill text when it decides it's relevant. Keeps base prompt lean regardless of how many skills exist.
- **Memory as simple documents**: MEMORY.md for long-term facts, daily logs for ephemeral context, SOUL.md for personality. Stored as plain text, editable by both the agent and the user.
- **Heartbeat**: Periodic alarm wakes the agent to check a task list and act proactively. Not just reactive — the agent can monitor, remind, and follow up.
- **Self-improving**: The agent can write its own skills. This is even more powerful with Dynamic Worker Loaders — the agent can write TypeScript extensions with real npm deps and load them.
- **Channel adapters**: Normalize input from different sources (web, chat apps, email) into a consistent format before it reaches the agent.

### From Codemode (already in this repo)

- **Code-first tool calling**: LLMs write code that calls tools, rather than making individual tool calls. Reduces round-trips, enables branching logic, leverages LLMs' strength at code generation.
- **Executor interface**: Abstract — implement for Workers, Node VM, QuickJS, containers. We extend this pattern.
- **ToolDispatcher RPC**: Tool calls from sandboxed code route back to the host via Workers RPC. Clean, secure, extensible.
- **AST normalization**: Acorn-based code normalization handles various LLM output formats.

## Progress

### Phase 1 — Built-in tools on Workspace ✅

**Status**: Complete.

**What was built**:

- `packages/agents/src/experimental/assistant/` — library code
  - `tools/types.ts` — Operations interfaces (`ReadOperations`, `WriteOperations`, `EditOperations`, `ListOperations`, `FindOperations`, `GrepOperations`) + factory functions wiring to Workspace
  - `tools/read.ts` — Read with line numbers, offset/limit, truncation
  - `tools/write.ts` — Write with auto-mkdir for parents
  - `tools/edit.ts` — Exact match + fuzzy whitespace fallback, multi-match detection, new file creation
  - `tools/list.ts` — List with pagination
  - `tools/find.ts` — Find via Workspace `glob()`
  - `tools/grep.ts` — Regex/fixed string search with case sensitivity, context lines
  - `tools/index.ts` — `createWorkspaceTools(workspace)` returns all 6 tools as AI SDK tools
  - `index.ts` — Public entry point
- Export wired: `agents/experimental/assistant` in `package.json` + `scripts/build.ts`
- Tests: 18/18 passing in `src/tests/assistant-tools.test.ts` (Workers runtime via vitest-pool-workers)
- Example: `examples/assistant/` — full Vite example with Kumo UI, streams tool calls

**Not yet built** (deferred to later phases):

- `diff` tool (planned, Workspace has `diff()` — straightforward to add)
- Image detection in `read` tool (needs multimodal plumbing)

**Additionally built** (not in original plan):

- `tools/delete.ts` — Delete file tool, wired into `createWorkspaceTools()`

---

### Phase 2 — Session management ✅

**Status**: Complete.

**What was built**:

- `packages/agents/src/experimental/assistant/session/` — library code
  - `truncation.ts` — Output truncation utilities: `truncateHead`, `truncateTail`, `truncateLines`, `truncateMiddle`, `truncateToolOutput`
  - `storage.ts` — SQLite schema and CRUD for sessions, messages (tree-structured with `parent_id`), and compactions
  - `index.ts` — `SessionManager` class: create/list/rename/delete sessions, append messages, get history (follows branch paths), branch exploration, fork sessions, compaction records
- All exports wired through `agents/experimental/assistant`
- Tests: 22/22 passing in `src/tests/assistant-session.test.ts` (Workers runtime)
  - Truncation utilities (9 tests)
  - Session lifecycle: create, list, rename, delete (4 tests)
  - Messages: append, appendAll, count, history retrieval (3 tests)
  - Branching: branch creation, branch listing, fork (3 tests)
  - Compaction: summary replacement in history, needsCompaction check, compaction listing (3 tests)

**Key design decisions**:

- `SessionManager` is a standalone class any Agent can instantiate (like Workspace)
- Works with AI SDK's `UIMessage` type for compatibility with `AIChatAgent`
- Tree structure via `parent_id` — branches are different paths through the tree
- `getHistory()` walks from leaf to root, applying compactions as needed
- Compaction is manual (caller provides summary) — LLM-based auto-compaction left to the consumer

---

### Phase 3 — Agentic loop ✅

**Status**: Complete.

**What was built**:

- `packages/agents/src/experimental/assistant/agent.ts` — `AssistantAgent` base class
  - Extends `Agent` (Durable Object), wire-compatible with `@cloudflare/ai-chat` WebSocket protocol
  - Override points: `getModel()`, `getSystemPrompt()`, `getTools()`, `getMaxSteps()`, `assembleContext()`, `onChatMessage()`
  - Context assembly: `convertToModelMessages` + `pruneMessages` (strips old tool calls/reasoning)
  - Inference: AI SDK `streamText` with configurable model, system prompt, tools
  - Tool execution loop: multi-step via `stopWhen: stepCountIs(maxSteps)`
  - Cancellation: AbortSignal per request, client can cancel in-flight streams
  - Streaming: Full SSE stream parsing, broadcasts chunks to all connected WebSocket clients
  - Persistence: Messages persisted to `SessionManager` after each turn (append user messages, stream + persist assistant message)
  - Session recovery: `_recoverSession()` in constructor restores current session from SQLite after hibernation
- `packages/agents/src/experimental/assistant/message-builder.ts` — Builds `UIMessage` parts from AI SDK stream chunks (text, tool calls, reasoning traces)
- Example: `examples/assistant/` — full Vite app with Kumo UI, session sidebar, streaming tool output, reasoning trace rendering
- All exports wired through `agents/experimental/assistant`

**Key design decisions**:

- Named `AssistantAgent` (not `CodingAgent`) — it's the generic agentic loop, not tied to coding
- `SessionManager` is the sole persistence layer (no dual persistence with `this.setState`)
- Server is authoritative — no client-side message reconciliation
- `onChatMessage` returns a `Response` (the SSE stream) — the base class handles reading it, broadcasting, and persisting
- `keepAliveWhile` wraps stream reading to prevent hibernation during active inference

---

### Phase 5 — Code execution (Codemode integration) ✅

**Status**: Complete (core items). workers-builder integration and automatic tier escalation deferred.

**What was built**:

- `packages/agents/src/experimental/assistant/tools/execute.ts` — `createExecuteTool()` factory
  - Wraps `@cloudflare/codemode`'s `createCodeTool` + `DynamicWorkerExecutor`
  - Accepts `loader` (WorkerLoader binding) or custom `Executor`
  - Configurable timeout, network access (`globalOutbound`)
  - Workspace tools exposed as `codemode.*` RPC in the sandbox
  - Custom description support with `{{types}}` placeholder for auto-generated type defs
- Wired into example: `examples/assistant/src/server.ts` uses `createExecuteTool({ tools: workspaceTools, loader: this.env.LOADER })`
- Export: `createExecuteTool` and `CreateExecuteToolOptions` from `agents/experimental/assistant`

**Not yet built**:

- workers-builder integration (npm dep resolution at runtime)
- Automatic tier escalation (agent decides which execution tier)

---

### Phase 7 — Extensions via Dynamic Worker Loaders ✅

**Status**: Complete (core items). Skills within extensions and npm dep bundling deferred.

**What was built**:

- `packages/agents/src/experimental/assistant/extensions/` — Extension system
  - `types.ts` — `ExtensionManifest`, `ExtensionPermissions`, `ExtensionToolDescriptor`, `ExtensionInfo`
  - `manager.ts` — `ExtensionManager` class: load, unload, list, getTools, restore from storage
    - Persistence: manifests + source persisted to DO storage, restored after hibernation via `restore()`
    - Liveness guard: tools throw if extension was unloaded mid-turn (prevents stale closure execution)
    - Name sanitization: non-alphanumeric chars replaced with underscores in tool prefixes
  - `host-bridge.ts` — `HostBridge` RpcTarget for extension-to-host callbacks (workspace read/write, permission-gated)
- `packages/agents/src/experimental/assistant/tools/extensions.ts` — LLM tools: `load_extension`, `list_extensions`
  - Unloading is client-only (via `@callable` RPC), not an LLM tool — prevents same-turn conflicts
- Tests: 23/23 passing in `src/tests/extension-manager.test.ts`
  - Load/discover, unload, list, getTools, tool execution, network isolation, persistence/restore, name sanitization, liveness guard
- Example: extensions wired into `examples/assistant/` with sidebar UI for viewing/unloading extensions

**Key design decisions**:

- Extensions are raw JS object expressions (not full modules with npm deps) — keeps loading fast and simple
- LLM self-authors extensions via `load_extension` tool — writes the JS source inline
- Unloading is a user/client action, not an LLM action — avoids same-turn tool invalidation
- Persistence uses DO storage (not SQLite) — manifest + source per extension, keyed by `ext:<name>`
- `restore()` is called explicitly before each turn and before `listExtensions` RPC — idempotent, rebuilds Workers from persisted source

**Not yet built**:

- workers-builder bundling for extensions with npm deps
- Skills within extensions (Markdown skill files loaded with extension)
- Extension registry / marketplace

---

## Plan

### Phase 1 — Built-in tools on Workspace ✅

**Goal**: A set of tools that give an LLM full read/write/search access to a Workspace filesystem. These are the foundation everything else builds on.

**What to build**:

1. **Tool interfaces**: Define Operations interfaces for each tool, inspired by pi's pattern. Default implementations target Workspace.

   ```ts
   // Example: ReadOperations backed by Workspace
   interface ReadOperations {
     readFile(path: string): Promise<string | null>;
     access(path: string): Promise<boolean>;
     stat(path: string): Promise<FileStat | null>;
   }
   ```

2. **`read` tool**: Read file contents with line number display, offset/limit for large files, image detection and base64 encoding for multimodal. Uses `workspace.readFile()`.

3. **`write` tool**: Write content to a file, creating parent directories as needed. Uses `workspace.writeFile()` and `workspace.mkdir()`.

4. **`edit` tool**: Find-and-replace within a file. Port pi's edit logic — exact match with fuzzy fallback, BOM handling, line ending normalization, multi-edit support. Uses `workspace.readFile()` + `workspace.writeFile()`.

5. **`list` tool**: List directory contents with file sizes and types. Uses `workspace.list()`.

6. **`find` tool**: Find files by glob pattern. Uses `workspace.glob()`.

7. **`grep` tool**: Search file contents by regex. Implemented in JS — iterate files from `workspace.glob()`, read each with `workspace.readFile()`, match with RegExp. Include context lines, respect case sensitivity, support include/exclude globs.

8. **`diff` tool**: Show differences between file versions. Uses `workspace.diff()`.

**Output**: An `agents/tools` export that provides `createWorkspaceTools(workspace)` returning AI SDK compatible tools.

**Why first**: Every subsequent phase depends on having tools. The agent can't do anything useful without file I/O and search. These tools are also useful independently of the agentic loop — any Agent subclass can use them with `streamText`/`generateText`.

### Phase 2 — Session management ✅

**Goal**: Persistent conversation state that survives hibernation, supports branching, and handles context overflow gracefully.

**What to build**:

1. **Session storage in DO SQLite**: Schema for messages, sessions, branches, compaction records. Append-only — messages are never mutated, only appended.

   ```sql
   -- Core tables
   sessions (id, name, created_at, updated_at)
   messages (id, session_id, parent_id, role, content, created_at)
   compactions (id, session_id, summary, from_message_id, to_message_id)
   ```

2. **Session manager class**: Create, load, switch, branch, and fork sessions. Provides the message history for context assembly. Handles the tree structure — each message has a parent, branches are just different paths through the tree.

3. **Compaction**: When the conversation approaches the context limit, summarize older messages using the LLM. Store the summary as a compaction record. On next context assembly, use the summary instead of the original messages. Configurable threshold and strategy.

4. **Output truncation utilities**: Port pi's truncation logic — truncateHead (keep end), truncateTail (keep start), truncateLine (limit line count). Apply to tool outputs before they enter the conversation.

**Output**: A `SessionManager` class that any Agent can instantiate. Stores everything in DO SQLite. Provides `getHistory()`, `append()`, `branch()`, `compact()`.

**Why second**: The agentic loop (Phase 3) needs to persist messages and manage context. Building session management before the loop means the loop is correct from day one — no "add persistence later" retrofit.

### Phase 3 — Agentic loop ✅

**Goal**: The core reason-act-observe cycle that makes an Agent actually agentic. Context assembly, model inference, tool execution, streaming, persistence.

**What to build**:

1. **Context assembly**: Build the prompt from layers:
   - Base system instructions (configurable per agent)
   - Tool descriptions (auto-generated from registered tools)
   - Project context files (loaded from Workspace — e.g., AGENTS.md, README.md)
   - Active skills (compact list of name + description, loaded on demand)
   - Memory (relevant facts from the memory system, Phase 5)
   - Conversation history (from SessionManager, compacted if needed)
   - Runtime info (current time, workspace path, model info)

2. **Inference**: Call the configured model with the assembled context. Support streaming. Handle context overflow by triggering compaction and retrying. Support multiple providers via AI SDK.

3. **Tool execution loop**: When the model returns tool calls, execute them, capture results (with truncation), append to conversation, and loop. When the model returns text, stream it to the client and persist it.

4. **Step limit**: Configurable maximum number of tool-call steps per turn. Prevents runaway loops.

5. **Cancellation**: Support aborting a running turn via AbortSignal. Clean up any in-progress tool executions.

6. **Streaming**: Stream partial text responses over WebSocket as they arrive. Stream tool execution progress (e.g., which tool is running, partial output).

**Output**: A `CodingAgent` base class (extends Agent) that implements the loop. Subclasses configure tools, model, system prompt, skills. Handles the full lifecycle: message in → context assembly → inference → tool exec → stream → persist → repeat.

```ts
class CodingAgent extends Agent<Env> {
  workspace = new Workspace(this, { ... });
  sessions = new SessionManager(this);

  tools = createWorkspaceTools(this.workspace);

  async onMessage(connection, message) {
    // The agentic loop handles everything
    await this.runAgentLoop(connection, message);
  }
}
```

**Why third**: The loop is the heart of the agent. It needs tools (Phase 1) and session management (Phase 2) to function. Once this works, we have a minimal but functional coding agent that can read, write, edit, search, and have persistent conversations.

### Phase 4 — Memory system

**Goal**: Long-term memory that persists across conversations and provides continuity. The agent remembers the user, their preferences, ongoing projects, and past decisions.

**What to build**:

1. **Memory storage**: DO SQLite table for memory entries. Each entry has content, tags, timestamps, and an optional embedding vector.

   ```sql
   memories (id, content, tags, created_at, updated_at, embedding)
   ```

2. **Memory tools**: Give the agent tools to manage its own memory:
   - `remember(content, tags)` — store a new memory
   - `recall(query)` — search memories by semantic similarity and/or keyword
   - `forget(id)` — remove a memory

3. **Auto-memory**: At the end of each conversation turn (or session), the agent can optionally extract and store relevant facts. "User prefers TypeScript over JavaScript." "Project uses Hono for routing."

4. **Context injection**: During context assembly, retrieve the N most relevant memories for the current conversation and inject them into the prompt. Use embedding similarity + recency weighting.

5. **Workspace-backed documents**: Following OpenClaw's pattern, key memory documents (MEMORY.md, project context files) live in the Workspace and are human-editable. The agent reads and updates them; the user can too.

**Output**: A `MemoryManager` class and memory tools. Integrated into context assembly.

**Why fourth**: Memory isn't needed for the agent to function — it can work statelessly. But it's what makes the agent _useful_ over time. Building it after the loop means we can test the loop without memory, then add memory and see the improvement.

### Phase 5 — Code execution (Codemode integration) ✅

**Goal**: The agent can write and execute JavaScript code with npm dependencies in sandboxed isolates. This is what elevates it from "file editor with chat" to "general-purpose machine."

**What to build**:

1. **Integrate Codemode**: The existing `@cloudflare/codemode` package already provides `createCodeTool` and `DynamicWorkerExecutor`. Wire this into the CodingAgent's tool set.

2. **Workspace bindings for isolates**: Expose Workspace operations as RPC bindings to the sandboxed code. The isolate can read/write files through `codemode.readFile()`, `codemode.writeFile()`, etc.

3. **workers-builder integration**: For code that needs npm dependencies, use workers-builder to fetch from registry and bundle before loading into the isolate. The agent writes code with `import` statements, workers-builder resolves them.

4. **Execution tool**: A higher-level `execute` tool that:
   - Takes code (JS/TS) and optional dependencies
   - Bundles with workers-builder if deps are present
   - Runs in a Dynamic Isolate with Workspace bindings
   - Returns result + console output
   - Configurable timeout and network access

5. **Tier escalation**: The agent decides which execution tier to use based on the task. Simple file operations use Tier 0. Data transformation uses Tier 1. Code with deps uses Tier 2.

**Output**: `execute` tool integrated into CodingAgent. Agent can write and run JS/TS with npm deps.

**Why fifth**: Code execution makes the agent dramatically more capable, but it's additive. The agent is already useful with just file tools + chat (Phases 1-4). Code execution is the force multiplier. Building it after the core loop means we can test it in the context of a working agent, not in isolation.

### Phase 6 — Browser tools

**Goal**: The agent can navigate web pages, extract data, fill forms, and take screenshots using Cloudflare Browser Rendering.

**What to build**:

1. **Browser binding**: Configure Cloudflare Browser Rendering as a binding. The agent gets a headless Chromium instance.

2. **Browser tools**:
   - `browse(url)` — navigate to a URL, return page content (text or screenshot)
   - `click(selector)` — click an element
   - `fill(selector, value)` — fill a form field
   - `screenshot()` — capture the current page as an image
   - `extract(selector)` — extract text/HTML from elements
   - `evaluate(js)` — run JavaScript in the page context

3. **Content extraction**: Intelligent page-to-text conversion that strips nav, ads, and boilerplate. Returns clean content suitable for LLM context.

4. **Session management**: Maintain browser state (cookies, auth) across tool calls within a conversation turn.

**Output**: Browser tools integrated into CodingAgent. Agent can research, scrape, and automate web tasks.

**Why sixth**: Browser capability is a major use case expander (research, data extraction, web automation) but doesn't block any other phase. Adding it after code execution means the agent can combine code + browser — e.g., write code that processes scraped data.

### Phase 7 — Extensions via Dynamic Worker Loaders ✅

**Goal**: A plugin system where extensions are sandboxed Workers with real npm deps, loaded on demand. Community-contributed, auditable, hot-loadable.

**What to build**:

1. **Extension format**: Define the manifest schema:

   ```jsonc
   {
     "name": "github",
     "version": "1.0.0",
     "description": "GitHub integration — PRs, issues, repos",
     "entrypoint": "src/index.ts",
     "dependencies": { "octokit": "^4.0.0" },
     "tools": ["create_pr", "list_issues", "review_pr"],
     "skills": ["github-workflow.md"],
     "permissions": {
       "network": ["api.github.com"],
       "workspace": "read-write"
     }
   }
   ```

2. **Extension loading**: When the agent needs an extension:
   - Read extension files from a source (Workspace, R2, registry)
   - Bundle with workers-builder (resolves npm deps)
   - Load into a Dynamic Worker Loader isolate
   - Pass controlled bindings (workspace, memory, network whitelist)
   - Register the extension's tools in the agent's tool set

3. **Extension lifecycle**: Load, unload, update extensions without restarting the agent. Track which extensions are active. Persist extension state in DO SQLite.

4. **Permission model**: Extensions declare what they need (network hosts, workspace access, memory access). The agent/user approves. Enforced via binding configuration — an extension that doesn't declare network access gets `globalOutbound: null`.

5. **Self-authoring**: The agent can write an extension (TypeScript code + manifest), bundle it, and load it into itself. "I need to integrate with the Notion API. Let me write an extension for that."

6. **Skills within extensions**: Extensions can include Markdown skill files that get added to the skill registry when the extension loads.

**Output**: Extension system integrated into CodingAgent. Extensions are sandboxed Workers. Agent can load, use, and create extensions.

**Why seventh**: Extensions are the growth vector — they're how the agent gets new capabilities without us shipping code. But they require the core agent to be solid first. Building on top of Phases 1-6 means extensions can use all existing capabilities (workspace, code execution, browser, memory).

### Phase 8 — Container integration

**Goal**: For tasks that truly need a real OS — git operations, running test suites, compiling code, executing Python/Go/Rust — the agent can shell out to a Cloudflare Container.

**What to build**:

1. **Container binding**: Configure a Cloudflare Container as a binding. The container provides a real Linux environment.

2. **Workspace sync**: Files in the Workspace are synced to/from the container filesystem. Edits in the Workspace appear in the container; results from the container appear in the Workspace.

3. **Shell tool**: `shell(command)` — execute a command in the container. Streaming output, timeout, cancellation. This is the full `bash` that the agent couldn't have in Tiers 0-2.

4. **Pre-built images**: Provide container images with common toolchains pre-installed (Node.js, Python, Go, Rust, git). Users can specify which image their agent uses.

5. **Lifecycle management**: Start container on demand, keep warm during a session, shut down after idle timeout. The agent doesn't pay for container time when it's not using heavy tools.

6. **Fallback logic**: The agent tries Tier 0-2 first. If a task requires native tools (detected by tool failure or explicit need like "run the test suite"), it escalates to the container.

**Output**: Container tools integrated into CodingAgent. Full OS capabilities when needed.

**Why eighth**: Containers are the escape hatch for everything Workers can't do. But they're also the most expensive and complex tier. Building them last means the agent is already highly capable without them, and we can be deliberate about when to escalate.

### Phase 9 — Proactivity and scheduling

**Goal**: The agent doesn't just respond to messages — it proactively monitors, reminds, and acts on scheduled tasks.

**What to build**:

1. **Heartbeat**: A DO alarm that fires periodically (configurable, default 30 min). On each heartbeat, the agent reads its task list from the Workspace (HEARTBEAT.md or equivalent) and decides whether anything needs action.

2. **Scheduled tasks**: Users and the agent can schedule tasks — one-time or recurring. Stored in DO SQLite, triggered by DO alarms. "Remind me to review the PR tomorrow morning." "Check the deployment status every hour."

3. **Watch mode**: The agent can watch for changes in the Workspace (via change events) and react. "If any .ts file in /src changes, run the linter."

4. **Notification routing**: When the agent acts proactively, it needs to notify the user. Route notifications to the appropriate channel (WebSocket if connected, email/webhook if not).

**Output**: Proactive agent behavior. Heartbeat, scheduling, watches, notifications.

**Why ninth**: Proactivity is what makes the agent feel alive rather than reactive. But it requires all the core pieces to be in place first — the agent needs tools, memory, and execution capability to act on scheduled tasks.

### Phase 10 — Channel adapters and multi-platform

**Goal**: The agent is accessible from web UI, chat apps (Slack, Discord, Telegram), email, and webhooks. Messages from any source are normalized and routed to the same agent.

**What to build**:

1. **Message normalization**: Define a canonical message format (text, attachments, sender, channel metadata). All adapters convert to this format.

2. **Web UI**: A React-based chat interface using `agents/react` hooks. Real-time streaming, tool execution visibility, file preview, session management. Use the existing `agents-ui` package as a foundation.

3. **Webhook adapter**: HTTP endpoint that receives messages from external services (Slack, Discord, Telegram bots) and routes them to the agent. Responses are sent back via the same channel's API.

4. **Email adapter**: Using the existing `agents/email` export, the agent can receive and respond to emails.

5. **Per-channel configuration**: Different channels can have different system prompts, tool access, and behavior. A Slack channel might be more concise; a web UI might show rich tool output.

**Output**: Multi-platform agent access. Web UI + at least one chat platform integration.

**Why last**: Channel adapters are the distribution mechanism. The agent needs to be fully capable (Phases 1-9) before we worry about where users access it. The web UI comes first because it's the most natural development interface.

## Package structure

```
packages/
  agents/                    # Existing — Agent base class, WebSocket, RPC, scheduling
  coding-agent/              # New — the coding agent framework
    src/
      index.ts               # CodingAgent class, public API
      tools/
        index.ts             # createWorkspaceTools(), tool registration
        read.ts              # Read file tool
        write.ts             # Write file tool
        edit.ts              # Find-and-replace edit tool
        list.ts              # List directory tool
        find.ts              # Find files by glob tool
        grep.ts              # Search file contents tool
        diff.ts              # Diff tool
        browse.ts            # Browser tools (Phase 6)
        shell.ts             # Container shell tool (Phase 8)
        execute.ts           # Code execution tool (Phase 5)
        memory.ts            # Memory tools (Phase 4)
        types.ts             # Operations interfaces
      session/
        index.ts             # SessionManager
        storage.ts           # SQLite schema and queries
        compaction.ts        # Summarization and compaction
        truncation.ts        # Output truncation utilities
      memory/
        index.ts             # MemoryManager
        storage.ts           # SQLite schema and queries
        embeddings.ts        # Embedding generation and search
      loop/
        index.ts             # Agentic loop implementation
        context.ts           # Context assembly
        inference.ts         # Model calling with streaming
      extensions/
        index.ts             # Extension manager
        loader.ts            # Dynamic Worker Loader integration
        manifest.ts          # Manifest parsing and validation
        permissions.ts       # Permission enforcement
      skills/
        index.ts             # Skill registry and on-demand loading
      schedule/
        index.ts             # Heartbeat, scheduled tasks, watches
  codemode/                  # Existing — code execution in dynamic isolates
  ai-chat/                   # Existing — higher-level AI chat
```

## Design principles

1. **Each phase is independently useful.** Phase 1 tools work with plain `streamText`. Phase 3 loop works without memory or code execution. You can use just the pieces you need.

2. **Escalate, don't require.** The agent should be useful with just Workspace tools (Tier 0). Code execution, browser, and containers are additive. An agent without container bindings still works — it just can't run `git`.

3. **Workspace is the source of truth.** All files, skills, memory documents, and project context live in the Workspace. The container syncs from it. Extensions read from it. This means everything is durable, inspectable, and shareable.

4. **Skills and extensions are the growth mechanism.** The core agent is general-purpose. Domain-specific capability comes from skills (Markdown instructions) and extensions (sandboxed Workers). The agent can write both.

5. **Hibernation-friendly.** Everything persists in DO SQLite or the Workspace. The agent can hibernate after every message and wake up with full context. No in-memory state that can't be rebuilt.

6. **Model-agnostic.** Use Workers AI, OpenAI, Anthropic, Google, or local models via Ollama. The AI SDK abstraction handles this.

## Open questions

- **Extension registry/marketplace**: Where do published extensions live? R2? A separate Workers service? ClawHub-like registry?
- **Workspace sharing**: Can multiple agents share a Workspace? Can a user view/edit Workspace files directly?
- **Container image management**: How are custom container images specified and stored? Image registry integration?
- **Embedding model**: Which embedding model for memory search? Workers AI has embedding models. How do we handle embedding drift on model changes?
- **Pricing model**: Containers and Browser Rendering have different cost profiles than DO compute. How does this affect the agent's decision about which tier to use?
- **Agent-to-agent**: Can agents delegate to other agents? E.g., a "coordinator" agent that spawns specialized agents for subtasks?
- **Local development**: What does `wrangler dev` look like for someone building on top of CodingAgent? Dynamic Worker Loaders work locally, but containers may not.
