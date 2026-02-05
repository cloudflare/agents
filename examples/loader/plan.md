# Implementation Plan

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
- [x] **Phase 4: Agent Loop (LLM integration)** - COMPLETE
- [ ] Phase 5: UI
- [ ] Phase 6: Advanced Features

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

---

## Phase 4: Agent Loop ✓ COMPLETE

**Goal**: Wire up an LLM that can use the tools.

### 4.1 LLM Integration ✓

**Acceptance Criteria**:

- [x] Can send messages to LLM and get responses
- [ ] Streaming responses work (TODO - using generateText, not streamText)
- [ ] Multiple model providers supported (TODO - only OpenAI currently)

**Implementation**:

- AI SDK v6 (`ai@6.0.70`) with OpenAI adapter (`@ai-sdk/openai@3.0.25`)
- Using `gpt-4o` model for best coding performance
- `generateText()` with automatic tool loop via `stopWhen: stepCountIs(N)`

**Key Files**:

- `src/server.ts` - OpenAI client setup, `handleChatMessage()` with agent loop

### 4.2 Tool Definitions ✓

**Acceptance Criteria**:

- [x] Tools are defined with Zod schemas
- [x] LLM can call tools and get results
- [x] Multi-step tool use works

**Implementation**:

Created 6 tools in `src/agent-tools.ts`:

- `bash` - Execute shell commands via just-bash loopback
- `readFile` - Read files from Yjs storage
- `writeFile` - Create/overwrite files in Yjs storage
- `editFile` - Search-and-replace edits in files
- `listFiles` - List all project files
- `fetch` - Controlled HTTP requests via fetch loopback

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

## Phase 5: UI

**Goal**: Human-usable interface for interacting with the agent.

### 5.1 Chat Interface

**Acceptance Criteria**:

- [ ] Can send messages and see responses
- [ ] Streaming responses display in real-time
- [ ] Tool calls are visible
- [ ] Can start/stop agent

**Tasks**:

- [ ] Create ChatPanel component
- [ ] Wire up to useAgent hook
- [ ] Display messages with proper formatting
- [ ] Show tool call details (collapsible)
- [ ] Add send button and input

### 5.2 Code Editor

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

### 5.3 Status & Actions

**Acceptance Criteria**:

- [ ] Agent status visible (idle, thinking, executing)
- [ ] Action log visible
- [ ] Can approve/reject pending actions (future)

**Tasks**:

- [ ] Create StatusBar component
- [ ] Create ActionLog component
- [ ] Wire up to Agent state

---

## Phase 6: Advanced Features (Future)

### 6.1 Human-in-the-Loop Approval

- [ ] Actions can require approval
- [ ] Approval UI inline in chat
- [ ] Timeout handling for pending approvals

### 6.2 Sandbox Integration

- [ ] Detect when sandbox is needed
- [ ] Spin up sandbox for heavy operations
- [ ] Handle sandbox lifecycle

### 6.3 Skills Registry

- [ ] Define skill format
- [ ] Load skills on demand
- [ ] Agent can create new skills
- [ ] Share skills between sessions

### 6.4 Persistence & Wake/Sleep

- [ ] Save continuation on timeout
- [ ] Resume from continuation
- [ ] Handle webhook triggers
- [ ] Scheduled tasks via alarms

---

## Testing Strategy

### Unit Tests

- [ ] Yjs storage: write, read, replay
- [ ] File operations: read, write, edit
- [ ] Bash execution: basic commands
- [ ] Tool definitions: schema validation

### Integration Tests

- [ ] LOADER execution: load and run code
- [ ] Loopback bindings: dynamic worker calls parent
- [ ] Full tool call: LLM → tool → result

### E2E Tests

- [ ] Chat flow: message → agent → response
- [ ] Code editing: human edit → sync → agent sees
- [ ] Multi-step: complex task with multiple tools

**Test Framework**: Vitest

**Key Test Files**:

- `src/__tests__/yjs-storage.test.ts`
- `src/__tests__/loader.test.ts`
- `src/__tests__/tools.test.ts`
- `src/__tests__/agent.test.ts`

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
7. **LLM Integration** - GPT-4o agent with 6 tools and automatic tool loop
8. **Chat History** - SQLite-backed conversation persistence
