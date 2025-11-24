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

  addAgent(blueprint: AgentBlueprint<Partial<TConfig>>): AgentSystem<TConfig>;

  export(): {
    SystemAgent: typeof SystemAgent<AgentEnv>;
    Agency: typeof Agency;
    handler: ReturnType<typeof createHandler>;
  };
}
```

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
