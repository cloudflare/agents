# Cloud-Native Coding Agent Runtime

## Implementation Status

| Component          | Status      | Notes                                         |
| ------------------ | ----------- | --------------------------------------------- |
| Coder Agent (DO)   | ✅ Complete | Full Agent class with state, SQL, WebSocket   |
| LOADER Execution   | ✅ Complete | Dynamic worker loading with harness           |
| Loopback Pattern   | ✅ Complete | EchoLoopback, BashLoopback, FSLoopback        |
| Timeouts & Errors  | ✅ Complete | Configurable timeout, error categorization    |
| Yjs Storage        | ✅ Complete | SQLite persistence, versioning, snapshots     |
| File Operations    | ✅ Complete | read/write/edit/delete via Yjs                |
| just-bash          | ✅ Complete | Shell commands in isolates                    |
| In-memory FS       | ✅ Complete | Scratch space for temp files                  |
| WebSocket Sync     | ⚡ Partial  | Binary broadcast, needs full Yjs protocol     |
| Controlled Fetch   | ✅ Complete | URL/method allowlist, request logging         |
| Web Search         | ✅ Complete | Brave Search API, web + news search           |
| Browser Automation | ✅ Complete | Playwright, browse/screenshot/interact/scrape |
| Code Execution     | ✅ Complete | LOADER-based JS sandbox, module support       |
| LLM Integration    | ✅ Complete | GPT-5.2, 13 tools, auto tool loop, reasoning  |
| Action Logging     | ✅ Complete | Audit trail for all tool calls                |
| Message Storage    | ❌ Planned  | One row per message, R2 for large content     |
| Streaming Protocol | ❌ Planned  | Fine-grained WebSocket events                 |
| Background Tasks   | ⚡ Building | schedule() API, recovery logic module         |
| Task Management    | ✅ Complete | Hierarchical tasks, dependencies, LLM tools   |
| Subagent Parallel  | ✅ Complete | DO Facets, parallel execution, delegation     |
| UI                 | ❌ Planned  | Chat, code editor, status                     |
| Sandbox            | ❌ Planned  | Full VM for heavy workloads                   |

---

## Overview

This project implements a **cloud-native coding agent runtime** built on Cloudflare's infrastructure. It enables AI agents to write, execute, and iterate on code in a secure, isolated environment—similar to what local coding agents like Pi, OpenClaw, and Claude Code do on a developer's machine, but running entirely on the edge.

The core insight: **coding agents are replacing agent frameworks**. Instead of orchestrating tools through structured APIs, agents that can read/write files and execute code can accomplish almost anything. This project brings that capability to Cloudflare Workers.

## Inspiration

### Pi (pi.dev)

- Minimal core: just 4 tools (Read, Write, Edit, Bash)
- Self-modifying: agent can extend itself by writing extensions
- Hot reloading: changes take effect immediately
- Sessions are trees: can branch, rewind, navigate history

### OpenClaw (openclaw.ai)

- Personal AI assistant that runs on your machine
- Can pull down skills and tools dynamically
- Connected to communication channels (Telegram, Discord, etc.)
- Celebrates "code writing code"

### Minions (AI Gadgets)

- Overseer pattern: supervisor DO that loads Gadget code via LOADER
- Gatekeeper pattern: security boundary for external APIs
- Yjs for code storage: CRDT-based, real-time collaborative editing
- Loopback bindings: pass capabilities to dynamic workers via ctx.exports
- Human-in-the-loop: action approval queue

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Coder Agent (Durable Object)                        │
│                     extends Agent<Env, CoderState>                      │
│                                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │   State     │  │   SQLite    │  │  Scheduler  │  │   WebSocket   │  │
│  │ this.state  │  │  this.sql   │  │this.schedule│  │  onMessage()  │  │
│  │             │  │             │  │             │  │  onConnect()  │  │
│  │ - session   │  │ - chat log  │  │ - timeouts  │  │               │  │
│  │ - files     │  │ - versions  │  │ - cron jobs │  │  Real-time    │  │
│  │ - context   │  │ - actions   │  │ - reminders │  │  chat & sync  │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  └───────────────┘  │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                        Yjs Document                              │   │
│  │  Y.Map<Y.Text> mapping filenames → content                       │   │
│  │  - Full version history                                          │   │
│  │  - Real-time multiplayer sync                                    │   │
│  │  - Merge/revert support                                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Loopback Bindings                            │   │
│  │  ctx.exports.BashLoopback({props})   → just-bash execution       │   │
│  │  ctx.exports.FSLoopback({props})     → worker-fs-mount ops       │   │
│  │  ctx.exports.FetchLoopback({props})  → controlled network        │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    env.LOADER.get(id, () => WorkerCode)
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Dynamic Worker (Isolate)                             │
│                                                                         │
│  Loaded via LOADER binding with:                                        │
│  - mainModule: entry point                                              │
│  - modules: { "file.js": "code..." }                                    │
│  - env: loopback bindings to parent                                     │
│  - globalOutbound: null (no direct network)                             │
│                                                                         │
│  Characteristics:                                                       │
│  - Ephemeral: can be evicted at any time                               │
│  - Sandboxed: only access what we explicitly provide                    │
│  - Fast: millisecond cold starts                                        │
│  - Cached: same ID may reuse warm isolate                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    When isolates aren't enough...
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Cloudflare Sandbox (VM)                              │
│                                                                         │
│  Full Linux environment for heavy operations:                           │
│  - Binary execution (ffmpeg, python, etc.)                              │
│  - Real filesystem operations                                           │
│  - Long-running processes                                               │
│  - Could even run another coding agent (opencode, etc.)                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key Patterns

### 1. The Loopback Binding Pattern

Dynamic workers loaded via LOADER can't receive RpcStubs directly. Instead, we pass ServiceStubs that "loop back" through ctx.exports:

```typescript
// In the Coder Agent
getEnvForLoader(): Record<string, Fetcher> {
  return {
    BASH: this.ctx.exports.BashLoopback({ props: { sessionId: this.sessionId } }),
    FS: this.ctx.exports.FSLoopback({ props: { sessionId: this.sessionId } }),
    // ... other tools
  };
}

// BashLoopback is a WorkerEntrypoint that proxies to just-bash
export class BashLoopback extends WorkerEntrypoint<Env, LoopbackProps> {
  async exec(command: string): Promise<BashResult> {
    // Access the bash instance via the parent Agent
    // props.sessionId identifies which session this belongs to
    return this.runBashCommand(command);
  }
}
```

### 2. Yjs for Code Storage

Code is stored as a Yjs document, enabling:

- **Version history**: Every change is tracked
- **Multiplayer editing**: Human and agent can edit simultaneously
- **Branching**: Proposed changes can be tested before merge
- **Conflict resolution**: CRDTs handle concurrent edits

Structure:

```
Y.Doc
└── Y.Map<Y.Text> (root)
    ├── "server.js" → Y.Text("export default { ... }")
    ├── "client.js" → Y.Text("const app = ... ")
    └── "README.md" → Y.Text("# My Project")
```

Version IDs include code version: `{agentId}.{codeVersion}` so code changes create new isolates.

### 3. Ephemeral vs Persistent Execution

**Ephemeral (one-off)**: For tool calls, quick computations

- Random ID: `LOADER.get(crypto.randomUUID(), ...)`
- No state preservation
- Used for: bash commands, code evaluation, tool execution

**Persistent (session-based)**: For running applications

- Stable ID: `LOADER.get(`${agentId}.${version}`, ...)`
- May reuse warm isolate
- Used for: running the user's Gadget/app

### 4. The Continuation Model (for Human-in-the-Loop)

When the agent needs to wait (user approval, external event, timer), it saves a **continuation**:

```typescript
interface Continuation {
  // What are we waiting for?
  waitingFor:
    | { type: "user_input"; prompt: string; schema?: JSONSchema }
    | { type: "approval"; action: ActionDescription }
    | { type: "webhook"; path: string }
    | { type: "timer"; at: Date };

  // Context to restore
  context: {
    conversationId: string;
    localState: Record<string, any>;
  };

  // What to do when resumed
  resumeWith: string;
}
```

When the event arrives, the Agent:

1. Loads the continuation from SQLite
2. Spins up a new dynamic worker
3. Provides: conversation history + continuation context + new event
4. Agent continues reasoning

## Security Model

### Isolation Layers

1. **Dynamic Worker Isolation**
   - `globalOutbound: null` blocks all network access
   - Only access to explicitly provided `env` bindings
   - Cannot access parent's storage directly

2. **Loopback Control**
   - Each tool binding can enforce its own security
   - Bash: execution limits, command filtering
   - FS: path restrictions, quota limits
   - Fetch: URL allowlists, method restrictions

3. **Action Approval** (Future)
   - Side-effecting actions can require human approval
   - Audit log of all actions
   - Revert capability for applied actions

### What Dynamic Workers CAN Access

- Tools we explicitly provide via env bindings
- Code modules we load into the isolate
- Cloudflare APIs available in Workers (crypto, etc.)

### What Dynamic Workers CANNOT Access

- The internet (globalOutbound: null)
- Parent Agent's storage
- Other Durable Objects
- Secrets/environment variables (unless passed)

---

## Action Logging

All tool calls are logged to SQLite for audit trail, debugging, and future approval system integration.

### Schema

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
  message_id TEXT,

  -- Indexes for common queries
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX idx_action_log_session ON action_log(session_id, timestamp);
CREATE INDEX idx_action_log_tool ON action_log(tool, timestamp);
CREATE INDEX idx_action_log_message ON action_log(message_id);
```

### Fields

| Field          | Type    | Description                                               |
| -------------- | ------- | --------------------------------------------------------- |
| id             | TEXT    | UUID for this action                                      |
| session_id     | TEXT    | Session that triggered the action                         |
| timestamp      | INTEGER | Unix timestamp in milliseconds                            |
| tool           | TEXT    | Tool name (bash, readFile, webSearch, etc.)               |
| action         | TEXT    | Specific action (execute, read, search, etc.)             |
| input          | TEXT    | JSON-serialized input parameters (truncated if large)     |
| output_summary | TEXT    | Summary of output (first 500 chars or structured summary) |
| duration_ms    | INTEGER | Execution time in milliseconds                            |
| success        | INTEGER | 1 for success, 0 for failure                              |
| error          | TEXT    | Error message if failed                                   |
| message_id     | TEXT    | Optional link to the chat message that triggered this     |

### Logging Strategy

**What we log:**

- All loopback method calls (bash.execute, fs.read, fetch, etc.)
- Tool-level metadata, not raw content for large outputs
- Errors with stack traces (truncated)

**What we DON'T log:**

- Full file contents (just filename and size)
- Full HTTP responses (just status, headers, size)
- Full browser page content (just URL, title, element count)

**Output Summarization:**

```typescript
function summarizeOutput(
  tool: string,
  action: string,
  output: unknown
): string {
  if (typeof output === "string" && output.length > 500) {
    return output.slice(0, 500) + `... (${output.length} chars)`;
  }
  if (tool === "bash") {
    const result = output as BashResult;
    return `exit=${result.exitCode}, stdout=${result.stdout.length} chars`;
  }
  if (tool === "fetch") {
    const result = output as FetchResult;
    return `${result.status} ${result.statusText}, ${result.body?.length || 0} bytes`;
  }
  // Default: JSON stringify with truncation
  const json = JSON.stringify(output);
  return json.length > 500 ? json.slice(0, 500) + "..." : json;
}
```

### Integration Points

1. **Loopback methods**: Log before/after each operation
2. **Agent tools**: Link actions to the originating message_id
3. **WebSocket**: Optionally broadcast action events to connected clients
4. **API**: Endpoint to query action log with filters

### Future: Approval Integration

Action logging is the foundation for the approval system. When approval is added:

```typescript
// Current (logging only)
async execute(command: string): Promise<BashResult> {
  const actionId = await this.logActionStart('bash', 'execute', { command });
  try {
    const result = await this.bash.execute(command);
    await this.logActionComplete(actionId, result);
    return result;
  } catch (error) {
    await this.logActionError(actionId, error);
    throw error;
  }
}

// Future (with approval)
async execute(command: string): Promise<BashResult> {
  const action = { tool: 'bash', action: 'execute', input: { command } };

  if (await this.requiresApproval(action)) {
    return this.queueForApproval(action);
  }

  // ... same as current
}
```

---

## Task Management

For complex multi-step work, the agent can decompose requests into hierarchical tasks with dependencies.

### Module: `src/tasks.ts`

Pure functions for task management (71 unit tests):

```typescript
// Create and manage task graph
createTaskGraph(): TaskGraph
createTask(input: CreateTaskInput): Task
addTask(graph: TaskGraph, task: Task): TaskGraph | ValidationError

// Status transitions
startTask(graph, taskId, assignedTo?): TaskGraph | null
completeTask(graph, taskId, result?): TaskGraph | null
failTask(graph, taskId, error): TaskGraph | null
cancelTask(graph, taskId): TaskGraph | null

// Dependency resolution
areDependenciesSatisfied(graph, task): boolean
getReadyTasks(graph): Task[]        // Pending tasks with all deps satisfied
getActiveTasks(graph): Task[]       // In-progress tasks
getBlockedTasks(graph): Task[]      // Blocked by failed dependency

// Tree operations
getTaskTree(graph): TaskTreeNode[]
getDescendants(graph, taskId): Task[]
getAncestors(graph, taskId): Task[]

// Progress tracking
getProgress(graph): TaskProgress    // {total, pending, complete, percentComplete, ...}
getSubtreeProgress(graph, rootId): TaskProgress
```

### Task Schema

```typescript
interface Task {
  id: string;
  parentId?: string; // Hierarchical parent
  type: "explore" | "code" | "test" | "review" | "plan" | "fix";
  title: string;
  description?: string;
  status:
    | "pending"
    | "in_progress"
    | "blocked"
    | "complete"
    | "failed"
    | "cancelled";
  dependencies: string[]; // Must complete before this task can start
  result?: string;
  error?: string;
  assignedTo?: string; // Subagent/DO id for delegation
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}
```

### Configuration

```typescript
const TASK_CONFIG = {
  maxDepth: 3, // Don't break down more than 3 levels
  maxSubtasks: 10, // Max children per task
  maxTotalTasks: 50 // Prevent runaway decomposition
};
```

### Validation

Adding tasks validates:

- No duplicate IDs
- Parent task exists (if specified)
- All dependencies exist
- Max depth not exceeded
- Max subtasks not exceeded
- Max total tasks not exceeded
- No cycles in dependencies

### Automatic Status Updates

- **On complete**: Dependent tasks that were blocked may become pending
- **On fail/cancel**: Dependent tasks become blocked

### SQLite Integration

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  dependencies TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  error TEXT,
  assigned_to TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
```

Helper functions for row conversion:

```typescript
taskToRow(task: Task): SQLiteRow
rowToTask(row: SQLiteRow): Task
serializeGraph(graph: TaskGraph): Task[]
deserializeGraph(tasks: Task[]): TaskGraph
```

### Hybrid Task Management

The system uses a **hybrid approach** where orchestration owns the lifecycle, but the LLM can optionally decompose:

1. **Orchestration creates root task**: When user sends a message, a root task is automatically created
2. **LLM has optional task tools**: `createSubtask`, `listTasks`, `completeTask`
3. **Progress visible either way**: Single task = streaming output, multiple subtasks = progress tracking

```typescript
// Orchestration (automatic)
const rootTask = this.createRootTask(content);
startTask(this.taskGraph, rootTask.id);

// LLM (optional) - can break down complex work
createSubtask({ type: "explore", title: "Research options" });
createSubtask({ type: "code", title: "Implement backend", dependencies: [...] });
```

**When to use task tools:**

- Substantial work with 3+ distinct steps
- Work has dependencies (frontend depends on backend)
- User would benefit from seeing progress

**When NOT to use:**

- Simple, quick tasks
- Single-file changes
- One or two tool calls to complete

## Subagent Parallel Execution

For truly independent subtasks, work can be delegated to subagents that run in parallel using Durable Object Facets.

### Module: `src/subagent.ts`

Implements parallel task execution:

```typescript
// Subagent class - runs as a facet with isolated LLM context
export class Subagent extends DurableObject<SubagentEnv> {
  async execute(params: {
    taskId: string;
    title: string;
    description: string;
    context?: string;
    parentSessionId: string;
  }): Promise<SubagentResult>;

  getStatus(): SubagentStatus | null;
}

// Manager - spawns and tracks subagent facets from parent
export class SubagentManager {
  async spawnSubagent(task: Task, context?: string): Promise<string>;
  async getSubagentStatus(taskId: string): Promise<SubagentStatus | null>;
  async getAllStatuses(): Promise<SubagentStatus[]>;
  abortSubagent(taskId: string): void;
  deleteSubagent(taskId: string): void;
  get activeCount(): number;
}
```

### How It Works

1. **Facet Architecture**: Each subagent runs as a facet of the parent Coder DO
   - Shares SQLite storage (task graph, file system)
   - Has isolated LLM context (focused system prompt)
   - Runs truly in parallel with parent and other facets

2. **Task Delegation Flow**:

   ```typescript
   // Parent creates subtask
   const task = createSubtask({ type: "explore", title: "Research options" });

   // Parent delegates to subagent
   await delegateToSubagent({
     taskId: task.id,
     title: "Research options",
     description: "Find the best approach for...",
     context: "We're using TypeScript and Cloudflare Workers"
   });

   // Parent continues other work while subagent runs...

   // Check status or wait for completion
   const status = await checkSubagentStatus(task.id);
   const results = await waitForSubagents();
   ```

3. **Subagent Execution**:
   - Gets focused system prompt (just the task description)
   - Runs limited agent loop (max 15 steps)
   - Updates shared task graph on completion/failure
   - Reports result back to parent

### LLM Tools for Delegation

```typescript
// Delegate work to a parallel subagent
delegateToSubagent({
  taskId: string;    // Must be an existing subtask
  title: string;     // Brief title for the work
  description: string; // Detailed description (subagent has limited context!)
  context?: string;  // Optional extra context
});

// Check on delegated work
checkSubagentStatus({ taskId: string });

// Wait for all active subagents to finish
waitForSubagents();
```

### When to Delegate

**Good for delegation:**

- Independent file operations
- Parallel searches or explorations
- Tests that can run concurrently
- Refactoring that doesn't affect current work

**Not good for delegation:**

- Tasks depending on work still in progress
- Tasks needing the current conversation context
- Sequential work where order matters
- Very simple tasks (overhead not worth it)

### Shared vs Isolated

| Resource      | Shared    | Isolated         |
| ------------- | --------- | ---------------- |
| SQLite        | ✅ Yes    |                  |
| Task Graph    | ✅ Yes    |                  |
| Yjs Storage   | ✅ Yes    |                  |
| LLM Context   |           | ✅ Yes           |
| System Prompt |           | ✅ Yes (focused) |
| Tool Calls    | ✅ Logged |                  |

---

## Tools

### Core Tools (Phase 3)

| Tool                 | Implementation       | Purpose                                 |
| -------------------- | -------------------- | --------------------------------------- |
| **bash**             | just-bash            | Shell commands in virtual FS            |
| **fs**               | worker-fs-mount      | File operations (read, write, mkdir)    |
| **fetch**            | Controlled loopback  | HTTP requests with allowlist            |
| **webSearch**        | Brave Search API     | Search the web for docs and info        |
| **newsSearch**       | Brave Search API     | Find recent news and announcements      |
| **browseUrl**        | Playwright + Browser | Browse pages and extract content        |
| **screenshot**       | Playwright + Browser | Take screenshots of web pages           |
| **interactWithPage** | Playwright + Browser | Click, type, navigate on pages          |
| **scrapePage**       | Playwright + Browser | Extract elements via CSS selectors      |
| **executeCode**      | LOADER binding       | Run JavaScript in sandboxed environment |

### Extended Tools (Future)

| Tool        | Implementation         | Purpose                             |
| ----------- | ---------------------- | ----------------------------------- |
| **sandbox** | Cloudflare Sandbox SDK | Full VM when isolates aren't enough |

### Agent Tools (Phase 4)

These are the tools exposed to the LLM:

```typescript
tools: {
  readFile: tool({
    description: "Read a file from the workspace",
    inputSchema: z.object({ path: z.string() }),
    execute: ({ path }) => fs.readFile(path, 'utf8'),
  }),

  writeFile: tool({
    description: "Write content to a file",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: ({ path, content }) => fs.writeFile(path, content),
  }),

  bash: tool({
    description: "Execute a bash command",
    inputSchema: z.object({ command: z.string() }),
    execute: ({ command }) => bash.exec(command),
  }),

  // ... more tools
}
```

## Session Architecture

### Single User, Multi-Tab/Multi-Device

The architecture supports one user across multiple browser tabs and devices, plus background execution:

```
User DO (user-123)              Session DO (session-xyz)
├── session registry            ├── ownerId: "user-123"
├── preferences                 ├── Yjs doc (code)
└── usage tracking              ├── messages
                                ├── connections: [tab1, tab2, phone]
                                └── background tasks via schedule()
```

**Key Points:**

- **User DO**: Minimal - just session list and preferences
- **Session DO**: Full agent with tools, code, chat
- **Direct connection**: Clients connect directly to Session DO via WebSocket
- **No multiplayer**: Just multi-tab for same user (simpler auth)

### Session Ownership

```typescript
async onConnect(connection: Connection, ctx: ConnectionContext) {
  const userId = await this.authenticate(ctx.request);

  // First connection sets owner, subsequent must match
  if (!this.ownerId) {
    this.ownerId = userId;
  } else if (userId !== this.ownerId) {
    return connection.close(4403, "Forbidden");
  }

  // Allow - just another tab/device
  this.connections.add(connection);
}
```

## Message Storage

### Design Principles

1. **One row per message** - Easy to query, paginate, index
2. **R2 for large content** - Images, attachments, large tool results
3. **Summary + preview inline** - Quick display without R2 fetch
4. **Truncate reasoning** - Full during stream, truncated for storage

### Schema

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,                  -- 'user' | 'assistant'

  -- Content (inline if small, R2 if large)
  content TEXT,
  content_r2_key TEXT,

  -- Tool calls
  tool_calls JSON,                     -- Array of { id, tool, input }
  tool_results_summary TEXT,           -- "Read file.txt (15KB)"
  tool_results_preview TEXT,           -- First 500 chars
  tool_results_r2_key TEXT,            -- Full content if large

  -- Reasoning (truncated to ~3KB)
  reasoning TEXT,
  reasoning_full_size INTEGER,         -- Original size for UI indicator

  -- Status & lifecycle
  status TEXT DEFAULT 'pending',       -- pending, streaming, complete, error, cancelled
  error TEXT,

  -- Scheduling
  task_id TEXT,                        -- Links to scheduled task
  checkpoint TEXT,                     -- For resuming interrupted work
  heartbeat_at INTEGER,                -- Last heartbeat timestamp

  -- Metadata
  timestamp INTEGER NOT NULL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  model TEXT,

  -- For retry chains
  attempt INTEGER DEFAULT 1,
  parent_id TEXT
);

CREATE INDEX idx_messages_status ON messages(status);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
```

### Tool Results Strategy

| Size   | Storage                                | Display                        |
| ------ | -------------------------------------- | ------------------------------ |
| < 50KB | Inline in `tool_results_preview`       | Show directly                  |
| > 50KB | R2, reference in `tool_results_r2_key` | Show summary + "Expand" button |
| Images | Always R2                              | Thumbnail + "View full"        |

```typescript
function summarizeToolResult(toolName: string, result: unknown): string {
  const full = JSON.stringify(result);
  if (full.length < 10000) return full;

  switch (toolName) {
    case "readFile":
      return `[File content: ${full.length} chars]\n${full.slice(0, 500)}...`;
    case "bash":
      return `[Output: ${full.length} chars]\n${full.slice(0, 1000)}...`;
    default:
      return `[Large result: ${full.length} chars]`;
  }
}
```

### Reasoning Storage

- **During stream**: Broadcast full reasoning to connected clients
- **After completion**: Truncate to ~3KB for storage
- **On reconnect**: Show truncated with "[X KB original]" indicator

```typescript
function truncateReasoning(reasoning: string, maxLength = 3000): string {
  if (reasoning.length <= maxLength) return reasoning;
  return (
    reasoning.slice(0, maxLength) +
    `\n\n[Reasoning truncated - ${reasoning.length} chars original]`
  );
}
```

## WebSocket Streaming Protocol

The agent uses `streamText()` from the AI SDK to stream LLM responses in real-time.
This provides a significantly better user experience as text appears character-by-character
rather than waiting for the entire response.

### Message Types

```typescript
type WSMessage =
  // Status updates
  | { type: "status"; status: "idle" | "thinking" | "executing" }

  // Streaming text content (sent as chunks arrive)
  | { type: "text_delta"; delta: string }

  // Stream completion signal
  | { type: "text_done" }

  // Reasoning summary (GPT-5 models with reasoningEffort enabled)
  | { type: "reasoning"; content: string }

  // Tool execution (streaming - sent as tools are called)
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; name: string; output: unknown }

  // Legacy batch format (still supported for compatibility)
  | {
      type: "tool_calls";
      calls: Array<{ id: string; name: string; input: unknown }>;
    }

  // Final complete message (sent after stream finishes)
  | { type: "chat"; message: { role: "assistant"; content: string } }

  // Errors
  | { type: "error"; error: string }

  // Connection lifecycle
  | { type: "history"; messages: StoredMessage[] }
  | { type: "sync"; state: AgentState }

  // Background tasks
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

### Streaming Flow

```
User sends message
       │
       ▼
Server: save to DB, schedule(0, "executeChat", {...})
       │
       ▼
executeChat() runs:
  ├── broadcast({ type: 'status', status: 'thinking' })
  │
  ├── for each LLM stream part:
  │   ├── text-delta → broadcast to all tabs
  │   ├── reasoning-delta → broadcast to all tabs
  │   ├── tool-call → broadcast start, execute, broadcast result
  │   └── checkpoint periodically
  │
  └── broadcast({ type: 'message-complete', message })
```

### Reconnection

```typescript
async onConnect(connection: Connection) {
  // 1. Authenticate & verify ownership
  // 2. Send current state
  connection.send(JSON.stringify({ type: 'sync', state: this.state }));

  // 3. Send recent message history
  const recent = await this.getRecentMessages(50);
  connection.send(JSON.stringify({ type: 'history', messages: recent }));

  // 4. If agent is mid-execution, send pending state
  if (this.pendingMessage) {
    connection.send(JSON.stringify({
      type: 'pending-message',
      message: this.pendingMessage
    }));
  }
}
```

## Background Task Resilience

### Using schedule() API

The Agent SDK's `schedule()` provides durable task execution:

```typescript
// Enqueue work - survives DO eviction
await this.schedule(0, "executeChat", {
  messageId,
  content,
  attempt: 1,
  maxAttempts: 3
});

// The method is called automatically
async executeChat(payload: { messageId: string; content: string; attempt: number }) {
  try {
    await this.runAgentLoop(payload);
  } catch (error) {
    await this.handleError(payload, error);
  }
}

// Retry with exponential backoff
async handleError(payload, error) {
  if (payload.attempt >= payload.maxAttempts) {
    await this.markFailed(payload.messageId, error);
  } else {
    const delay = Math.pow(2, payload.attempt); // 2s, 4s, 8s
    await this.schedule(delay, "executeChat", {
      ...payload,
      attempt: payload.attempt + 1
    });
  }
}
```

### Heartbeat for Long Operations

```typescript
async runAgentLoop(messageId: string, content: string) {
  // Schedule heartbeat to detect eviction
  let heartbeat = await this.schedule(30, "checkHeartbeat", { messageId });

  try {
    for await (const part of result.fullStream) {
      // Refresh heartbeat
      await this.cancelSchedule(heartbeat.id);
      heartbeat = await this.schedule(30, "checkHeartbeat", { messageId });

      // Checkpoint progress
      await this.checkpointMessage(messageId, accumulated);

      // Stream to clients
      this.broadcast(...);
    }
  } finally {
    await this.cancelSchedule(heartbeat.id);
  }
}
```

### Recovery on Reconnect

```typescript
async recoverOrphanedTasks() {
  // Find messages that were streaming but heartbeat expired
  const orphaned = await this.sql.exec(`
    SELECT * FROM messages
    WHERE status = 'streaming'
      AND heartbeat_at < ?
  `, Date.now() - 60000).toArray();

  for (const msg of orphaned) {
    // Re-queue the work
    await this.schedule(0, "resumeOrRetry", {
      messageId: msg.id,
      checkpoint: msg.checkpoint
    });
  }
}
```

## State Management

### Agent State (this.state)

Synced to connected clients via WebSocket:

```typescript
interface CoderState {
  // Current session
  sessionId: string;

  // What's the agent doing?
  status: "idle" | "thinking" | "executing" | "waiting";

  // Current file being edited (for UI focus)
  activeFile?: string;

  // Pending continuation (if waiting)
  pendingContinuation?: Continuation;
}
```

### Key Principle

**Treat the DO as ephemeral, SQLite as durable.**

- Never trust in-memory state for anything critical
- Persist to SQLite before acknowledging operations
- Rebuild in-memory state from SQLite on restart

## Client Integration

### React Hook

```tsx
import { useAgent } from "agents/react";

function CoderInterface() {
  const [messages, setMessages] = useState([]);

  const agent = useAgent({
    agent: "coder",
    name: sessionId,
    onMessage: (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === "chat") {
        setMessages((prev) => [...prev, data.message]);
      }
    },
    onStateUpdate: (state) => {
      // State synced from Agent
    }
  });

  const sendMessage = (content: string) => {
    agent.send(JSON.stringify({ type: "chat", content }));
  };

  return (
    <div>
      <ChatPanel messages={messages} onSend={sendMessage} />
      <CodeEditor yDoc={yDoc} /> {/* Yjs-synced editor */}
    </div>
  );
}
```

### Yjs Sync

The Yjs document syncs via WebSocket alongside chat:

```typescript
// In the Agent
onMessage(connection, message) {
  const data = JSON.parse(message);

  if (data.type === "yjs-update") {
    // Apply client's Yjs update
    Y.applyUpdateV2(this.yDoc, data.update);
    // Broadcast to other clients
    this.broadcast(message, [connection]);
  }

  if (data.type === "chat") {
    // Handle chat message, potentially trigger agent
  }
}
```

## Future: Skills Registry

_Parked for later implementation_

The architecture is designed to support a skills registry where:

- Skills are reusable code+prompt packages
- Agent can discover and load skills on demand
- Skills can be shared across sessions
- Skills can be auto-generated by the agent

This would extend the `modules` passed to LOADER:

```typescript
modules: {
  "main.js": mainCode,
  "skill-web-search.js": await loadSkill("web-search"),
  "skill-git.js": await loadSkill("git-operations"),
  // ...
}
```

## Testing Infrastructure

The project uses `@cloudflare/vitest-pool-workers` for integration testing, which runs tests in an isolated Cloudflare Workers runtime.

### Test Coverage

| Category              | Tests   | Status                         |
| --------------------- | ------- | ------------------------------ |
| Core LOADER Execution | 18      | ✅                             |
| Yjs Storage           | 8       | ✅                             |
| Loopback Bindings     | 15      | ✅                             |
| Error Handling        | 12      | ✅                             |
| Edge Cases            | 15      | ✅                             |
| Session Isolation     | 4       | ✅                             |
| Chat API              | 5       | ✅                             |
| Tool Definitions      | 7       | ✅                             |
| Web Search (Brave)    | 5       | ⏳ (conditional)               |
| Browser Automation    | 5       | ⏳ (skipped in test env)       |
| LLM Agent             | 8       | ⏳ (conditional)               |
| Task Management       | 71      | ✅                             |
| Scheduling            | 75      | ✅                             |
| **Total**             | **272** | 258 passing, 6 skipped, 8 todo |

### Running Tests

```bash
# Run core tests (no API keys needed)
npm test

# Run with live API integration tests
OPENAI_API_KEY=sk-xxx BRAVE_API_KEY=xxx npm test
```

### Test Design Patterns

- **Conditional skipping**: Tests requiring API keys use `describe.skipIf(!hasApiKey)`
- **Graceful degradation tests**: Verify tools return informative errors when services unavailable
- **Session isolation tests**: Verify independent state per room/agent instance
- **Edge case coverage**: Unicode, empty content, special characters, error propagation

### Known Limitations

- **Browser tests**: `@cloudflare/playwright` cannot run in `vitest-pool-workers` due to Node.js dependencies
- **Live API tests**: Require actual API keys and make real network calls
- **Cost awareness**: LLM tests consume API tokens; use sparingly in CI

## References

- [Cloudflare Worker Loader API](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents)
- [Pi Coding Agent](https://pi.dev/)
- [OpenClaw](https://openclaw.ai/)
- [just-bash](https://github.com/vercel-labs/just-bash)
- [worker-fs-mount](https://github.com/danlapid/worker-fs-mount)
- [Yjs](https://docs.yjs.dev/)
