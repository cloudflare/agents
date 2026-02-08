# Implementation Plan: Self-Modifying Coding Agent

## Current Status

- [x] Basic project scaffold with wrangler.jsonc
- [x] LOADER binding configured
- [x] Agent class (Think) skeleton
- [x] React frontend scaffold with Vite
- [x] **Phase 1: Core Runtime Foundation** - COMPLETE
  - [x] 1.1 Basic LOADER Execution
  - [x] 1.2 Loopback Binding Pattern
  - [x] 1.3 Error Handling & Timeouts
- [x] **Phase 2: Yjs Code Storage** - COMPLETE
  - [x] 2.1 Yjs Document Setup
  - [x] 2.2 Version Tracking
  - [x] 2.3 File Operations API
  - [x] 2.4 WebSocket Sync (basic)
- [x] **Phase 3.1: just-bash Integration** - COMPLETE
- [x] **Phase 3.2: FS Loopback (in-memory)** - COMPLETE
- [x] **Phase 3.3: Controlled Fetch** - COMPLETE
- [x] **Phase 3.4: Web Search (Brave Search)** - COMPLETE
- [x] **Phase 3.5: Browser Automation (Playwright)** - COMPLETE
- [x] **Phase 3.6: Code Execution (LOADER sandbox)** - COMPLETE
- [x] **Phase 4: Agent Loop (LLM integration)** - COMPLETE (GPT-5.2 with reasoning, 13 tools)
- [ ] **Phase 5: Session & Message Architecture** - IN PROGRESS
  - [x] 5.0 Action Logging (audit trail for all tool calls)
  - [x] 5.1 Message Storage Schema (tool calls + reasoning persisted, history returns full data)
  - [ ] 5.2 Background Task Scheduling
  - [x] 5.3 WebSocket Streaming Protocol (broadcast to all tabs, history/sync on connect, stream replay)
- [x] **Phase 5.4: Task Management** - COMPLETE
  - [x] tasks.ts module with pure functions (71 tests)
  - [x] LLM task tools (createSubtask, listTasks, completeTask)
  - [x] Orchestration-level root task creation
  - [x] Hybrid approach: orchestration owns lifecycle, LLM can decompose
- [x] **Phase 5.5: Subagent Parallel Execution** - COMPLETE
  - [x] Subagent class using DO Facets (src/subagent.ts)
  - [x] SubagentManager for spawning/tracking facets
  - [x] LLM delegation tools (delegateToSubagent, checkSubagentStatus, waitForSubagents)
  - [x] **ISOLATED storage** - facets cannot share SQLite (verified by E2E test)
  - [x] **ISOLATED static variables** - facets run in separate isolates (verified by E2E test)
  - [x] **RPC to parent works** - facets can call `ctx.exports.Think` and use `stub.fetch()`
  - [x] Props-based data passing, parent handles task graph updates
  - [x] Scheduled status checks via this.schedule() (Agents SDK)
  - [x] Hibernation recovery (orphan detection on onStart())
  - [x] Timeout detection and cleanup
  - [x] Unit tests for recovery logic
  - [x] E2E tests verifying isolation and RPC (e2e/facets.test.ts)
  - [x] **ParentRPC class** for subagent tool access (src/loopbacks/parent-rpc.ts)
  - [x] RPC endpoints on parent (/rpc/bash, /rpc/fetch, /rpc/search)
  - [ ] **BLOCKED**: Facets don't work in vitest-pool-workers (E2E tests pass in wrangler dev)
  - [ ] **FUTURE**: Investigate native JS RPC instead of HTTP-based RPC
    - Currently using `stub.fetch()` to call HTTP endpoints on parent (/rpc/bash, /rpc/fetch, etc.)
    - Cloudflare supports native JS RPC: call public async methods directly on stub (e.g., `stub.rpcBash()`)
    - Benefits: No HTTP serialization, type-safe, cleaner code
    - Requires: Adding public async methods to Think class for bash/fetch/search/file operations
    - Reference: https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests
- [ ] **Phase 5.6: Async Tool Calls** - PARTIAL
  - [x] scheduling.ts module with pure functions
  - [x] Recovery logic for subagents (implemented in server.ts)
  - [x] Integration with subagent spawning (scheduleSubagentCheck, checkSubagentStatus)
  - [ ] Integration with main agent loop
  - [ ] Tools that sleep/resume across requests
- [ ] **Phase 5.7: Context Compaction**
  - [ ] context.ts module for message management
  - [ ] Summarize older messages to save tokens
  - [ ] Keep recent messages intact
  - [ ] Configurable compaction thresholds
- [x] **Phase 5.8: Streaming Tools** - COMPLETE
  - [x] Switch from generateText() to streamText()
  - [x] WebSocket streaming of partial results (text_delta, text_done)
  - [x] Real-time tool call/result events
- [ ] **Phase 5.9: Tool Caching**
  - [ ] Cache expensive tool results (web search, fetch)
  - [ ] TTL-based invalidation
  - [ ] LRU eviction strategy
- [ ] **Phase 5.10: Long-term Memory**
  - [ ] R2/KV storage for persistent memory
  - [ ] Semantic search over past conversations
  - [ ] User preferences and learned patterns
- [ ] **Phase 5.11: Subagent Streaming** (Optional)
  - [ ] Add `streamToParent` callback to SubagentManager
  - [ ] Update Subagent.execute() to use streamText() optionally
  - [ ] Create SubagentStreamRelay for event aggregation
  - [ ] Add WebSocket message types for subagent events
  - [ ] Handle concurrent subagent streams
- [x] **Phase 5.12: E2E Testing Harness** - COMPLETE
  - [x] Create vitest.e2e.config.ts with separate config
  - [x] Implement e2e/setup.ts (globalSetup - spawn wrangler dev with --var)
  - [x] Implement teardown in setup.ts (globalTeardown - kill process)
  - [x] Create e2e/helpers.ts with shared utilities
  - [x] Add e2e/facets.test.ts - subagent API and spawn tests
  - [x] Add e2e/smoke.test.ts - basic connectivity tests
  - [x] Add e2e/streaming.test.ts - WebSocket streaming tests (stub)
  - [x] Enable ENABLE_SUBAGENT_API via --var ENABLE_SUBAGENT_API:true
  - [x] Add npm run test:e2e script
  - **Result**: 14 passing, 23 todo (facets spawn successfully!)
- [x] **Phase 5.12b: Browser Testing with Playwright** - COMPLETE
  - [x] Install `@playwright/test` for client-side UI testing
  - [x] Create `playwright.config.ts` with auto-start webserver, .env loading
  - [x] Create `browser-tests/helpers.ts` with test utilities (sendMessage, waitForIdle, etc.)
  - [x] Create `browser-tests/smoke.test.ts` (6 tests: page load, UI visibility, theme toggle, debug panel)
  - [x] Create `browser-tests/chat.test.ts` (10 tests: messaging, streaming, stop/retry, history persistence)
  - [x] Add `data-testid` attributes to client.tsx for reliable selectors
  - [x] Fix error handling in client.tsx (show errors when no streaming message exists)
  - [x] Add npm scripts: `test:browser`, `test:browser:headed`, `test:browser:debug`
  - [x] Exclude `browser-tests/**` from vitest (runs with Playwright only)
  - **Result**: 16 passing tests for chat UI flows
- [ ] **Phase 5.13: Extensibility Architecture** - PLANNED
  - [ ] Add `ThinkProps` interface for runtime customization
  - [ ] Implement `onStart(props)` to capture props
  - [ ] Change private methods to protected for extension points
  - [ ] Add `getAdditionalInstructions()` protected method (returns empty by default)
  - [ ] Add `getCustomTools()` protected method (returns empty by default)
  - [ ] Add `getModelConfig()` protected method (returns defaults)
  - [ ] Implement three-layer prompt building (core + class + props)
  - [ ] Implement three-layer tool building (core + class)
  - [ ] Implement model resolution (props > class > default)
  - [ ] Add tests for class extension pattern
  - [ ] Add tests for props-based customization
  - [ ] Document extension patterns with examples
  - [ ] **FUTURE**: Custom tools via props (see Phase 5.15)
- [ ] **Phase 5.14: Multi-Model Architecture** - PLANNED
  - [ ] Define `ModelRoles` interface (primary, fast, summarizer, vision)
  - [ ] Implement `resolveModel(role)` with fallback chain
  - [ ] Update chat loop to use `primary` model
  - [ ] Update subagent spawning to use `fast` model
  - [ ] Add context length tracking for summarization trigger
  - [ ] Implement automatic summarization with `summarizer` model
  - [ ] Integrate `vision` model for screenshot analysis
  - [ ] Add model usage logging/metrics
  - [ ] Tests for model routing logic
- [ ] **Phase 5.15: Custom Tools via Props** - FUTURE
  - **Challenge**: Props must be serializable, but tools contain executable functions
  - **Potential approaches to explore**:
    - [ ] **Named tool registry**: Props pass tool names (strings), Think looks up from a pre-registered registry
    - [ ] **Tool schemas**: Props pass JSON schema definitions, Think instantiates tools from schemas
    - [ ] **MCP server endpoints**: Props pass MCP server URLs, Think connects and discovers tools dynamically
    - [ ] **Code strings**: Props pass tool implementation as code strings, Think evaluates (security implications!)
    - [ ] **Hybrid**: Class registers tool "slots", props enable/configure them
  - **Questions to answer**:
    - [ ] What's the use case? Per-tenant tools? Per-request tools?
    - [ ] How important is full dynamic tool definition vs just configuration?
    - [ ] Can MCP solve this elegantly?
    - [ ] What are the security implications of each approach?
  - **Dependencies**: Phase 5.13 (Extensibility Architecture) should be complete first
- [ ] **Phase 5.16: User-Facing Scheduling Tool** - PLANNED
  - **Goal**: Let users schedule reminders and recurring tasks via natural language
  - **Examples**:
    - "Remind me in 2 hours to check the deployment"
    - "Every Monday at 9am, summarize my tasks"
    - "In 30 minutes, ask me how the meeting went"
  - **Design decisions**:
    - [ ] Direct tool in Think vs ScheduleLoopback (lean toward direct tool - tightly coupled to callback handler)
    - [ ] One-shot vs recurring (recurring = self-rescheduling pattern since schedule() is one-shot)
    - [ ] Natural language parsing: Let LLM convert "in 2 hours" → `delaySeconds: 7200`
    - [ ] Persistence: Store scheduled tasks in SQLite so users can list/cancel
  - **Tool schema sketch**:
    ```typescript
    scheduleReminder: tool({
      description: "Schedule a reminder or recurring task",
      parameters: z.object({
        message: z.string(),
        delaySeconds: z.number().optional(),
        cronExpression: z.string().optional(),
        timezone: z.string().default("UTC")
      }),
      execute: async ({ message, delaySeconds, cronExpression }) => {
        // Use this.schedule(delay, "reminder", { message, ... })
      }
    });
    ```
  - **Callback handler**: New `"reminder"` task type in `onScheduledTask()`
  - **UI considerations**:
    - [ ] Push via WebSocket when reminder fires (interrupt conversation?)
    - [ ] List scheduled reminders ("What reminders do I have?")
    - [ ] Cancel/snooze reminders
  - **Dependencies**: Existing `schedule()` API (already used for subagent checks)
- [x] **Phase 6: Chat UI** - COMPLETE
  - [x] 6.1 Stop Button - Cancel ongoing generation with AbortController
  - [x] 6.2 Retry Button - Resend last user message
  - [x] 6.3 Message Editing - Edit previous messages, restart conversation from that point
  - [x] 6.4 Partial Response Saving - Save stopped responses with "[Generation stopped]" marker
  - [x] 6.5 Debug Panel - Real-time internal events (state changes, tool calls, subagents)
    - Activated via `?debug=1` query parameter
    - Uses connection state (survives DO hibernation)
    - Color-coded event types
  - [x] 6.6 Server-side Cancel Support - AbortController passed to streamText()
  - [x] 6.7 History Truncation API - `/chat/truncate` endpoint for message editing
- [ ] **Phase 7: Vibe Coding Editor** - IN PROGRESS
  - [x] 7.1 Demo Switcher - Route between chat and editor demos
  - [x] 7.2 Editor Layout - Split-pane: chat | file tree + code viewer | live preview
  - [x] 7.3 File Storage - In-memory file store in DO state, `/files` API endpoint
  - [x] 7.4 Live Preview - `/preview/:path` endpoint serving files with MIME types, iframe preview
  - [x] 7.5 Editor Agent Tools - `create_file`, `edit_file`, `read_file` tools for vibe coding
  - [x] 7.6 Code Viewer - Syntax-highlighted code display with file selection
  - [ ] 7.7 Monaco Integration - Full Monaco editor with language support
  - [ ] 7.8 Yjs Collaborative Editing - Real-time sync between human and agent edits
  - [ ] 7.9 Accept/Revert Changes - Proposed changes workflow (inspired by Minions)
  - **Inspiration**: Minions (AI Gadgets) - Yjs, FileSidebar, GadgetUI sandbox
  - **Simplifications for v1**: No Yjs (plain strings), no collab, auto-accept changes
- [ ] Phase 8: Advanced Features (Multi-Session, Multiplayer)

### Agent Architecture Features Status

| Feature            | Priority | Status         | Module           | Notes                                         |
| ------------------ | -------- | -------------- | ---------------- | --------------------------------------------- |
| Task Management    | High     | ✅ Complete    | `tasks.ts`       | 71 tests, LLM tools, hybrid orchestration     |
| Async Tool Calls   | High     | ⚡ Partial     | `scheduling.ts`  | Subagent recovery complete, main loop TBD     |
| E2E Testing        | High     | ✅ Complete    | `e2e/`           | wrangler dev harness, 14 passing tests        |
| Browser Testing    | High     | ✅ Complete    | `browser-tests/` | Playwright, 16 UI tests (chat, history, etc.) |
| Subagent Pattern   | Medium   | ✅ Complete    | `subagent.ts`    | With hibernation recovery, status monitoring  |
| Chat UI            | High     | ✅ Complete    | `client.tsx`     | Stop/retry/edit, debug panel, history         |
| Vibe Code Editor   | High     | ⚡ In Progress | `editor.tsx`     | Split-pane, file tree, preview, agent tools   |
| Extensibility      | High     | ❌ Planned     | `server.ts`      | Three-layer: core/class/props customization   |
| Multi-Model        | Medium   | ❌ Planned     | `server.ts`      | Smart routing: primary/fast/summarizer/vision |
| Subagent Streaming | Low      | ❌ Designed    | `subagent.ts`    | Optional streaming from facets to parent      |
| Context Compaction | Medium   | ❌ Not Started | `context.ts`     | Summarize older messages                      |
| Streaming Tools    | Low      | ✅ Complete    | Phase 5.8        | text_delta + tool_call/result streaming       |
| Tool Caching       | Low      | ❌ Not Started | -                | Cache expensive results                       |
| Tools via Props    | Future   | ❌ Not Started | `server.ts`      | Serialization challenge, multiple approaches  |
| Long-term Memory   | Future   | ❌ Not Started | -                | R2/KV for persistent memory                   |
| Scheduling Tool    | Medium   | ❌ Planned     | `server.ts`      | Natural language reminders, recurring tasks   |

### Architecture Decisions Made

| Decision            | Choice                | Rationale                                    |
| ------------------- | --------------------- | -------------------------------------------- |
| Action Logging      | SQLite, summarized    | Audit trail, debugging, future approval      |
| Session Model       | User DO + Session DO  | Multi-tab/multi-device, future multiplayer   |
| Message Storage     | SQLite + R2 for large | Row limit compliance, full history           |
| Message Hierarchy   | parent_message_id     | Link subagent messages to delegating parent  |
| Reasoning Text      | Truncated on save     | Stream full, store summary (first 500 chars) |
| Background Tasks    | schedule() API        | Built-in, handles DO evictions, retries      |
| Retry Strategy      | Exponential backoff   | 3 attempts: 2s, 4s, 8s delays                |
| Task Management     | Hierarchical tasks    | Break complex work into subtasks             |
| Subagent Pattern    | DO Facets             | **Isolated storage**, props-based data       |
| Subagent Streaming  | Opt-in via callback   | Default silent, stream when UX requires it   |
| Context Compaction  | Summarize older msgs  | Keep main agent coherent                     |
| Extensibility       | Augment, not replace  | Core immutable, class extends, props dynamic |
| Multi-Model         | Role-based routing    | Think decides when, users configure which    |
| Custom Tools Props  | TBD - serialization   | Props must be serializable, tools have funcs |
| Cancellation        | AbortController       | Standard Web API, streamText() integration   |
| Debug Subscriptions | Connection state      | Survives DO hibernation, per-connection      |
| Message Editing     | Truncate & resend     | Server truncates history, client re-sends    |

---

## Phase 1: Core Runtime Foundation ✓ COMPLETE

**Goal**: Get "load and execute arbitrary code with custom bindings" working end-to-end.

### 1.1 Basic LOADER Execution ✓

**Acceptance Criteria**:

- [x] Can call an HTTP endpoint that loads JS code from a string
- [x] Loaded code executes and returns a result
- [x] Console output is captured and returned

**Implementation**:

- `executeCode(code: string, modules?: Record<string, string>)` in Think Agent
- `env.LOADER.get()` with unique execution ID
- Harness module wraps user code and captures console.log
- Returns `ExecutionResult` with success, output, logs, errors

**Key Files**:

- `src/server.ts` - Think Agent with `executeCode()` and `buildHarnessModule()`

### 1.2 Loopback Binding Pattern ✓

**Acceptance Criteria**:

- [x] Dynamic workers can call back to the parent Agent
- [x] Props are correctly passed through ctx.exports
- [x] Multiple loopback bindings work simultaneously

**Implementation**:

- Created `EchoLoopback`, `BashLoopback`, `FSLoopback` as WorkerEntrypoint classes
- Loopbacks receive `props` with `sessionId` for per-session state
- Used static Maps to persist state across RPC calls (e.g., Bash instance)
- All loopbacks wired up via `ctx.exports` in `getEnvForLoader()`

**Key Files**:

- `src/loopbacks/echo.ts` - Simple test loopback (ping, info, echo)
- `src/loopbacks/bash.ts` - just-bash integration
- `src/loopbacks/fs.ts` - In-memory file system
- `src/loopbacks/index.ts` - Re-exports

### 1.3 Error Handling & Timeouts ✓

**Acceptance Criteria**:

- [x] Syntax errors in loaded code return meaningful errors
- [x] Runtime errors are caught and returned
- [x] Execution timeouts prevent runaway code
- [ ] Memory limits are enforced (handled by Worker runtime)

**Implementation**:

- try/catch around LOADER.get() and execution
- Error categorization: `syntax`, `runtime`, `timeout`, `unknown`
- `withTimeout()` using Promise.race (default 30s, configurable via `timeoutMs`)
- `formatError()` cleans up worker error messages
- `categorizeError()` detects error types from message patterns

---

## Phase 2: Yjs Code Storage ✓ COMPLETE

**Goal**: Store code in a Yjs document with full versioning and sync capability.

### 2.1 Yjs Document Setup ✓

**Acceptance Criteria**:

- [x] Code is stored as Y.Map<Y.Text> in Agent's SQLite
- [x] Can read/write files via Yjs API
- [x] Changes are persisted across Agent restarts

**Implementation**:

- `YjsStorage` class manages Yjs document persistence
- Uses `code_updates`, `code_snapshots`, `code_version` SQLite tables
- `initializeDocument()` creates initial state with default files
- `buildYDoc()` reconstructs document from stored updates/snapshots

**Key Files**:

- `src/yjs-storage.ts` - Yjs persistence layer with SQLite backend
- `src/server.ts` - Integrated via `getStorage()` method

### 2.2 Version Tracking ✓

**Acceptance Criteria**:

- [x] Each code change increments version number
- [x] Can replay history to any version
- [x] Snapshots are created periodically for efficiency
- [ ] Version used in LOADER ID (TODO - currently using execution UUID)

**Implementation**:

- `codeVersion` tracked in SQLite `code_version` table
- `replayUpdates(fromVersion, toVersion, apply)` for history replay
- Automatic snapshot creation when log size exceeds 10KB threshold
- Version synced to Agent state for client awareness

**SQL Schema**:

```sql
CREATE TABLE code_updates (version INTEGER PRIMARY KEY, timestamp TEXT, data BLOB);
CREATE TABLE code_snapshots (version INTEGER PRIMARY KEY, timestamp TEXT, data BLOB);
CREATE TABLE code_version (id INTEGER PRIMARY KEY, version INTEGER);
```

### 2.3 File Operations API ✓

**Acceptance Criteria**:

- [x] `readFile(path)` returns file content from Yjs
- [x] `writeFile(path, content)` creates/replaces file
- [x] `editFile(path, search, replace)` does search-and-replace
- [x] `listFiles()` returns all filenames
- [x] `deleteFile(path)` removes file

**API (YjsStorage)**:

```typescript
getFiles(): Record<string, string>
readFile(path: string): string | null
writeFile(path: string, content: string): number  // returns version
editFile(path: string, search: string, replace: string): number | null
deleteFile(path: string): number
listFiles(): string[]
```

**HTTP Endpoints**:

- `GET /files` - All files with version
- `GET /file/{path}` - Single file content
- `PUT /file/{path}` - Create/update file
- `DELETE /file/{path}` - Delete file

### 2.4 WebSocket Sync (Basic) ✓

**Acceptance Criteria**:

- [x] Clients can subscribe to code updates
- [x] Binary Yjs updates broadcast to clients
- [ ] Full Yjs sync protocol (TODO - currently basic broadcast)
- [ ] Late-joining clients receive current state (TODO)

**Implementation**:

- Binary messages (Yjs updates) broadcast to all connections except sender
- WebSocket message handlers for `read-file`, `write-file`, `list-files`, `get-files`
- `file-changed` events broadcast on writes

---

## Phase 3: Tools

**Goal**: Give the agent useful tools to work with.

### 3.1 just-bash Integration ✓ COMPLETE

**Acceptance Criteria**:

- [x] Agent can execute bash commands
- [x] Commands run in virtual filesystem
- [x] Output (stdout, stderr, exit code) is captured
- [x] Execution limits configured (SIGCHLD 500, MAX_SPAWNS 100)

**Implementation**:

- `BashLoopback` WorkerEntrypoint wraps `just-bash` library
- Static Map stores Bash instances per session (persists across RPC calls)
- Default files created on init (`/home/README.txt`, `/src/hello.js`)
- Methods: `exec()`, `writeFile()`, `readFile()`, `listFiles()`, `getCwd()`

**Key Files**:

- `src/loopbacks/bash.ts` - Bash tool loopback

**Test** (verified working):

```bash
curl -X POST -d '{"code":"export default async (env) => {
  return await env.BASH.exec(\"echo Hello && pwd\");
}"}' /execute
# Returns: {"stdout":"Hello\n/\n","stderr":"","exitCode":0}
```

### 3.2 FS Loopback ✓ BASIC (In-Memory)

**Acceptance Criteria**:

- [x] Basic fs operations work in dynamic workers
- [x] In-memory file storage (shared across executions)
- [ ] Integration with Yjs for persistence (TODO)
- [ ] worker-fs-mount integration (TODO)

**Implementation**:

- `FSLoopback` WorkerEntrypoint with static in-memory storage
- Methods: `readFile()`, `writeFile()`, `appendFile()`, `unlink()`, `exists()`, `stat()`, `mkdir()`, `readdir()`, `rmdir()`
- Default directories: `/home`, `/src`

**Key Files**:

- `src/loopbacks/fs.ts` - In-memory file system loopback

**Decision**: Current in-memory FS is separate from Yjs. Options:

1. Keep separate: FS for temp files, Yjs for source code
2. Bridge: FS writes to specific paths sync to Yjs
3. Replace: Use worker-fs-mount with Yjs backend

### 3.3 Controlled Fetch ✓ COMPLETE

**Acceptance Criteria**:

- [x] Dynamic workers can make HTTP requests through loopback
- [x] URL allowlist is enforced
- [x] Method restrictions (GET/HEAD/OPTIONS by default)
- [x] Requests are logged

**Implementation**:

- `FetchLoopback` WorkerEntrypoint with configurable security controls
- URL prefix allowlist with sensible defaults (github, npm, jsdelivr, unpkg)
- Method restrictions (GET, HEAD, OPTIONS allowed by default)
- Full request logging with timestamps, duration, status
- Convenience methods: `get()`, `head()`, `getLog()`, `clearLog()`, `getConfig()`
- Response body truncation for large payloads (>1MB)
- Error categorization: `URL_NOT_ALLOWED`, `METHOD_NOT_ALLOWED`, `FETCH_FAILED`

**Key Files**:

- `src/loopbacks/fetch.ts` - Controlled fetch loopback

### 3.4 Web Search (Brave Search) ✓ COMPLETE

**Acceptance Criteria**:

- [x] Agent can search the web for documentation and information
- [x] Web search results include title, URL, description, snippets
- [x] News search for recent articles and announcements
- [x] Freshness filtering (past day/week/month/year)
- [x] Request logging for audit

**Implementation**:

- `BraveSearchLoopback` WorkerEntrypoint wraps Brave Search API
- API key passed via props from environment (`BRAVE_API_KEY`)
- Web search endpoint: `/res/v1/web/search`
- News search endpoint: `/res/v1/news/search`
- Extra snippets option for more context per result
- Rate limiting and error handling
- Methods: `search()`, `news()`, `getLog()`, `clearLog()`

**Key Files**:

- `src/loopbacks/brave-search.ts` - Brave Search loopback

**LLM Tools**:

- `webSearch` - Search the web for documentation, tutorials, best practices
- `newsSearch` - Find recent news and announcements

**Test** (verified manually):

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"message":"Search the web for TypeScript 5.4 new features"}' \
  http://localhost:8787/agents/think/test/chat
```

### 3.5 Browser Automation (Playwright) ✓ COMPLETE

**Acceptance Criteria**:

- [x] Agent can browse web pages and extract content
- [x] Agent can take screenshots of web pages
- [x] Agent can interact with pages (click, type, navigate)
- [x] Agent can scrape specific elements from pages
- [x] Session reuse for performance

**Implementation**:

- `BrowserLoopback` WorkerEntrypoint wraps @cloudflare/playwright
- Uses Cloudflare Browser Rendering with `BROWSER` binding
- Session management with `acquire()` + `connect()` for reuse
- Methods: `browse()`, `screenshot()`, `interact()`, `scrape()`, `getLog()`, `clearLog()`

**Key Files**:

- `src/loopbacks/browser.ts` - Playwright browser loopback

**LLM Tools**:

- `browseUrl` - Browse a URL and extract page content as text
- `screenshot` - Take a screenshot of a web page
- `interactWithPage` - Perform actions (click, type, scroll, etc.)
- `scrapePage` - Extract specific elements using CSS selectors

**Test** (example usage):

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"message":"Browse to the Cloudflare Workers docs and summarize the main features"}' \
  http://localhost:8787/agents/think/test/chat
```

### 3.6 Code Execution (LOADER sandbox) ✓ COMPLETE

**Acceptance Criteria**:

- [x] Agent can execute arbitrary JavaScript code
- [x] Code runs in isolated V8 environment (no network, no filesystem)
- [x] Console.log outputs are captured
- [x] Return values are JSON-stringified
- [x] Timeout protection (configurable, max 120s)
- [x] Module support for code organization

**Implementation**:

- `executeCode` tool uses existing LOADER infrastructure
- Code executed in sandboxed dynamic worker with `globalOutbound: null`
- Result includes: `success`, `output`, `error`, `errorType`, `logs`, `duration`
- Supports optional ES modules via `modules` parameter
- Error categorization: `syntax`, `runtime`, `timeout`, `unknown`

**Key Files**:

- `src/agent-tools.ts` - `createExecuteCodeTool()` and `ExecuteCodeFn` type
- `src/server.ts` - `executeCode()` method in Think Agent

**LLM Tool**:

- `executeCode` - Run JavaScript for calculations, data transformations, testing logic

**Use Cases**:

1. **Complex calculations**: Math operations, statistical analysis
2. **Data transformations**: JSON parsing, array manipulation, object restructuring
3. **String processing**: Regex, formatting, templating
4. **Algorithm testing**: Quick prototyping before writing to files
5. **Code verification**: Test snippets before committing changes

**Test** (example usage):

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"message":"Calculate the sum and average of [1,2,3,4,5,6,7,8,9,10]"}' \
  http://localhost:8787/agents/think/test/chat
```

---

## Phase 4: Agent Loop ✓ COMPLETE

**Goal**: Wire up an LLM that can use the tools.

### 4.1 LLM Integration ✓

**Acceptance Criteria**:

- [x] Can send messages to LLM and get responses
- [ ] Streaming responses work (→ Phase 5.3)
- [ ] Multiple model providers supported (→ Phase 8)

**Implementation**:

- AI SDK v6 (`ai@6.0.70`) with OpenAI adapter (`@ai-sdk/openai@3.0.25`)
- Using `gpt-5.2` model with reasoning capabilities for best coding performance
- `generateText()` with automatic tool loop via `stopWhen: stepCountIs(N)`
- `reasoningEffort: "medium"` for balanced speed/quality
- `reasoningSummary: "auto"` for insight into model's thought process

**Note**: Streaming will be implemented in Phase 5.3 as part of the WebSocket protocol redesign. This will switch from `generateText()` to `streamText()` and broadcast fine-grained deltas.

**Key Files**:

- `src/server.ts` - OpenAI client setup, `handleChatMessage()` with agent loop

### 4.2 Tool Definitions ✓

**Acceptance Criteria**:

- [x] Tools are defined with Zod schemas
- [x] LLM can call tools and get results
- [x] Multi-step tool use works

**Implementation**:

Created 13 tools in `src/agent-tools.ts`:

- `bash` - Execute shell commands via just-bash loopback
- `readFile` - Read files from Yjs storage
- `writeFile` - Create/overwrite files in Yjs storage
- `editFile` - Search-and-replace edits in files
- `listFiles` - List all project files
- `fetch` - Controlled HTTP requests via fetch loopback
- `webSearch` - Search the web via Brave Search API
- `newsSearch` - Search news via Brave Search API
- `browseUrl` - Browse and extract content from web pages
- `screenshot` - Take screenshots of web pages
- `interactWithPage` - Perform actions on web pages
- `scrapePage` - Extract elements from web pages
- `executeCode` - Run JavaScript in sandboxed environment

**Key Files**:

- `src/agent-tools.ts` - Tool definitions with Zod schemas and SYSTEM_PROMPT

### 4.3 Conversation Management ✓

**Acceptance Criteria**:

- [x] Chat messages are stored in SQLite
- [x] Tool calls and results are logged (via WebSocket)
- [x] Conversation can be replayed for context
- [x] Multiple conversations supported (per session/room)

**Implementation**:

- `chat_messages` SQLite table for persistence
- In-memory `chatHistory` array for fast access
- MAX_CONTEXT_MESSAGES (50) limit for token management
- History loaded on demand, saved after each message

**API**:

- `POST /chat` - Send message, get all responses
- `GET /chat/history` - Get conversation history
- `POST /chat/clear` - Clear conversation

### 4.4 Agent Loop Orchestration ✓

**Acceptance Criteria**:

- [x] Full agent loop: user message → LLM → tools → response
- [x] Multi-step reasoning works (via AI SDK's `stopWhen`)
- [x] Agent stops appropriately (MAX_TOOL_ROUNDS = 20)
- [x] Errors are handled gracefully
- [x] Broadcast progress to connected clients

**Implementation**:

- `handleChatMessage()` runs the full agent loop
- `onStepFinish` callback broadcasts tool calls/results to WebSocket clients
- Status transitions: `thinking` → `executing` → `thinking` → `idle`
- Comprehensive error handling with client notification

---

## Phase 5: Session & Message Architecture

**Goal**: Robust session management with durable message storage and background task resilience.

### 5.0 Action Logging

**Acceptance Criteria**:

- [ ] All tool calls logged to SQLite
- [ ] Logs include tool, action, input, output summary, duration, success/error
- [ ] Large outputs summarized (not stored in full)
- [ ] Can query action log by session, tool, time range
- [ ] Actions linked to originating chat message

**Schema**:

```sql
CREATE TABLE action_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  tool TEXT NOT NULL,
  action TEXT NOT NULL,
  input TEXT,
  output_summary TEXT,
  duration_ms INTEGER,
  success INTEGER NOT NULL,
  error TEXT,
  message_id TEXT
);

CREATE INDEX idx_action_log_session ON action_log(session_id, timestamp);
CREATE INDEX idx_action_log_tool ON action_log(tool, timestamp);
```

**Tasks**:

- [ ] Create action_log SQLite table in Agent constructor
- [ ] Add `logAction()` helper method to Agent
- [ ] Add `summarizeOutput()` helper for different tool types
- [ ] Update loopback methods to log actions
- [ ] Add HTTP endpoint to query action log
- [ ] Add tests for action logging

**Implementation**:

```typescript
interface ActionLogEntry {
  id: string;
  sessionId: string;
  timestamp: number;
  tool: string;
  action: string;
  input?: string;
  outputSummary?: string;
  durationMs?: number;
  success: boolean;
  error?: string;
  messageId?: string;
}

async logAction(entry: Omit<ActionLogEntry, 'id' | 'timestamp'>): Promise<string> {
  const id = crypto.randomUUID();
  const timestamp = Date.now();

  this.sql.exec(`
    INSERT INTO action_log (id, session_id, timestamp, tool, action, input, output_summary, duration_ms, success, error, message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, id, entry.sessionId, timestamp, entry.tool, entry.action,
     entry.input, entry.outputSummary, entry.durationMs,
     entry.success ? 1 : 0, entry.error, entry.messageId);

  return id;
}
```

**Output Summarization Examples**:

| Tool        | Summary Format                                      |
| ----------- | --------------------------------------------------- |
| bash        | `exit=0, stdout=1234 chars, stderr=0 chars`         |
| readFile    | `file.ts: 500 lines, 12KB`                          |
| writeFile   | `wrote file.ts: 500 lines`                          |
| fetch       | `200 OK, 5.2KB response`                            |
| webSearch   | `5 results for "query..."`                          |
| browseUrl   | `https://... - "Page Title" (1234 elements)`        |
| executeCode | `success, returned: {...}` or `error: TypeError...` |

---

### 5.1 Message Storage Schema

**Acceptance Criteria**:

- [ ] One row per message in SQLite
- [ ] Support for user, assistant, tool messages
- [ ] R2 integration for large content (>50KB)
- [ ] Reasoning truncated for storage (full during stream)
- [ ] Token counting for context management

**Schema**:

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT,
  content_r2_key TEXT,
  tool_calls JSON,
  tool_results_summary TEXT,
  tool_results_preview TEXT,
  tool_results_r2_key TEXT,
  reasoning TEXT,
  reasoning_full_size INTEGER,
  status TEXT DEFAULT 'pending',
  error TEXT,
  task_id TEXT,
  checkpoint TEXT,
  heartbeat_at INTEGER,
  timestamp INTEGER NOT NULL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  model TEXT,
  attempt INTEGER DEFAULT 1,
  parent_id TEXT
);
```

**Tasks**:

- [ ] Create new message schema
- [ ] Implement message CRUD operations
- [ ] Add R2 storage for large content
- [ ] Implement `summarizeToolResult()` helper
- [ ] Implement `truncateReasoning()` helper
- [ ] Add token counting

### 5.2 Background Task Scheduling

**Status**: Core module complete, server integration pending

**Acceptance Criteria**:

- [x] Exponential backoff calculation (scheduling.ts)
- [x] Transient vs permanent error classification (scheduling.ts)
- [x] Orphaned task detection (scheduling.ts)
- [x] Recovery action determination (scheduling.ts)
- [x] Unit tests (75 tests in scheduling.test.ts)
- [x] Integration test structure (loader.scheduling.test.ts - slow tests separate)
- [ ] Agent work uses schedule() API for durability
- [ ] Survives DO evictions/restarts
- [ ] Heartbeat checkpoints for long operations

**Module**: `src/scheduling.ts`

Pure functions for scheduling logic (stable, rarely changes):

- `calculateBackoff(attempt)` - Exponential backoff calculation
- `isTransientError(error)` - Classify retry-worthy errors
- `findOrphanedMessages(messages)` - Detect stuck tasks
- `determineRecoveryAction(message)` - Decide retry/resume/fail
- `SCHEDULING_CONFIG` - Configurable defaults

**Implementation**:

```typescript
// Enqueue durable work
async queueChat(messageId: string, content: string) {
  await this.schedule(0, "executeChat", {
    messageId,
    content,
    attempt: 1,
    maxAttempts: 3
  });
}

// Executed by scheduler
async executeChat(payload: ChatPayload) {
  try {
    await this.runAgentLoop(payload);
  } catch (error) {
    await this.handleExecutionError(payload, error);
  }
}

// Retry with backoff
async handleExecutionError(payload: ChatPayload, error: Error) {
  if (isTransientError(error) && payload.attempt < payload.maxAttempts) {
    const delay = Math.pow(2, payload.attempt); // 2s, 4s, 8s
    await this.schedule(delay, "executeChat", {
      ...payload,
      attempt: payload.attempt + 1
    });
    this.broadcastRetrying(payload, error, delay);
  } else {
    await this.markFailed(payload.messageId, error);
  }
}
```

**Tasks**:

- [x] Create scheduling.ts module with pure functions
- [x] Add unit tests (scheduling.test.ts - 75 tests)
- [x] Create slow integration tests (loader.scheduling.test.ts)
- [ ] Refactor `handleChatMessage` to use schedule()
- [ ] Implement `executeChat()` scheduled method
- [ ] Add heartbeat for long operations
- [ ] Add orphaned task recovery on startup (using findOrphanedMessages)
- [ ] Add cancellation support via `cancelSchedule()`

### 5.3 WebSocket Streaming Protocol

**Acceptance Criteria**:

- [ ] Fine-grained events (text-delta, reasoning-delta, tool-call-\*)
- [ ] Multi-tab sync (all connected tabs see same state)
- [ ] Reconnection with state replay
- [ ] Background task status updates

**Message Types**:

```typescript
type WSMessage =
  | { type: "status"; status: Status }
  | { type: "text-delta"; messageId: string; delta: string }
  | { type: "reasoning-delta"; messageId: string; delta: string }
  | {
      type: "tool-call-start";
      messageId: string;
      callId: string;
      tool: string;
      input: unknown;
    }
  | {
      type: "tool-call-result";
      messageId: string;
      callId: string;
      output: unknown;
      duration: number;
    }
  | { type: "message-complete"; message: StoredMessage }
  | { type: "error"; error: string; messageId?: string }
  | { type: "history"; messages: StoredMessage[] }
  | { type: "sync"; state: AgentState }
  | { type: "task-queued"; taskId: string }
  | {
      type: "task-retrying";
      taskId: string;
      error: string;
      attempt: number;
      retryIn: number;
    }
  | { type: "task-complete"; taskId: string }
  | { type: "task-failed"; taskId: string; error: string; attempts: number };
```

**Tasks**:

- [ ] Define TypeScript types for all message types
- [ ] Update agent loop to use streamText instead of generateText
- [ ] Implement delta broadcasting for text and reasoning
- [ ] Add tool call lifecycle events
- [ ] Implement reconnection handler with history replay
- [ ] Add sync on connect

### 5.4 Task Management

**Status**: COMPLETE ✓

**Goal**: Break complex work into manageable subtasks with dependency tracking.

**Acceptance Criteria**:

- [x] Task types and interfaces (tasks.ts)
- [x] Task graph operations (add, complete, get ready tasks)
- [x] Dependency resolution
- [x] Hierarchical task decomposition
- [x] Unit tests (71 tests)
- [x] Integration with agent loop (root task per message)
- [x] LLM task tools (createSubtask, listTasks, completeTask)
- [x] SYSTEM_PROMPT updates for task-aware behavior
- [x] Subagent parallel execution via DO Facets

**Module**: `src/tasks.ts`

Pure functions for task management:

- `createTask()` - Create a new task
- `completeTask()` - Mark task complete with result
- `getReadyTasks()` - Get tasks with satisfied dependencies
- `getTaskTree()` - Get hierarchical view
- `validateDependencies()` - Check for cycles/missing deps

**Task Schema**:

```typescript
interface Task {
  id: string;
  parentId?: string;
  type: "explore" | "code" | "test" | "review" | "plan";
  description: string;
  status: "pending" | "in_progress" | "blocked" | "complete" | "failed";
  dependencies: string[];
  result?: string;
  assignedTo?: string; // Subagent/DO id
  createdAt: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}
```

**Configuration**:

```typescript
const TASK_CONFIG = {
  maxDepth: 3, // Don't break down more than 3 levels
  maxSubtasks: 10, // Max children per task
  maxTotalTasks: 50 // Prevent runaway decomposition
};
```

### 5.5 Context Management (Future)

**Goal**: Keep agent context coherent over long sessions.

**Features**:

- Summarize older messages
- Compress tool results
- Provide focused context to subagents

### 5.6 Subagent Coordination (Future)

**Goal**: Spawn and coordinate multiple agents for parallel work.

**Features**:

- Separate DOs for isolated context
- Parent sleeps while subagents work
- Results aggregation via R2/KV
- `toModelOutput` for summarization

---

## Phase 5.13: Extensibility Architecture

**Goal**: Make Think customizable via class extension and runtime props while keeping the core opinionated.

### Design Philosophy

Think is an **opinionated thinking machine**:

- **Core is immutable**: System prompt, core tools, and model routing logic cannot be removed
- **Class extension augments**: Subclasses add domain knowledge and tools
- **Props customize at runtime**: Per-request additional instructions and model preferences

### ThinkProps Interface

```typescript
interface ThinkProps {
  // Augment system prompt (added after core + class-level)
  additionalInstructions?: string;

  // Override model roles (serializable identifiers, not LanguageModel objects)
  models?: Partial<{
    primary: string; // e.g., "gpt-5.2", "claude-3-opus"
    fast: string; // e.g., "gpt-4o-mini", "claude-haiku"
    summarizer: string; // For context compaction
    vision: string; // For screenshot analysis
  }>;

  // NOTE: Custom tools via props is deferred
  // Challenge: Tools contain executable functions, props must be serializable
  // Future options to explore:
  // - Tool definitions that reference registered tools by name
  // - Tool schemas that Think instantiates from a registry
  // - MCP server endpoints that Think calls dynamically
}
```

### Protected Extension Points

Change these methods from private to protected:

```typescript
class Think extends Agent<Env, ThinkState> {
  // Override to add domain-specific instructions
  protected getAdditionalInstructions(): string {
    return ""; // Default: no additions
  }

  // Override to add domain-specific tools
  protected getCustomTools(): Record<string, Tool> {
    return {}; // Default: no custom tools
  }

  // Override to configure models
  protected getModelConfig(): Partial<ModelRoles> {
    return {}; // Default: use system defaults
  }
}
```

### Implementation Tasks

1. **Add ThinkProps interface** and update onStart to capture props
2. **Change private → protected** for extension methods
3. **Implement getAdditionalInstructions()** with default empty implementation
4. **Implement getCustomTools()** with default empty implementation
5. **Implement getModelConfig()** with default empty implementation
6. **Update buildSystemPrompt()** to merge three layers
7. **Update buildTools()** to merge core + class tools
8. **Update model selection** to check props > class > default
9. **Add tests** for extension patterns
10. **Document** with examples in README

### Acceptance Criteria

- [ ] Can extend Think and add custom instructions
- [ ] Can extend Think and add custom tools
- [ ] Can pass additionalInstructions via props
- [ ] Can pass model config via props
- [ ] Core prompt and tools are always present
- [ ] Props override class config, class overrides defaults
- [ ] Tests cover all three layers

---

## Phase 5.14: Multi-Model Architecture

**Goal**: Use different models for different tasks, with smart automatic routing.

### Model Roles

| Role         | When Used                        | Default              | Override via   |
| ------------ | -------------------------------- | -------------------- | -------------- |
| `primary`    | Main reasoning, complex planning | gpt-5.2 w/ reasoning | Class or Props |
| `fast`       | Subagents, quick checks          | gpt-4o-mini          | Class or Props |
| `summarizer` | Context compaction               | Same as fast         | Class or Props |
| `vision`     | Screenshot analysis              | gpt-4o               | Class or Props |

### Model Registry

Think maintains a registry of known model identifiers:

```typescript
const MODEL_REGISTRY: Record<string, () => LanguageModel> = {
  "gpt-5.2": () => createOpenAI()("gpt-5.2"),
  "gpt-4o": () => createOpenAI()("gpt-4o"),
  "gpt-4o-mini": () => createOpenAI()("gpt-4o-mini"),
  "claude-3-opus": () => createAnthropic()("claude-3-opus"),
  "claude-3-sonnet": () => createAnthropic()("claude-3-sonnet"),
  "claude-haiku": () => createAnthropic()("claude-3-haiku")
  // ... more models
};
```

### Model Resolution

```typescript
private resolveModel(role: keyof ModelRoles): LanguageModel {
  // Layer 3: Props (runtime)
  if (this.props?.models?.[role]) {
    return this.createModelFromId(this.props.models[role]);
  }

  // Layer 2: Class config
  const classConfig = this.getModelConfig();
  if (classConfig[role]) {
    return this.createModelFromId(classConfig[role]);
  }

  // Layer 1: Defaults
  return this.createModelFromId(DEFAULT_MODELS[role]);
}

private createModelFromId(id: string): LanguageModel {
  const factory = MODEL_REGISTRY[id];
  if (!factory) {
    throw new Error(`Unknown model: ${id}`);
  }
  return factory();
}
```

### Automatic Routing (Opinionated)

Think decides when to use each model:

```typescript
// Main chat loop → primary
const response = await this.chat(message, this.resolveModel("primary"));

// Subagent execution → fast
await this.spawnSubagent(task, this.resolveModel("fast"));

// Context too long → summarizer
if (this.contextLength > this.maxContext * 0.8) {
  await this.compactContext(this.resolveModel("summarizer"));
}

// Screenshot in message → vision
if (hasImages(message)) {
  response = await this.chat(message, this.resolveModel("vision"));
}
```

### Implementation Tasks

1. **Define ModelRoles interface**
2. **Create MODEL_REGISTRY** with supported models
3. **Implement resolveModel()** with fallback chain
4. **Update handleChatMessage()** to use primary model
5. **Update SubagentManager** to use fast model
6. **Add context length tracking**
7. **Implement compactContext()** with summarizer model
8. **Detect images in messages** and route to vision model
9. **Add model usage metrics** (which model, tokens, cost estimate)
10. **Tests** for model routing logic

### Acceptance Criteria

- [ ] Main chat uses primary model by default
- [ ] Subagents use fast model by default
- [ ] Can override models via class extension
- [ ] Can override models via props
- [ ] Unknown model IDs throw helpful errors
- [ ] Model metrics logged for debugging
- [ ] Vision model used when images present
- [ ] Summarizer triggered on context overflow

---

## Phase 6: Chat UI

**Goal**: Human-usable interface for interacting with the agent.

### Development Approach: Incremental "Pull"

Instead of building all backend infrastructure first, we **pull in features as the UI demands them**:

```
Build UI → Hit limitation → Add minimal backend support → Continue UI → Repeat
```

**Rationale**: Nothing is shipped yet, so backward compatibility isn't a concern. We prioritize development visibility and iterate quickly.

**What Exists Today**:

- Simple `chat_messages` table (id, session_id, role, content, tool_calls, timestamp)
- WebSocket streaming works (text_delta, tool_call, tool_result, text_done)
- `/chat/history` and `/chat/clear` endpoints
- Subagent spawning/completion via task system

**Add When Needed**:

| Need                          | Solution                                                | When                          |
| ----------------------------- | ------------------------------------------------------- | ----------------------------- |
| Real-time subagent visibility | WebSocket events (subagent_spawned, subagent_completed) | Day 1-2                       |
| Persistent subagent history   | `parent_message_id` column for nested display           | When we want history          |
| Better status display         | `status` column or rely on existing WS events           | When UI needs states          |
| Reasoning on reconnect        | `reasoning` column + truncation helper                  | When reconnect UX matters     |
| Large content handling        | R2 integration                                          | When content exceeds 50KB     |
| Token management              | Token counting columns                                  | When context overflow happens |

### 6.0 Subagent Visibility (Incremental)

**Goal**: See what subagents are doing in real-time.

**Phase 1 - WebSocket Events** (no schema change):

```typescript
// Emit when subagent spawns
{ type: "subagent_spawned", taskId: string, description: string }

// Emit periodic status
{ type: "subagent_status", taskId: string, status: "running", elapsed: number }

// Emit on completion
{ type: "subagent_completed", taskId: string, success: boolean, result?: string, error?: string }
```

**Phase 2 - Persistent History** (when needed):

- Add `facet_name` column to identify subagent messages
- Add `parent_message_id` column to link to delegating message
- UI shows subagent activity nested under parent message

**Tasks**:

- [ ] Add subagent WebSocket events to SubagentManager
- [ ] UI component to display subagent activity
- [ ] (Later) Schema migration for persistent subagent messages

### 6.1 Chat Interface

**Status**: IN PROGRESS

**Acceptance Criteria**:

- [x] Can send messages and see responses
- [x] Streaming responses display in real-time (text + reasoning)
- [x] Tool calls visible with expandable details
- [ ] Subagent activity visible (spawned, running, completed)
- [ ] History pagination for long sessions
- [ ] Cancel in-progress operations

**Tasks**:

- [x] Create ChatPanel component (`src/client.tsx`)
- [x] Wire up to useAgent hook with ThinkState
- [x] Implement message streaming with deltas
- [x] Show tool call details (collapsible)
- [x] Add send button and input
- [x] Add status indicator (idle/thinking/executing)
- [x] Add dark theme CSS styling
- [ ] Show subagent status (inline or sidebar)
- [ ] Add cancel button during execution
- [ ] Implement infinite scroll for history
- [ ] Load existing chat history on connect

### 6.2 Message Editing & Retry

**Acceptance Criteria**:

- [ ] Can edit previous user messages
- [ ] Editing triggers new agent response
- [ ] Document state rolls back on edit
- [ ] Retry after failure works correctly

**Implementation Options**:

1. **Fork model**: Original timeline preserved, edit creates branch
2. **Replace model**: Edit overwrites history from that point

**Tasks**:

- [ ] Add edit button on user messages
- [ ] Implement message editing with timeline branching
- [ ] Add retry button on failed messages
- [ ] Wire up to document state for rollback

### 6.3 Attachments

**Acceptance Criteria**:

- [ ] Can attach files to messages
- [ ] Images included in LLM context
- [ ] Large files stored in R2
- [ ] Preview thumbnails in UI

**Tasks**:

- [ ] Add file upload to input area
- [ ] Store attachments in R2
- [ ] Generate thumbnails for images
- [ ] Update LLM context to include attachments

### 6.4 Background Task Status

**Acceptance Criteria**:

- [ ] See status of queued tasks when offline
- [ ] Retry indicator shows attempt count
- [ ] Failed tasks show error and "Retry" option

**Tasks**:

- [ ] Create TaskStatus component
- [ ] Wire up task-\* events from WebSocket
- [ ] Show persistent toast/banner for background work
- [ ] Handle reconnection to see background work status

---

## Phase 7: Code Editor

**Goal**: Real-time collaborative code editing with the agent.

### 7.1 Monaco Editor Integration

**Acceptance Criteria**:

- [ ] Monaco editor with syntax highlighting
- [ ] Real-time sync with Yjs
- [ ] Human and agent changes merge correctly
- [ ] File tree for navigation

**Tasks**:

- [ ] Install Monaco and y-monaco
- [ ] Create CodeEditor component
- [ ] Wire up Yjs binding
- [ ] Create file tree sidebar
- [ ] Handle file selection

**Dependencies**:

```json
{
  "@monaco-editor/react": "^latest",
  "y-monaco": "^latest"
}
```

### 7.2 File Operations

**Acceptance Criteria**:

- [ ] Create/rename/delete files
- [ ] Folder support
- [ ] Drag and drop reordering

**Tasks**:

- [ ] Add file context menu
- [ ] Implement file CRUD via WebSocket
- [ ] Add drag-drop support

---

## Phase 8: Advanced Features (Future)

### 8.1 Human-in-the-Loop Approval

- [ ] Actions can require approval
- [ ] Approval UI inline in chat
- [ ] Timeout handling for pending approvals

### 8.2 Sandbox Integration

- [ ] Detect when sandbox is needed
- [ ] Spin up sandbox for heavy operations
- [ ] Handle sandbox lifecycle

### 8.3 Skills Registry

- [ ] Define skill format
- [ ] Load skills on demand
- [ ] Agent can create new skills
- [ ] Share skills between sessions

### 8.4 Session Sharing (Multiplayer)

- [ ] User DO for session registry
- [ ] Invite links with access control
- [ ] Presence indicators
- [ ] Cursor sharing in editor

---

## Technical Debt & Revisit

Items to revisit when dependencies stabilize or better solutions emerge.

### Explicit `any` Types

These workarounds were needed due to complex third-party types:

- [ ] `src/agent-tools.ts` - `createTools()` uses `Record<string, any>` for tool registry
  - **Why**: AI SDK tool types are complex generics that don't compose well
  - **Revisit when**: AI SDK improves type exports or we find a cleaner pattern
- [ ] `src/subagent.ts` - `SubagentEnv.LOADER` uses `any`
  - **Why**: WorkerLoader type has complex generic parameters
  - **Revisit when**: We need type safety for LOADER in subagents

- [ ] `src/subagent.ts` - `DurableObjectFacets.get()` uses `any` for class type
  - **Why**: Facets API is experimental and type definitions are incomplete
  - **Revisit when**: Facets become stable with proper type definitions

### Facet Tests

Facets don't work in vitest-pool-workers but DO work in E2E (wrangler dev):

- [x] `e2e/facets.test.ts` - Subagent API and spawn tests (14 passing)
  - **Run with**: `npm run test:e2e`
  - Subagent API availability, spawn endpoint, status tracking all verified

- [ ] `src/__tests__/loader.subagent.test.ts` - Unit tests (skipped by default)
  - **Run with**: `RUN_FACET_TESTS=true` (requires deployed environment)

- [ ] Full subagent LLM execution tests
  - **Requires**: API key for LLM calls
  - **Run with**: `OPENAI_API_KEY=... npm run test:e2e`

### Disabled Features

- [ ] `ENABLE_SUBAGENT_API` flag in `server.ts`
  - **Currently**: `false` (endpoints return 404)
  - **Solution**: E2E tests will set this to `true` via environment variable
  - **Endpoints affected**: `/subagents`, `/subagents/spawn`, `/subagents/:taskId`

---

## Testing Strategy ✓ IMPLEMENTED

**Test Framework**: Vitest with `@cloudflare/vitest-pool-workers`

**Current Test Coverage**: 298 passing, 18 skipped, 22 todo (338 total)

### Core Unit Tests ✓

- [x] Yjs storage: write, read, version tracking, file operations
- [x] File operations: read, write, edit, list, delete
- [x] Bash execution: basic commands, pipes, state persistence
- [x] Edge cases: empty returns, null values, unicode, special characters

### Integration Tests ✓

- [x] LOADER execution: load and run code with multiple module types
- [x] Loopback bindings: dynamic workers call parent (ECHO, BASH, FS, FETCH)
- [x] Error handling: syntax errors, runtime errors, timeouts
- [x] Session isolation: independent state per room

### Tool & Loopback Tests ✓

- [x] just-bash: command execution, stdout/stderr capture, exit codes
- [x] FS loopback: read, write, exists, list, delete, stat
- [x] Fetch loopback: allowlist, method restrictions, request logging
- [x] Brave Search: structure tests (live API tests conditional on `BRAVE_API_KEY`)
- [x] Browser automation: graceful degradation (live tests skipped in vitest-pool-workers)

### Chat API Tests ✓

- [x] HTTP endpoints: `/chat`, `/chat/history`, `/chat/clear`
- [x] History persistence and retrieval
- [x] History clearing

### LLM Agent Tests (Conditional)

Tests run when `OPENAI_API_KEY` is set:

- [x] Simple message response
- [x] Tool usage: listFiles, readFile, bash
- [x] Error handling: missing API key
- [x] Multi-step workflows: create and read file
- [x] Multi-turn conversations

### Running Tests

```bash
# Run all tests (core tests only, no API keys needed)
npm test

# Run with live API tests
OPENAI_API_KEY=sk-xxx BRAVE_API_KEY=xxx npm test

# Run specific test file
npm test -- src/__tests__/loader.test.ts
```

**Key Test Files**:

- `src/__tests__/loader.test.ts` - Comprehensive integration tests (126 tests)

---

## Dependencies Summary

```json
{
  "dependencies": {
    "agents": "workspace:*",
    "yjs": "^13.x",
    "just-bash": "^latest",
    "worker-fs-mount": "^latest",
    "ai": "^latest",
    "@ai-sdk/openai": "^latest",
    "@ai-sdk/anthropic": "^latest",
    "zod": "^3.x"
  },
  "devDependencies": {
    "vitest": "^latest",
    "@monaco-editor/react": "^latest",
    "y-monaco": "^latest"
  }
}
```

---

## Next Action

**Phase 5**: Start UI

- Wire up chat interface to WebSocket
- Show execution results and logs
- Basic code editor with file list

**OR**

**Phase 6**: Advanced Features

- Human-in-the-loop approval for dangerous operations
- Sandbox integration for heavy workloads
- Skills registry for dynamic tool loading

---

## Completed Milestones

1. **Core Runtime** - Dynamic code execution with LOADER binding
2. **Loopback Pattern** - Parent-child communication via ctx.exports
3. **Yjs Storage** - Versioned code storage with SQLite persistence
4. **Bash Tool** - Shell command execution via just-bash
5. **FS Tool** - Basic in-memory file system
6. **Fetch Tool** - Controlled HTTP fetch with allowlists and logging
7. **Web Search** - Brave Search API for web and news queries
8. **Browser Automation** - Playwright-based page browsing, screenshots, interactions
9. **Code Execution** - LOADER-based JavaScript sandbox with module support
10. **LLM Integration** - GPT-5.2 reasoning model with 13 tools and automatic tool loop
11. **Chat History** - SQLite-backed conversation persistence
12. **Architecture Design** - Session, message storage, streaming, and background task patterns
13. **Action Logging** - Audit trail for all tool calls with output summarization
14. **Scheduling Module** - Pure functions for backoff, error classification, recovery (75 tests)

---

## Upcoming Work (Phase 5)

### Priority Order

0. **Action Logging** (5.0) - COMPLETE ✓
   - ✅ Create action_log SQLite table
   - ✅ Add logAction() helper to Agent
   - ✅ Implement output summarization per tool type
   - ✅ Log actions in onStepFinish callback
   - ✅ Add HTTP endpoints (/actions, /actions/clear)
   - ✅ Add tests for action logging

1. **Background Task Scheduling** (5.2) - IN PROGRESS
   - ✅ scheduling.ts module with pure functions
   - ✅ 75 unit tests for recovery logic (scheduling.test.ts)
   - ✅ Slow integration test structure (loader.scheduling.test.ts)
   - **NEXT**: Server integration:
     - Refactor handleChatMessage to use this.schedule()
     - Add executeChat() scheduled method
     - Wire up orphaned task recovery using findOrphanedMessages()
     - Add heartbeat checkpoints for long operations
     - Fill in slow integration tests with real assertions

2. **Message Storage Schema** (5.1)
   - Create new SQLite schema for messages
   - Implement R2 integration for large content
   - Add token counting and truncation helpers

3. **WebSocket Streaming Protocol** (5.3)
   - Define TypeScript types for all message types
   - Switch from generateText() to streamText()
   - Implement delta broadcasting
   - Add reconnection with state replay

### Implementation Notes

- Start with 5.0 (action logging) - simple, foundational, useful immediately
- Then 5.2 (scheduling) since it affects the execution model
- 5.1 (storage) can be developed in parallel with 5.2
- 5.3 (streaming) depends on both and comes last
- All changes should be backwards compatible with existing tests
