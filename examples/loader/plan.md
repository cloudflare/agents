# Implementation Plan: Self-Modifying Coding Agent

## Current Status

- [x] Basic project scaffold with wrangler.jsonc
- [x] LOADER binding configured
- [x] Agent class (Coder) skeleton
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
  - [ ] 5.1 Message Storage Schema
  - [ ] 5.2 Background Task Scheduling
  - [ ] 5.3 WebSocket Streaming Protocol
- [x] **Phase 5.4: Task Management** - COMPLETE
  - [x] tasks.ts module with pure functions (71 tests)
  - [x] LLM task tools (createSubtask, listTasks, completeTask)
  - [x] Orchestration-level root task creation
  - [x] Hybrid approach: orchestration owns lifecycle, LLM can decompose
- [x] **Phase 5.5: Subagent Parallel Execution** - COMPLETE (blocked by facets)
  - [x] Subagent class using DO Facets (src/subagent.ts)
  - [x] SubagentManager for spawning/tracking facets
  - [x] LLM delegation tools (delegateToSubagent, checkSubagentStatus, waitForSubagents)
  - [x] Shared SQLite/Yjs storage, isolated LLM context
  - [ ] **BLOCKED**: Facets don't work in vitest-pool-workers, endpoints disabled
- [ ] **Phase 5.6: Async Tool Calls** - PARTIAL
  - [x] scheduling.ts module with pure functions
  - [x] Recovery logic designed
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
- [ ] Phase 6: Chat UI
- [ ] Phase 7: Code Editor
- [ ] Phase 8: Advanced Features (Multi-Session, Multiplayer)

### Agent Architecture Features Status

| Feature            | Priority | Status         | Module          | Notes                                       |
| ------------------ | -------- | -------------- | --------------- | ------------------------------------------- |
| Task Management    | High     | ✅ Complete    | `tasks.ts`      | 71 tests, LLM tools, hybrid orchestration   |
| Async Tool Calls   | High     | ⚡ Partial     | `scheduling.ts` | Module exists, needs agent loop integration |
| Subagent Pattern   | Medium   | ⚡ Blocked     | `subagent.ts`   | Implemented but facets don't work in tests  |
| Context Compaction | Medium   | ❌ Not Started | `context.ts`    | Summarize older messages                    |
| Streaming Tools    | Low      | ✅ Complete    | Phase 5.8       | text_delta + tool_call/result streaming     |
| Tool Caching       | Low      | ❌ Not Started | -               | Cache expensive results                     |
| Long-term Memory   | Future   | ❌ Not Started | -               | R2/KV for persistent memory                 |

### Architecture Decisions Made

| Decision           | Choice                | Rationale                                    |
| ------------------ | --------------------- | -------------------------------------------- |
| Action Logging     | SQLite, summarized    | Audit trail, debugging, future approval      |
| Session Model      | User DO + Session DO  | Multi-tab/multi-device, future multiplayer   |
| Message Storage    | SQLite + R2 for large | Row limit compliance, full history           |
| Reasoning Text     | Truncated on save     | Stream full, store summary (first 500 chars) |
| Background Tasks   | schedule() API        | Built-in, handles DO evictions, retries      |
| Retry Strategy     | Exponential backoff   | 3 attempts: 2s, 4s, 8s delays                |
| Task Management    | Hierarchical tasks    | Break complex work into subtasks             |
| Subagent Pattern   | DO Facets             | Shared storage, isolated LLM context         |
| Context Compaction | Summarize older msgs  | Keep main agent coherent                     |

---

## Phase 1: Core Runtime Foundation ✓ COMPLETE

**Goal**: Get "load and execute arbitrary code with custom bindings" working end-to-end.

### 1.1 Basic LOADER Execution ✓

**Acceptance Criteria**:

- [x] Can call an HTTP endpoint that loads JS code from a string
- [x] Loaded code executes and returns a result
- [x] Console output is captured and returned

**Implementation**:

- `executeCode(code: string, modules?: Record<string, string>)` in Coder Agent
- `env.LOADER.get()` with unique execution ID
- Harness module wraps user code and captures console.log
- Returns `ExecutionResult` with success, output, logs, errors

**Key Files**:

- `src/server.ts` - Coder Agent with `executeCode()` and `buildHarnessModule()`

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
  http://localhost:8787/agents/coder/test/chat
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
  http://localhost:8787/agents/coder/test/chat
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
- `src/server-without-browser.ts` - `executeCode()` method in Coder Agent

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
  http://localhost:8787/agents/coder/test/chat
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

## Phase 6: Chat UI

**Goal**: Human-usable interface for interacting with the agent.

### 6.1 Chat Interface

**Acceptance Criteria**:

- [ ] Can send messages and see responses
- [ ] Streaming responses display in real-time (text + reasoning)
- [ ] Tool calls visible with expandable details
- [ ] History pagination for long sessions
- [ ] Cancel in-progress operations

**Tasks**:

- [ ] Create ChatPanel component
- [ ] Wire up to useAgent hook
- [ ] Implement message streaming with deltas
- [ ] Show tool call details (collapsible)
- [ ] Add send button and input
- [ ] Add cancel button during execution
- [ ] Implement infinite scroll for history

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

Currently skipped because facets don't work in vitest-pool-workers:

- [ ] `src/__tests__/loader.subagent.test.ts` - "Facet Lifecycle" tests
  - **Run with**: `RUN_FACET_TESTS=true` (requires production environment)
  - **Revisit when**: vitest-pool-workers supports facets or we find a workaround

- [ ] Full subagent integration tests (spawn, track, complete)
  - **Requires**: Both facets working AND API key for LLM calls
  - **Run with**: `RUN_SLOW_TESTS=true RUN_FACET_TESTS=true wrangler dev`

### Disabled Features

- [ ] `ENABLE_SUBAGENT_API` flag in `server-without-browser.ts`
  - **Currently**: `false` (endpoints return 404)
  - **Enable when**: Facets work reliably in production
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
