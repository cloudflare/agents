# Architecture

This is the mental model for how everything fits together.

---

## 1. High-level pieces

There are three main layers:

1. **Worker handler** (exported `handler`)
   - HTTP surface / dashboard
   - Routes API calls to the right Durable Objects
   - Provides the HTML UI at `GET /`

2. **Agency** Durable Object (`Agency`)
   - Control plane per “agency”
   - Stores and overrides agent blueprints
   - Tracks which agent threads exist in this agency

3. **SystemAgent** Durable Object (`SystemAgent`)
   - One instance per **agent thread**
   - Runs the agent loop:
     - stores messages/files/todos
     - calls the LLM provider
     - executes tools and subagents
     - emits events

All the interesting work happens inside `SystemAgent` instances.

---

## 2. Agencies and agent threads

### 2.1 Agency DO

The `Agency` DO is responsible for:

- **Blueprint management** in SQLite:

  ```sql
  CREATE TABLE IF NOT EXISTS blueprints (
    name TEXT PRIMARY KEY,
    data TEXT NOT NULL, -- JSON AgentBlueprint
    updated_at INTEGER NOT NULL
  );
  ```

````

* **Agent registry** per agency:

  ```sql
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    metadata TEXT -- JSON
  );
  ```

Each **agency** is one DO instance, identified by a DO ID string. Agencies are tracked in **KV** through `AGENCY_REGISTRY`.

### 2.2 Agency HTTP API (via handler)

The handler routes:

* `GET /agencies` – list agencies from KV
* `POST /agencies` – create a new `Agency` DO instance and store its metadata

Per agency:

* `GET /agency/:agencyId/blueprints`

  * Merges **static** blueprints (from `AgentSystem.addAgent`) and **dynamic** ones stored in the Agency’s SQLite
* `POST /agency/:agencyId/blueprints`

  * Write or override a blueprint in the Agency’s SQLite

Agents within an agency:

* `GET /agency/:agencyId/agents` – list agent threads
* `POST /agency/:agencyId/agents`

  * Creates a new thread:

    * generates an ID
    * writes to `agents` table
    * spawns a `SystemAgent` DO
    * calls `/register` on that DO with `ThreadMetadata`

The `Agency` DO never calls the LLM; it just manages metadata and blueprints.

---

## 3. SystemAgent: per-thread runtime

Each `SystemAgent` DO is the actual “agent brain” for one thread.

### 3.1 Persistent info and run state

Two key objects are persisted in KV via `PersistedObject`:

* `info: Info` (thread metadata)

  ```ts
  type Info = {
    threadId: string;
    agencyId: string;
    createdAt: string;
    request: ThreadRequestContext;
    agentType: string;
    parentInfo?: ParentInfo;   // if this is a subagent
    pendingToolCalls?: ToolCall[];
    blueprint?: AgentBlueprint;
  };
  ```

* `runState: RunState`

  ```ts
  type RunState = {
    runId: string;
    status: "idle" | "registered" | "running" | "paused" | "completed" | "canceled" | "error";
    step: number;
    reason?: string;
    nextAlarmAt?: number | null;
  };
  ```

`PersistedObject` maps object properties to KV keys and adds mutation warnings if you try to mutate nested objects in place instead of reassigning them (to avoid accidental non-persisting changes).

### 3.2 Store: messages, events, files, subagents

`Store` wraps the DO SQLite + KV and hides the raw tables:

* Messages:

  ```sql
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
    content TEXT,
    tool_call_id TEXT,
    tool_calls_json TEXT,
    created_at INTEGER NOT NULL
  );
  ```

  * `appendMessages()` records user/assistant/tool messages.
  * `listMessages()` reconstructs `ChatMessage[]` for the agent.
  * `appendToolResult()` inserts a single tool message.

* Events:

  ```sql
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  ```

  * `addEvent()` stores `AgentEvent`s and returns their `seq`.
  * `listEvents()` returns chronological agent events.

* Files (virtual filesystem):

  ```sql
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content BLOB,
    updated_at INTEGER NOT NULL
  );
  ```

  * `mergeFiles()`, `listFiles()`, `readFile()`, `writeFile()`, `editFile()`.

* Subagent bookkeeping:

  ```sql
  CREATE TABLE IF NOT EXISTS waiting_subagents (...);
  CREATE TABLE IF NOT EXISTS subagent_links (...);
  ```

  This tracks:

  * which tool call spawned which child thread
  * which children are still pending
  * completion / cancel / reports for each subagent

* Todos (via `planning` middleware):

  ```sql
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed')),
    pos INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  ```

  Only created when `planning` is enabled.

### 3.3 Middleware pipeline

`SystemAgent` exposes:

```ts
abstract get middleware(): AgentMiddleware[];
abstract get tools(): Record<string, ToolHandler>;
abstract get systemPrompt(): string;
abstract get model(): string;
abstract get config(): AgentConfig;
abstract get provider(): Provider;
```

Most of those are resolved dynamically from the **AgentSystem** configuration and the current agent blueprint.

The run loop (`run()`) is essentially:

1. Emit `RUN_TICK`
2. If there are no pending tool calls and no waiting subagents:

   * build `ModelRequest` via `ModelPlanBuilder` using all middleware
   * call `provider.invoke(req)`
   * let middleware react via `onModelResult`
   * append the assistant’s message
   * capture any tool calls from the assistant into `info.pendingToolCalls`
3. If the agent paused (HITL or subagent), stop here
4. If the agent looks “done” (`isDone` checks last assistant message):

   * mark `runState.status = "completed"`
   * emit `AGENT_COMPLETED`
   * if this is a subagent, call `/child_result` on the parent and stop
5. Otherwise, execute pending tools in batches (`executePendingTools`)
6. Reschedule via Durable Object alarm and repeat

---

## 4. AgentSystem and blueprints

### 4.1 AgentSystem

`AgentSystem` is a config-time builder:

```ts
const system = new AgentSystem({
  defaultModel: "openai:gpt-4.1-mini",
  provider?: Provider,
  handlerOptions?: HandlerOptions
})
  .defaults()
  .addTool(myTool, ["analytics"])
  .use(myMiddleware, ["my-tag"])
  .addAgent({
    name: "my-agent",
    description: "Does things.",
    prompt: "You are...",
    tags: ["default", "analytics"],
    config: { ... } // config consumed by middleware
  });

const { SystemAgent, Agency, handler } = system.export();
```

Internally:

* Tools registered via `.addTool()` go into a **ToolRegistry**.
* Middleware registered via `.use()` go into a **MiddlewareRegistry**.
* Blueprints registered via `.addAgent()` go into an `agentRegistry`.

The generic type `AgentSystem<TConfig>` grows as you add middleware, so you can get type-safe `config` for your blueprints if you want to lean into that.

### 4.2 Blueprint tags & selection

Each `AgentBlueprint` has `tags: string[]`.

At runtime:

* `SystemAgent.middleware` selects middlewares whose tags intersect with the blueprint’s tags.
* `SystemAgent.tools` selects tools whose tags intersect with the blueprint’s tags, **plus** any tools that middleware registered dynamically with `ctx.registerTool()`.

So in the deep example:

* `system.defaults()` registers `planning`, `filesystem`, `subagents` with tag `"default"` (plus their internal tags like `"planning"`, `"fs"`, `"subagents"`).
* The `"manager-agent"` blueprint has `tags: ["default"]`, so it gets all of them.
* Custom analytics tools are added with tag `"security"` and the `"security-agent"` blueprint uses `tags: ["security"]`, so they show up only there.

---

## 5. Subagents and the `task` tool

The `subagents` middleware defines one special tool: `task`.

### 5.1 What `task` does

When the model calls:

```json
{
  "name": "task",
  "args": {
    "description": "Analyze top IPs in this window...",
    "subagentType": "security-agent"
  }
}
```

The handler:

1. Generates a `token` and a `childThreadId`.

2. Emits `SUBAGENT_SPAWNED`.

3. Creates a stub for the child `SystemAgent` DO.

4. Calls `POST /register` on the child with:

   ```ts
   {
     id: childThreadId,
     createdAt: nowISO,
     agentType: subagentType,
     request: ctx.agent.info.request,    // propagate request context
     parent: {
       threadId: parentThreadId,
       token
     }
   }
   ```

5. Calls `POST /invoke` on the child with a single user message = `description`.

6. Registers the “waiting subagent” in the parent’s SQLite (token, childThreadId, toolCallId).

7. Pauses the parent run:

   ```ts
   runState.status = "paused";
   runState.reason = "subagent";
   ```

8. Returns `null` from the tool, so **no** immediate tool-result message is added.

The child runs independently until it completes.

### 5.2 How results come back

When a subagent completes:

1. `SystemAgent.run()` in the child sets status `completed` and emits `AGENT_COMPLETED`.
2. Because the child has `parentInfo`, it also:

   * computes the final text output (`final`)
   * calls `POST /child_result` on the parent thread with `{ token, childThreadId, report: final }`

On the parent:

* `childResult()`:

  * pops the waiting subagent via token + childThreadId
  * appends a tool message on the waiting tool call ID with the `report`
  * marks the subagent link as `completed` in SQLite
  * emits `SUBAGENT_COMPLETED`
  * if **no** waiting subagents remain:

    * moves `runState.status` back to `"running"`
    * emits `RUN_RESUMED`
    * schedules the agent again

From the agent’s POV, it looks like one tool call that took multiple ticks and eventually produced a single tool output message.

---

## 6. HITL (Human-in-the-loop) middleware

The optional `hitl` middleware lets you pause runs when certain tools are proposed.

Config shape:

```ts
export type HitlConfig = {
  hitl?: {
    tools: string[]; // list of tool names that require human approval
  };
};
```

When enabled on a blueprint:

1. `hitl.onModelResult()` inspects the last assistant message.
2. If any tool call’s name is in `config.hitl.tools`:

   * it sets `runState.status = "paused"`, `reason = "hitl"`.
   * emits `RUN_PAUSED`.

The dashboard shows HITL buttons when there are pending tool calls:

* `POST /agency/:agencyId/agent/:threadId/approve` with:

  ```ts
  {
    approved: boolean;
    modifiedToolCalls?: ToolCall[]; // optional edits
  }
  ```

On approve:

* The parent `SystemAgent.approve()` stores the (possibly modified) tool calls in `info.pendingToolCalls`.
* Emits `HITL_RESUME` and `RUN_RESUMED`.
* Schedules the run again.

---

## 7. Observability & graph

Every important action emits an `AgentEvent`:

* `THREAD_CREATED`, `REQUEST_ACCEPTED`
* `RUN_*` (`started`, `tick`, `paused`, `resumed`, `canceled`)
* `AGENT_*` (`started`, `completed`, `error`)
* `MODEL_*` (`started`, `delta`, `completed`)
* `TOOL_*` (`started`, `output`, `error`)
* `SUBAGENT_*` (`spawned`, `completed`)
* `HITL_*` (`interrupt`, `resume`)
* `CHECKPOINT_SAVED`

`SystemAgent.emit()`:

* Writes the event to SQLite (`events` table)
* Broadcasts it as JSON over WebSocket to any connected clients

The dashboard (`client.html`) subscribes to:

* `GET /agency/:agencyId/agent/:threadId/events` for the history
* `/ws` for live events

It then reconstructs a graph with:

* Nodes: ticks, model calls, tools, done/error markers
* Edges: sequential flow and dashed spawn/completion edges between parent and child agents

You don’t have to use the built-in UI, but it’s handy for debugging and understanding multi-agent behaviour.

---

## 8. Filesystem and planning

Because `.defaults()` enables both `planning` and `filesystem`, typical agents get:

* A todo list backed by SQLite (`todos` table)
* A virtual filesystem in SQLite (`files` table)

These show up in `AgentState`:

* `state.todos` – current todo list
* `state.files` – map of path → string content

And as tools:

* `write_todos(todos: Todo[])`
* `ls()`
* `read_file({ path, offset?, limit? })`
* `write_file({ path, content })`
* `edit_file({ path, oldString, newString, replaceAll? })`

The `filesystem` middleware also enforces a simple safety rule:

* You **must** use `read_file` on a path at least once before you can `edit_file` it.

It tracks this via a KV entry `lastReadPaths`.

---

## 9. Dashboard UI structure

Just so you know what the HTML is doing:

* Left sidebar:

  * Agencies dropdown
  * Threads list (root threads + nested subagents)
* Main area:

  * **Chat & Todos** tab:

    * Chat transcript
    * Run status (running/paused/completed/error)
    * Message input
    * HITL controls
    * Todos panel
    * Raw state JSON
  * **Graph** tab:

    * Cytoscape graph of events
    * Zoom/fit/export controls
  * **Files** tab:

    * List of files in `state.files`
    * Markdown/code preview with line numbers and syntax highlighting

All of this is built on the HTTP and WebSocket endpoints exposed by the `handler`.

# API Reference

This is a reference for the TypeScript/Worker API and the HTTP surface.

---

## 1. Module: `agents/sys`

Everything in `packages/agents/src/sys` is re-exported from this entrypoint.

### 1.1 AgentSystem

```ts
class AgentSystem<TConfig = Record<string, unknown>> {
  constructor(options: AgentSystemOptions);

  defaults(): AgentSystem<TConfig>;

  addTool(handler: ToolHandler, tags?: string[]): AgentSystem<TConfig>;

  use<TNewConfig>(
    mw: AgentMiddleware<TNewConfig>,
    tags?: string[]
  ): AgentSystem<TConfig & TNewConfig>;

  addAgent(
    blueprint: AgentBlueprint<Partial<TConfig>>
  ): AgentSystem<TConfig>;

  export(): {
    SystemAgent: typeof SystemAgent<AgentEnv>;
    Agency: typeof Agency;
    handler: ReturnType<typeof createHandler>;
  };
}
````

Options:

```ts
type AgentSystemOptions = {
  defaultModel: string; // e.g. "openai:gpt-4.1-mini"
  provider?: Provider; // optional custom provider
  handlerOptions?: HandlerOptions;
};
```

- `defaultModel` – fallback model id for agents that don’t set `blueprint.model`.
- `provider` – optional `Provider` implementation. If omitted, OpenAI is used via `makeOpenAI(LLM_API_KEY, LLM_API_BASE)`.
- `handlerOptions` – passed into `createHandler` (see below).

`defaults()` registers the stock middleware:

- `planning`, `filesystem`, `subagents` (all tagged `"default"` + their own tags)

`addTool(handler, tags?)`:

- Registers a **global** tool. It will be available to any blueprint whose `tags` intersect with the tags you pass here.

`use(middleware, tags?)`:

- Registers middleware globally with tags = union of `tags` and `middleware.tags`.

`addAgent(blueprint)`:

- Registers an `AgentBlueprint` by name in the internal registry.
- These become the static defaults for agencies.

`export()`:

- Returns:
  - `SystemAgent` – configured DO class
  - `Agency` – DO class for agencies
  - `handler` – HTTP handler (to be `export default handler`)

---

### 1.2 SystemAgent

Base class:

```ts
abstract class SystemAgent<Env extends AgentEnv = AgentEnv> extends Agent<Env> {
  // Persisted state
  readonly info: Info;
  readonly runState: RunState;
  readonly store: Store;

  abstract get blueprint(): AgentBlueprint;
  abstract get middleware(): AgentMiddleware[];
  abstract get tools(): Record<string, ToolHandler>;
  abstract get systemPrompt(): string;
  abstract get model(): string;
  abstract get config(): AgentConfig;
  abstract get provider(): Provider;

  get messages(): ChatMessage[];
  get mwContext(): MWContext;
  get isPaused(): boolean;
  get isWaitingSubagents(): boolean;
  get isDone(): boolean;

  emit(type: AgentEventType, data: unknown): void;

  // HTTP entry points
  protected async onRequest(req: Request): Promise<Response>;
  protected abstract onDone(ctx: {
    agent: SystemAgent;
    final: string;
  }): Promise<void>;
}
```

Configured version:

- `AgentSystem.export()` returns a concrete subclass of `SystemAgent<AgentEnv>` that:
  - Resolves `blueprint`, `middleware`, `tools`, `model`, `config`, `provider`
  - Wires events to the `Provider`
  - Implements `onRegister` to pull dynamic blueprints from the `Agency` DO

You typically don’t subclass this yourself; you just consume the class exported by `AgentSystem`.

---

### 1.3 Agent blueprints

```ts
type AgentBlueprint<TConfig = Record<string, unknown>> = {
  name: string;
  description: string;
  prompt: string;
  tags: string[];
  model?: string;
  config?: AgentConfig<TConfig>;
};
```

- `name` – identifier used as `agentType`
- `description` – human-readable description shown in the dashboard
- `prompt` – system prompt used for this agent
- `tags` – used to select middleware/tools
- `model` – per-agent model override
- `config` – configuration blob consumed by middleware

The blueprint for an agent thread can come from:

1. Static registration via `AgentSystem.addAgent(...)`
2. Dynamic override in the `Agency` DO via `POST /agency/:id/blueprints`

---

### 1.4 Middleware

Middleware type:

```ts
interface AgentMiddleware<TConfig = unknown> {
  name: string;
  tags: string[];

  // Attach extra state to AgentState
  state?(ctx: MWContext): Record<string, unknown>;

  // Lifecycle hooks
  onInit?(ctx: MWContext): Promise<void>;
  onTick?(ctx: MWContext): Promise<void>;
  beforeModel?(ctx: MWContext, plan: ModelPlanBuilder): Promise<void>;
  onModelResult?(ctx: MWContext, res: { message: ChatMessage }): Promise<void>;

  onToolStart?(ctx: MWContext, call: ToolCall): Promise<void>;
  onToolResult?(ctx: MWContext, call: ToolCall, result: unknown): Promise<void>;
  onToolError?(ctx: MWContext, call: ToolCall, error: Error): Promise<void>;

  onResume?(ctx: MWContext, reason: string, payload: unknown): Promise<void>;
  onChildReport?(
    ctx: MWContext,
    child: { threadId: string; token: string; report?: string }
  ): Promise<void>;
}
```

Helper:

```ts
function defineMiddleware<TConfig>(
  mw: Omit<AgentMiddleware<TConfig>, "__configType">
): AgentMiddleware<TConfig>;
```

The `MWContext`:

```ts
type MWContext = {
  provider: Provider;
  agent: SystemAgent;
  registerTool: (handler: ToolHandler) => void;
};
```

Use `ctx.registerTool` when your middleware wants to attach tools dynamically (e.g. `planning` registers `write_todos` this way).

---

### 1.5 Tools

Tool handler type:

```ts
type ToolHandler = ((
  input: any,
  ctx: ToolContext
) => Promise<string | object | null>) & { __tool?: ToolMeta };
```

Where:

```ts
type ToolMeta = {
  name: string;
  description?: string;
  parameters?: ToolJsonSchema;
};

type ToolContext = {
  agent: SystemAgent;
  env: typeof env; // Cloudflare worker env binding
  callId: string; // tool call ID from the LLM
};
```

Helpers:

```ts
function defineTool(meta: ToolMeta, handler: ToolHandler): ToolHandler;
function getToolMeta(fn: ToolHandler, fallbackName?: string): ToolMeta | null;
```

`defineTool` attaches metadata on `handler.__tool`. This metadata is used:

- To build the tool definitions passed into the LLM (`ModelRequest.toolDefs`)
- To expose the tools in `AgentState.tools` for the dashboard

Return value semantics:

- `string | object` → becomes a tool result message (`role: "tool"`) attached to that `toolCallId`
- `null` → means “this tool doesn’t produce a direct message”; used by the `task` tool (subagent spawner)

---

### 1.6 Built-in middleware & tools

#### planning

Exports:

- `planning: AgentMiddleware`
- Adds `write_todos` tool
- Adds `WRITE_TODOS_SYSTEM_PROMPT` to the system prompt
- Persists todos in a `todos` table
- Exposes `state.todos: Todo[]`

Schema for `write_todos`:

```ts
type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};
```

#### filesystem

Exports:

- `filesystem: AgentMiddleware`

Registers tools:

- `ls()` – list file paths in the virtual filesystem
- `read_file({ path, offset?, limit? })`
- `write_file({ path, content })`
- `edit_file({ path, oldString, newString, replaceAll? })`

Also:

- Creates `files` table in SQLite (path → content)
- Exposes `state.files: Record<string, string>`
- Tracks `lastReadPaths` in KV and enforces “must read before edit”

#### subagents

Exports:

- `subagents: AgentMiddleware<SubagentsConfig>`

Config type:

```ts
type SubagentsConfig = {
  subagents?: {
    subagents: AgentBlueprint[]; // list of available subagent blueprints
  };
};
```

Adds:

- `TASK_SYSTEM_PROMPT` to the system prompt
- `task` tool:

  ```ts
  type TaskInput = {
    description: string;
    subagentType: string;
    timeoutMs?: number;
  };
  ```

Behavior is described in the Architecture doc (`Subagents` section).

It also:

- Emits `SUBAGENT_SPAWNED` when a child is launched
- Pauses the parent run with `reason: "subagent"`
- Updates `state.subagents: SubagentLink[]` via `Store.listSubagentLinks()`

#### hitl

Exports:

- `hitl: AgentMiddleware<HitlConfig>`

Config:

```ts
type HitlConfig = {
  hitl?: {
    tools: string[]; // names of tools that require approval
  };
};
```

If the model proposes a tool call whose name is in `tools`, the middleware:

- Sets `runState.status = "paused"` and `reason = "hitl"`
- Emits `RUN_PAUSED`
- The dashboard shows HITL buttons that call `/approve`

---

### 1.7 Providers

Exports:

```ts
interface Provider {
  invoke(
    req: ModelRequest,
    opts: { signal?: AbortSignal }
  ): Promise<ModelResult>;
  stream(
    req: ModelRequest,
    onDelta: (chunk: string) => void
  ): Promise<ModelResult>;
}

type ModelResult = {
  message: ChatMessage; // assistant message (may include toolCalls)
  usage?: { promptTokens: number; completionTokens: number; costUsd?: number };
};

function parseModel(modelId: string): string;
function makeOpenAI(apiKey: string, baseUrl?: string): Provider;
function makeAnthropic(baseUrl: string, apiKey: string): Provider;
function makeWorkersAI(ai: unknown): Provider;
```

- `parseModel` lets you pass IDs like `"openai:gpt-4.1-mini"`; it strips the prefix before sending to the provider.
- `makeOpenAI` adapts the internal `ModelRequest` + `ChatMessage` format to OpenAI Chat Completions.
- `makeAnthropic` / `makeWorkersAI` are placeholders in the current code (they return a dummy `"Hello, world!"` response).

`SystemAgent.provider` wraps any `Provider` with event emission:

- Emits `MODEL_STARTED` before calling the provider
- Emits `MODEL_COMPLETED` after

---

### 1.8 Worker handler

Exports from `agents/sys/worker`:

```ts
type HandlerOptions = {
  baseUrl?: string; // currently unused
  secret?: string; // optional shared secret for X-SECRET auth
  agentDefinitions?: AgentBlueprint[]; // static blueprints
};

type HandlerEnv = {
  SYSTEM_AGENT: DurableObjectNamespace<SystemAgent>;
  AGENCY: DurableObjectNamespace<Agency>;
  AGENCY_REGISTRY: KVNamespace;
};

function createHandler(opts?: HandlerOptions): {
  fetch(
    req: Request,
    env: HandlerEnv,
    ctx: ExecutionContext
  ): Promise<Response>;
};
```

`AgentSystem.export()` calls `createHandler` for you and injects `agentDefinitions` from its internal agent registry if you didn’t set them.

HTTP routes handled:

- `GET /` – serves `client.html` dashboard
- `GET /agencies` – list agencies from `AGENCY_REGISTRY`
- `POST /agencies` – create a new Agency DO and store metadata

Per agency:

- `GET /agency/:agencyId/blueprints` – static + dynamic blueprints
- `POST /agency/:agencyId/blueprints` – write blueprint into Agency DO
- `GET /agency/:agencyId/agents` – list agent threads
- `POST /agency/:agencyId/agents` – create new agent thread; injects request context (`ThreadRequestContext`)

Per agent thread:

- `POST /agency/:agencyId/agent/:agentId/invoke`
  - Forwards to DO `/invoke`, injecting `threadId` into the body

- `GET /agency/:agencyId/agent/:agentId/state` → DO `/state`
- `GET /agency/:agencyId/agent/:agentId/events` → DO `/events`
- `POST /agency/:agencyId/agent/:agentId/approve` → DO `/approve`
- `POST /agency/:agencyId/agent/:agentId/cancel` → DO `/cancel`
- `GET /agency/:agencyId/agent/:agentId/ws` – WebSocket for live events (implemented in the base `Agent` class)

Auth:

- If `opts.secret` is set, all non-`GET /` requests must include `X-SECRET: <secret>` or they get `401`.

---

## 2. Types

### 2.1 Messages & threads

```ts
type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

type ToolCall = {
  name: string;
  args: unknown;
  id: string;
};

type ThreadRequestContext = {
  userAgent?: string;
  ip?: string;
  referrer?: string;
  origin?: string;
  cf?: Record<string, unknown>; // colo, country, city, region, timezone, postalCode, asOrganization
};

type ParentInfo = {
  threadId: string;
  token: string;
};

interface ThreadMetadata {
  id: string;
  createdAt: string;
  request: ThreadRequestContext;
  parent?: ParentInfo;
  agentType: string;
  agencyId: string;
}

interface InvokeBody {
  threadId?: string;
  messages?: ChatMessage[];
  files?: Record<string, string>;
  idempotencyKey?: string;
  agentType?: string;
  parent?: ParentInfo;
}
```

`AgentState` (what `/state` returns):

```ts
type AgentState = {
  messages: ChatMessage[];
  tools: ToolMeta[];
  thread: ThreadMetadata;
  threadId?: string;
  parent?: ParentInfo;
  agentType?: string;
  model?: string;
} & Record<string, unknown>; // middleware injects more (todos, files, subagents, ...)
```

### 2.2 Subagents

```ts
type SubagentLinkStatus = "waiting" | "completed" | "canceled";

interface SubagentLink {
  childThreadId: string;
  token: string;
  status: SubagentLinkStatus;
  createdAt: number;
  completedAt?: number;
  report?: string;
  toolCallId?: string;
}
```

When `subagents` middleware is active, `state.subagents` is a `SubagentLink[]`.

### 2.3 Events

```ts
enum AgentEventType {
  THREAD_CREATED = "thread.created",
  REQUEST_ACCEPTED = "request.accepted",
  RUN_STARTED = "run.started",
  RUN_TICK = "run.tick",
  RUN_PAUSED = "run.paused",
  RUN_RESUMED = "run.resumed",
  RUN_CANCELED = "run.canceled",
  AGENT_STARTED = "agent.started",
  AGENT_COMPLETED = "agent.completed",
  AGENT_ERROR = "agent.error",
  CHECKPOINT_SAVED = "checkpoint.saved",
  MODEL_STARTED = "model.started",
  MODEL_DELTA = "model.delta",
  MODEL_COMPLETED = "model.completed",
  MIDDLEWARE_BEFORE_MODEL = "middleware.before_model",
  MIDDLEWARE_AFTER_MODEL = "middleware.after_model",
  TOOL_STARTED = "tool.started",
  TOOL_OUTPUT = "tool.output",
  TOOL_ERROR = "tool.error",
  HITL_INTERRUPT = "hitl.interrupt",
  HITL_RESUME = "hitl.resume",
  SUBAGENT_SPAWNED = "subagent.spawned",
  SUBAGENT_COMPLETED = "subagent.completed"
}

type AgentEvent = {
  threadId: string;
  ts: string;
  seq?: number;
} & AgentEventData;

type AgentEventData =
  | { type: AgentEventType.THREAD_CREATED; data: { threadId: string } }
  | { type: AgentEventType.REQUEST_ACCEPTED; data: { idempotencyKey: string } }
  | { type: AgentEventType.RUN_STARTED; data: { runId: string } }
  | { type: AgentEventType.RUN_TICK; data: { runId: string; step: number } }
  | {
      type: AgentEventType.RUN_PAUSED;
      data: {
        runId: string;
        reason: "hitl" | "error" | "exhausted" | "subagent";
      };
    }
  | { type: AgentEventType.RUN_RESUMED; data: { runId: string } }
  | { type: AgentEventType.RUN_CANCELED; data: { runId: string } }
  | { type: AgentEventType.AGENT_STARTED; data: Record<string, never> }
  | { type: AgentEventType.AGENT_COMPLETED; data: { result?: unknown } }
  | {
      type: AgentEventType.AGENT_ERROR;
      data: { error: string; stack?: string };
    }
  | {
      type: AgentEventType.CHECKPOINT_SAVED;
      data: { stateHash: string; size: number };
    }
  | { type: AgentEventType.MODEL_STARTED; data: { model: string } }
  | { type: AgentEventType.MODEL_DELTA; data: { delta: string } }
  | {
      type: AgentEventType.MODEL_COMPLETED;
      data: { usage?: { inputTokens: number; outputTokens: number } };
    }
  | {
      type: AgentEventType.MIDDLEWARE_BEFORE_MODEL;
      data: { middlewareName: string };
    }
  | {
      type: AgentEventType.MIDDLEWARE_AFTER_MODEL;
      data: { middlewareName: string };
    }
  | {
      type: AgentEventType.TOOL_STARTED;
      data: { toolName: string; args: unknown };
    }
  | {
      type: AgentEventType.TOOL_OUTPUT;
      data: { toolName: string; output: unknown };
    }
  | {
      type: AgentEventType.TOOL_ERROR;
      data: { toolName: string; error: string };
    }
  | {
      type: AgentEventType.HITL_INTERRUPT;
      data: { proposedToolCalls: Array<{ toolName: string; args: unknown }> };
    }
  | {
      type: AgentEventType.HITL_RESUME;
      data: {
        approved: boolean;
        modifiedToolCalls?: Array<{ toolName: string; args: unknown }>;
      };
    }
  | { type: AgentEventType.SUBAGENT_SPAWNED; data: { childThreadId: string } }
  | {
      type: AgentEventType.SUBAGENT_COMPLETED;
      data: { childThreadId: string; result?: unknown };
    };
```

`GET /agency/:agencyId/agent/:threadId/events` returns `{ events: AgentEvent[] }`.

---

## 3. SystemAgent HTTP API (per-thread)

These are internal to the handler, but you might call them directly from another Worker if you have the DO stub.

- `POST /register` – thread metadata registration

  Body: `ThreadMetadata`.

- `POST /invoke` – start/continue a run

  Body: `InvokeBody`.

  Returns 202 with:

  ```json
  { "runId": "uuid", "status": "running" | "paused" | "completed" | ... }
  ```

- `POST /approve` – HITL approval with body `ApproveBody`:

  ```ts
  type ApproveBody = {
    approved: boolean;
    modifiedToolCalls?: ToolCall[];
  };
  ```

- `POST /cancel` – cancel current run (also propagates to child subagents if any).

- `GET /state` – returns `{ state: AgentState, run: RunState }`.

- `GET /events` – returns `{ events: AgentEvent[] }`.

- `POST /child_result` – internal; used by subagents to report back to parents.

You _usually_ interact via the higher-level `/agency/...` routes instead of calling these directly.

---

## 4. Putting it together

Typical integration looks like:

1. Configure an `AgentSystem` with:
   - a default LLM model
   - a set of tools and middleware
   - a bundle of blueprints

2. Export it and bind DOs/KV in Wrangler.
3. Spin up an **Agency** via `POST /agencies`.
4. Spawn one or more **SystemAgent** threads via `POST /agency/:id/agents`.
5. Talk to threads via:
   - `POST /invoke` to send messages
   - `GET /state` to inspect current state
   - `/ws` to stream events

6. Let the built-in middleware handle:
   - planning (todo lists)
   - filesystem (files)
   - subagents (`task`)
   - optional HITL

You can extend the system in two main ways:

- **New tools**: use `defineTool` and `system.addTool` or register them from a middleware.
- **New middleware**: use `defineMiddleware`, register it with `.use()`, and drive the agent via hooks (`beforeModel`, `onModelResult`, `onToolResult`, etc.).

That’s the full surface area exposed by the code you shared.

```

---

If you want, next step can be:

- tighten the README for public consumption (change naming, add badges, etc.)
- or add a fifth doc just for the built-in dashboard HTTP API (if you plan to expose that separately from the UI).
```
