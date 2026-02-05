# Project Think - Cloud-Native Coding Agent Runtime

## Implementation Status

| Component          | Status      | Notes                                          |
| ------------------ | ----------- | ---------------------------------------------- |
| Think Agent (DO)   | ✅ Complete | Full Agent class with state, SQL, WebSocket    |
| LOADER Execution   | ✅ Complete | Dynamic worker loading with harness            |
| Loopback Pattern   | ✅ Complete | EchoLoopback, BashLoopback, FSLoopback         |
| Timeouts & Errors  | ✅ Complete | Configurable timeout, error categorization     |
| Yjs Storage        | ✅ Complete | SQLite persistence, versioning, snapshots      |
| File Operations    | ✅ Complete | read/write/edit/delete via Yjs                 |
| just-bash          | ✅ Complete | Shell commands in isolates                     |
| In-memory FS       | ✅ Complete | Scratch space for temp files                   |
| WebSocket Sync     | ⚡ Partial  | Binary broadcast, needs full Yjs protocol      |
| Controlled Fetch   | ✅ Complete | URL/method allowlist, request logging          |
| Web Search         | ✅ Complete | Brave Search API, web + news search            |
| Browser Automation | ✅ Complete | Playwright, browse/screenshot/interact/scrape  |
| Code Execution     | ✅ Complete | LOADER-based JS sandbox, module support        |
| LLM Integration    | ✅ Complete | GPT-5.2, 13 tools, auto tool loop, reasoning   |
| Action Logging     | ✅ Complete | Audit trail for all tool calls                 |
| Message Storage    | ❌ Planned  | One row per message, R2 for large content      |
| Streaming Protocol | ✅ Complete | text_delta, tool_call/result, text_done        |
| Subagent Streaming | ❌ Designed | Optional streaming from facets to parent       |
| Background Tasks   | ✅ Complete | schedule() API, subagent monitoring & recovery |
| Task Management    | ✅ Complete | Hierarchical tasks, dependencies, LLM tools    |
| Subagent Parallel  | ✅ Complete | DO Facets (isolated storage), parallel exec    |
| Extensibility      | ❌ Planned  | Three-layer customization (core/class/props)   |
| Multi-Model        | ❌ Planned  | Smart routing: primary/fast/summarizer/vision  |
| UI                 | ❌ Planned  | Chat, code editor, status                      |
| Sandbox            | ❌ Planned  | Full VM for heavy workloads                    |

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
│                     Think Agent (Durable Object)                        │
│                     extends Agent<Env, ThinkState>                      │
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
// In the Think Agent
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

## Extensibility Architecture

Think is designed as an **opinionated but customizable** thinking machine. The core capabilities are fixed, but users can augment behavior through two mechanisms:

### Three-Layer Customization Model

```
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Props (Dynamic/Runtime)                       │
│  - Per-request additional instructions                  │
│  - Per-tenant model preferences                         │
│  - (Future) Per-request custom tools                    │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Class Extension (Static/Build-time)           │
│  - Product-specific instructions                        │
│  - Domain-specific tools                                │
│  - Company-wide model config                            │
├─────────────────────────────────────────────────────────┤
│  Layer 1: Core (Immutable)                              │
│  - CORE_SYSTEM_PROMPT                                   │
│  - Core tools (bash, files, fetch, browse, etc.)        │
│  - Smart model routing logic                            │
└─────────────────────────────────────────────────────────┘
```

### Layer 1: Core (Immutable)

The fundamental identity of Think. Cannot be removed or replaced:

- **Core System Prompt**: Defines Think as a coding assistant with specific capabilities
- **Core Tools**: bash, readFile, writeFile, editFile, listFiles, fetch, webSearch, newsSearch, browseUrl, screenshot, interactWithPage, scrapeElements, executeCode, task management tools
- **Smart Model Routing**: Think decides when to use fast vs primary models

### Layer 2: Class Extension

For building products on Think. Extend the class and override protected methods:

```typescript
class CustomerServiceThink extends Think {
  // Add domain-specific instructions (merged with core)
  protected getAdditionalInstructions(): string {
    return `You are helping Acme Corp customers. Be friendly and helpful.
Always check order status before discussing refunds.`;
  }

  // Add domain-specific tools (merged with core)
  protected getCustomTools(): Record<string, Tool> {
    return {
      lookupOrder: this.orderLookupTool(),
      refundOrder: this.refundTool(),
      checkInventory: this.inventoryTool()
    };
  }

  // Override model configuration
  protected getModelConfig(): Partial<ModelRoles> {
    return {
      primary: "claude-3-opus",
      fast: "claude-haiku"
    };
  }
}
```

### Layer 3: Props (Dynamic Runtime)

For per-request customization. Passed via `getAgentByName()` or `routeAgentRequest()`:

```typescript
// In your Worker fetch handler
const agent = await getAgentByName(env.Think, `user-${userId}`, {
  props: {
    additionalInstructions: "This user prefers concise answers.",
    models: {
      primary: "gpt-5.2",
      fast: "gpt-4o-mini"
    }
  }
});

// Or via routeAgentRequest for all agents
return routeAgentRequest(request, env, {
  props: {
    additionalInstructions: tenant.systemPrompt,
    models: tenant.modelConfig
  }
});
```

### ThinkProps Interface

```typescript
interface ThinkProps {
  // Augment the system prompt (added after core + class-level)
  additionalInstructions?: string;

  // Override model roles (must be serializable identifiers)
  models?: Partial<{
    primary: string; // e.g., "gpt-5.2", "claude-3-opus"
    fast: string; // e.g., "gpt-4o-mini", "claude-haiku"
    summarizer: string; // For context compaction
    vision: string; // For screenshot analysis
  }>;

  // TODO: Custom tools via props
  // Challenge: Tools have executable functions, props must be serializable
  // Potential solutions:
  // - Tool definitions that reference registered tools by name
  // - Tool schemas that Think instantiates internally
  // - Code strings that Think evaluates (security implications)
}
```

### Multi-Model Architecture

Think uses different models for different purposes, even within a single run:

| Model Role   | When Used                                | Default                 |
| ------------ | ---------------------------------------- | ----------------------- |
| `primary`    | Main reasoning loop, complex planning    | gpt-5.2 with reasoning  |
| `fast`       | Subagent tasks, quick checks             | gpt-4o-mini             |
| `summarizer` | Context compaction when history grows    | Same as fast            |
| `vision`     | Screenshot analysis, image understanding | gpt-4o (vision-capable) |

**Within a Single Run Example:**

1. User asks: "Build me a landing page"
2. `primary` analyzes request, creates task plan
3. `fast` handles subagents for parallel research (docs, inspiration)
4. `primary` synthesizes research, writes components
5. `vision` takes screenshot, evaluates visual result
6. `primary` iterates based on visual feedback
7. `summarizer` compresses conversation when approaching context limit

This routing is **opinionated** - Think decides when to use each model. Users configure **which** models fill each role, not **when** they're used.

### How Layers Merge

```typescript
// System prompt: Core + Class + Props
private buildSystemPrompt(): string {
  let prompt = CORE_SYSTEM_PROMPT;  // Layer 1: immutable

  const classAdditions = this.getAdditionalInstructions();
  if (classAdditions) {
    prompt += `\n\n## Additional Context\n${classAdditions}`;  // Layer 2
  }

  if (this.props?.additionalInstructions) {
    prompt += `\n\n## Session Context\n${this.props.additionalInstructions}`;  // Layer 3
  }

  return prompt;
}

// Tools: Core + Class + (Future: Props)
private buildTools(): Record<string, Tool> {
  return {
    ...createCoreTools(this.toolContext),      // Layer 1: immutable
    ...this.getCustomTools(),                   // Layer 2: class extension
    // ...(this.props?.customTools ?? {}),      // Layer 3: future
  };
}

// Model selection: Props > Class > Default
private resolveModel(role: keyof ModelRoles): LanguageModel {
  const modelId =
    this.props?.models?.[role] ??              // Layer 3: props
    this.getModelConfig()[role] ??             // Layer 2: class
    DEFAULT_MODELS[role];                       // Layer 1: default

  return this.createModel(modelId);
}
```

### Design Philosophy

| What Users CAN Do               | What Users CANNOT Do        |
| ------------------------------- | --------------------------- |
| Add domain instructions         | Remove core prompt          |
| Add custom tools                | Remove core tools           |
| Configure which models to use   | Change when models are used |
| Customize per-request via props | Pass non-serializable props |
| Extend via subclass             | Break fundamental behavior  |

Think is a **thinking machine** - users can give it domain knowledge and specialized tools, but they can't change what it fundamentally is.

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

> **IMPORTANT: Facet Isolation (Verified via E2E Tests)**
>
> Facets run in **separate isolates** from their parent. This means:
>
> - **Isolated SQLite storage** - facets cannot read the parent's tables
> - **Isolated static variables** - no shared in-memory state
> - **RPC via stub.fetch()** - facets CAN call back to parent via `ctx.exports.Think`
>
> Subagents access parent's tools (files, bash, fetch) via the `ParentRPC` class,
> which uses the DO stub's `fetch()` method to make HTTP requests to parent endpoints.
> This was verified by E2E testing in `e2e/facets.test.ts`.

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

  // Recovery methods (for hibernation handling)
  getRunningSubagents(): Array<{
    taskId: string;
    facetName: string;
    startedAt: number;
  }>;
  markInterrupted(taskId: string): void;
  isTimedOut(taskId: string): boolean;
  markTimedOut(taskId: string): void;
}

// Configuration for subagent monitoring
export const SUBAGENT_CONFIG = {
  initialCheckDelay: 30, // seconds before first status check
  checkInterval: 60, // seconds between subsequent checks
  maxCheckAttempts: 10, // max checks before marking as timed out
  maxExecutionTime: 600 // max execution time (10 minutes)
};
```

### How It Works

1. **Facet Architecture**: Each subagent runs as a facet of the parent Think DO
   - **ISOLATED storage** (facets do NOT share SQLite with parent)
   - Task data passed via props when facet is created
   - Has isolated LLM context (focused system prompt)
   - Runs truly in parallel with parent and other facets
   - Returns results to parent, which updates task graph

2. **Task Delegation Flow**:

   ```typescript
   // Parent creates subtask
   const task = createSubtask({ type: "explore", title: "Research options" });

   // Parent delegates to subagent (passes all data via props)
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
   - **Full tool access via ParentRPC** (bash, fetch, file read/write)
   - Uses `ctx.exports.Think` to get stub and call parent's HTTP endpoints
   - Returns result to parent via SubagentResult
   - **Parent updates task graph** based on returned result

4. **Hibernation & Recovery Handling**:
   The parent DO may hibernate while subagents are running. We handle this with:
   - **Scheduled status checks**: When a subagent is spawned, the parent schedules
     a status check using `this.schedule()` (Agents SDK). Checks run every 60s.
   - **Timeout detection**: If a subagent exceeds `maxExecutionTime` (10 min),
     it's marked as timed out and cleaned up.
   - **Startup recovery**: On `onStart()`, the Think class detects orphaned subagents
     (still marked "running" in SQLite) and marks them as "interrupted".

   ```typescript
   // Parent schedules monitoring when spawning
   async spawnSubagent(task) {
     const facetName = await manager.spawnSubagent(task);
     await this.schedule(30, "checkSubagentStatus", { taskId: task.id, attempt: 1 });
     return facetName;
   }

   // Callback handles status polling and rescheduling
   async checkSubagentStatus(payload: SubagentCheckPayload) {
     const status = await manager.getSubagentStatus(payload.taskId);
     if (status?.status === "complete" || status?.status === "failed") {
       await this.handleSubagentComplete(payload.taskId, status);
     } else if (manager.isTimedOut(payload.taskId)) {
       await this.handleSubagentTimeout(payload.taskId);
     } else if (payload.attempt < payload.maxAttempts) {
       await this.schedule(60, "checkSubagentStatus", { ...payload, attempt: payload.attempt + 1 });
     }
   }

   // Startup recovery for orphaned subagents
   async onStart() {
     await this.recoverOrphanedSubagents(); // Marks "running" as "interrupted"
   }
   ```

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

### Parent vs Subagent Resources

| Resource      | Parent Owns | Subagent Access                  |
| ------------- | ----------- | -------------------------------- |
| SQLite        | ✅ Yes      | ❌ Isolated (separate storage)   |
| Task Graph    | ✅ Yes      | Via result return to parent      |
| Yjs Storage   | ✅ Yes      | Via ParentRPC (read/write files) |
| Bash/Fetch    | ✅ Yes      | Via ParentRPC                    |
| LLM Context   |             | ✅ Own isolated context          |
| System Prompt |             | ✅ Focused prompt for task       |
| Tool Calls    | ✅ Logged   | Logged on parent via RPC         |

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
  session_id TEXT NOT NULL,            -- Links to session
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

  -- Subagent/Facet tracking
  facet_name TEXT,                     -- NULL for parent agent, 'subagent-{taskId}' for subagents
  parent_message_id TEXT,              -- Links subagent messages to delegating parent message
  delegated_task_ids JSON,             -- Array of task IDs spawned from this message

  -- Metadata
  timestamp INTEGER NOT NULL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  model TEXT,

  -- For retry chains
  attempt INTEGER DEFAULT 1,
  retry_parent_id TEXT                 -- Links to original message when retrying
);

CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX idx_messages_status ON messages(status);
CREATE INDEX idx_messages_facet ON messages(facet_name);
CREATE INDEX idx_messages_parent ON messages(parent_message_id);
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

## Subagent Streaming (Optional)

Subagents run as Durable Object Facets, executing focused LLM loops in parallel. By default,
subagents complete silently and report results through the task graph. Optional streaming
allows the parent to relay subagent progress to connected clients.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Parent Agent (Think DO)                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  WebSocket Connections                                    │   │
│  │  ├── Tab 1 (receives all events)                         │   │
│  │  └── Tab 2 (receives all events)                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ▲                                  │
│                              │ relay events                     │
│  ┌───────────────────────────┴──────────────────────────────┐   │
│  │              SubagentStreamRelay                          │   │
│  │  - Receives events from subagent facets                   │   │
│  │  - Prefixes with subagent taskId                          │   │
│  │  - Broadcasts to parent's WebSocket connections           │   │
│  └───────────────────────────────────────────────────────────┘   │
│                              ▲                                  │
│         ┌────────────────────┼────────────────────┐             │
│         │                    │                    │             │
│  ┌──────┴──────┐      ┌──────┴──────┐      ┌──────┴──────┐      │
│  │ Subagent A  │      │ Subagent B  │      │ Subagent C  │      │
│  │ (Facet)     │      │ (Facet)     │      │ (Facet)     │      │
│  │ streamText()│      │ streamText()│      │ streamText()│      │
│  └─────────────┘      └─────────────┘      └─────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

### Subagent Stream Events

When streaming is enabled, subagents emit events through a callback:

```typescript
interface SubagentStreamEvent {
  taskId: string; // Which subagent this came from
  type:
    | "subagent_text_delta" // Text streaming from subagent
    | "subagent_tool_call" // Subagent calling a tool
    | "subagent_tool_result" // Tool completed
    | "subagent_complete" // Subagent finished
    | "subagent_error"; // Subagent failed
  delta?: string; // For text_delta
  toolName?: string; // For tool events
  input?: unknown; // For tool_call
  output?: unknown; // For tool_result
  result?: string; // For complete
  error?: string; // For error
}
```

### Implementation Plan

**Phase 1: Subagent streaming infrastructure**

- [ ] Add `streamToParent` callback option to `SubagentManager.spawnSubagent()`
- [ ] Update `Subagent.execute()` to optionally use `streamText()` instead of `generateText()`
- [ ] Create `SubagentStreamRelay` class in parent to collect and broadcast events

**Phase 2: Event relay to WebSocket clients**

- [ ] Add WebSocket message types for subagent events
- [ ] Prefix all subagent events with `taskId` for client disambiguation
- [ ] Handle concurrent subagent streams (multiple facets streaming simultaneously)

**Phase 3: UI integration (future)**

- [ ] Collapsible subagent panels in chat UI
- [ ] Real-time progress for each delegated task
- [ ] Aggregate view: "3 subagents working... [Expand]"

### Configuration

```typescript
interface SubagentOptions {
  streaming?: boolean; // Enable streaming (default: false)
  streamingThrottle?: number; // Debounce ms for text deltas (default: 50)
  broadcastToolCalls?: boolean; // Include tool events (default: true)
}

// Usage
await ctx.subagents.delegateTask({
  taskId: "task-123",
  title: "Implement feature X",
  description: "...",
  streaming: true // Opt-in to streaming
});
```

### Trade-offs

| Approach               | Pros                      | Cons                           |
| ---------------------- | ------------------------- | ------------------------------ |
| No streaming (current) | Simple, less overhead     | No real-time visibility        |
| Polling status         | Works with generateText() | Latency, extra requests        |
| Full streaming         | Real-time UX              | More complex, higher bandwidth |

**Recommendation**: Keep non-streaming as default for simplicity. Enable streaming for
user-facing subagent work where progress visibility matters.

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
interface ThinkState {
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

function ThinkInterface() {
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
- **Facet tests**: Durable Object Facets don't work in `vitest-pool-workers` test environment
- **Live API tests**: Require actual API keys and make real network calls
- **Cost awareness**: LLM tests consume API tokens; use sparingly in CI

### E2E Testing Harness

To test features that don't work in `vitest-pool-workers` (facets, browser automation), we use a
separate E2E test suite that runs against a real `wrangler dev` server.

#### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    vitest.e2e.config.ts                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  globalSetup: e2e/setup.ts                                │   │
│  │  - Spawns `wrangler dev --port 8799`                      │   │
│  │  - Waits for server ready                                 │   │
│  │  - Exports BASE_URL to tests                              │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  E2E Tests (e2e/*.test.ts)                                │   │
│  │  - HTTP requests to BASE_URL                              │   │
│  │  - WebSocket connections                                  │   │
│  │  - Real facet spawning                                    │   │
│  │  - Full chat flow                                         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  globalTeardown: e2e/teardown.ts                          │   │
│  │  - Kills wrangler dev process                             │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

#### File Structure

```
e2e/
├── setup.ts              # globalSetup - starts wrangler dev
├── teardown.ts           # globalTeardown - stops wrangler dev
├── helpers.ts            # Shared test utilities
├── chat.test.ts          # Chat flow tests
├── facets.test.ts        # Subagent/facet tests
├── streaming.test.ts     # WebSocket streaming tests
└── tasks.test.ts         # Task management with subagents
vitest.e2e.config.ts      # Separate config for E2E
```

#### Setup Implementation

```typescript
// e2e/setup.ts
import { spawn, ChildProcess } from "child_process";
import { setTimeout } from "timers/promises";

let wranglerProcess: ChildProcess;

export async function setup() {
  const PORT = process.env.E2E_PORT || "8799";

  // Skip spawning if external URL provided
  if (process.env.E2E_URL) {
    process.env.BASE_URL = process.env.E2E_URL;
    return;
  }

  console.log("Starting wrangler dev...");

  wranglerProcess = spawn("npx", ["wrangler", "dev", "--port", PORT], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env }
  });

  // Wait for server ready
  await waitForReady(`http://localhost:${PORT}`, 30000);

  process.env.BASE_URL = `http://localhost:${PORT}`;
  console.log(`E2E server ready at ${process.env.BASE_URL}`);
}

async function waitForReady(url: string, timeout: number) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await setTimeout(500);
  }
  throw new Error(`Server failed to start within ${timeout}ms`);
}

export async function teardown() {
  if (wranglerProcess) {
    console.log("Stopping wrangler dev...");
    wranglerProcess.kill("SIGTERM");
  }
}
```

#### E2E Test Example

```typescript
// e2e/facets.test.ts
import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = process.env.BASE_URL!;

describe("Subagent Facets (E2E)", () => {
  it("should spawn a subagent and complete task", async () => {
    const agentId = `e2e-facet-${Date.now()}`;

    // Create a task
    const taskRes = await fetch(`${BASE_URL}/agents/${agentId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test task",
        description: "A simple test"
      })
    });
    const { taskId } = await taskRes.json();

    // Spawn subagent for the task
    const spawnRes = await fetch(
      `${BASE_URL}/agents/${agentId}/subagents/spawn`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId })
      }
    );
    expect(spawnRes.status).toBe(200);
    const { facetName } = await spawnRes.json();

    // Poll for completion
    let status = "running";
    while (status === "running") {
      await new Promise((r) => setTimeout(r, 1000));
      const statusRes = await fetch(
        `${BASE_URL}/agents/${agentId}/subagents/${taskId}`
      );
      const data = await statusRes.json();
      status = data.status;
    }

    expect(status).toBe("complete");
  });
});
```

#### Running E2E Tests

```bash
# Run E2E tests (auto-starts wrangler dev)
npm run test:e2e

# Run against external URL (CI with preview deploy)
E2E_URL=https://loader-preview.workers.dev npm run test:e2e

# Run specific test file
npm run test:e2e -- e2e/facets.test.ts
```

#### Test Coverage (E2E)

| Category            | Tests | What it validates                     |
| ------------------- | ----- | ------------------------------------- |
| Chat Flow           | TBD   | Send → stream → persist → history     |
| Subagent Delegation | TBD   | delegateToSubagent → facet → result   |
| WebSocket Streaming | TBD   | Connect → text_delta → tool events    |
| Task + Subagent     | TBD   | Create subtasks → delegate → complete |
| Message Storage     | TBD   | Persist → reconnect → load history    |
| Error Recovery      | TBD   | Network drop → reconnect → resume     |

## References

- [Cloudflare Worker Loader API](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents)
- [Pi Coding Agent](https://pi.dev/)
- [OpenClaw](https://openclaw.ai/)
- [just-bash](https://github.com/vercel-labs/just-bash)
- [worker-fs-mount](https://github.com/danlapid/worker-fs-mount)
- [Yjs](https://docs.yjs.dev/)
