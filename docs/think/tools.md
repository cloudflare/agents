# Tools

Think keeps the direct model tool list small and puts broad platform
capabilities behind one durable Code Mode runtime.

## Model-facing tools

A default Think turn exposes four built-in tools:

| Tool    | Description                                                        |
| ------- | ------------------------------------------------------------------ |
| `read`  | Read line-numbered text or multimodal workspace content            |
| `write` | Write a workspace file and create parent directories               |
| `edit`  | Apply a focused find-and-replace edit                              |
| `code`  | Run JavaScript against namespaced capabilities in a Dynamic Worker |

Application-owned tools from `getTools()`, actions from `getActions()`, and
client tools keep their existing direct model-tool behavior in this release.
The following Think platform capabilities move inside `code`:

| Namespace         | Source                                                    |
| ----------------- | --------------------------------------------------------- |
| `workspace.*`     | The full persistent filesystem API                        |
| `context.*`       | Session tools from `configureSession()`                   |
| `skills.*`        | Tools from `getSkills()` and `getSkillScriptRunner()`     |
| `extensions.*`    | Tools from loaded extensions                              |
| `fetch.*`         | Static `fetchTools` configuration                         |
| `<server-name>.*` | Each connected MCP server                                 |
| `codemode.*`      | Discovery, durable steps, snippets, and type descriptions |

This separation matters for MCP. Calling `addMcpServer()` registers a transport
and catalog; it no longer converts every JSON Schema into a direct AI SDK tool.
The model discovers tools through `codemode.search()` and asks for types through
`codemode.describe()` only when needed.

Tools belong to the agent running the turn. For parent-child orchestration, use
[Agent Tools](https://github.com/cloudflare/agents/blob/main/docs/agents/agent-tools.md)
instead of passing one-off tools through `chat()`.

## Built-in code tool

The built-in `code` tool makes its JavaScript execution contract explicit. It
accepts `{ code: string }` and runs JavaScript rather than POSIX shell syntax or
the old `{ script, cwd }` payload:

```js
async () => {
  const matches = await codemode.search("find TypeScript files");
  const files = await workspace.glob({ pattern: "src/**/*.ts" });
  return { matches, files };
};
```

Runs execute in isolated Dynamic Workers with outbound networking blocked. The
Code Mode runtime records connector calls durably, supports pause and resume,
and does not replay completed side effects during approval recovery.

Add the Worker Loader binding:

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

The Think framework adds this binding and exports the `CodemodeRuntime` facet
for generated entries. A custom Worker entry must export it:

```typescript
export { CodemodeRuntime } from "@cloudflare/think/server-entry";
```

Set `codeTool = false` when the application provides a custom `bash`, custom
`code`, or explicit `createExecuteTool(this)` runtime. Think then keeps
workspace, context, skills, extensions, and fetch tools direct for compatibility.
Configure the legacy snapshot tool explicitly through `createWorkspaceTools()`
if an application still needs it.

The standalone `createWorkspaceTools()` factory still includes its legacy
`just-bash` snapshot tool. This change applies to Think's built-in assembly, not
to that lower-level factory.

### R2 Spillover

By default, the workspace stores everything in SQLite. For large files, override `workspace` to add R2 spillover:

```typescript
import { Think } from "@cloudflare/think";
import { Workspace } from "@cloudflare/shell";

export class MyAgent extends Think<Env> {
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.R2,
    name: () => this.name
  });

  getModel() {
    /* ... */
  }
}
```

This requires an R2 bucket binding in `wrangler.jsonc`:

```jsonc
{
  "r2_buckets": [{ "binding": "R2", "bucket_name": "agent-files" }]
}
```

## Custom Tools

Override `getTools()` to add your own tools. These are standard AI SDK `tool()` definitions with Zod schemas:

```typescript
import { Think } from "@cloudflare/think";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";

export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  getTools(): ToolSet {
    return {
      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("City name")
        }),
        execute: async ({ city }) => {
          const res = await fetch(
            `https://api.weather.com/v1/current?q=${city}&key=${this.env.WEATHER_KEY}`
          );
          return res.json();
        }
      }),

      calculate: tool({
        description: "Perform a math calculation",
        inputSchema: z.object({
          a: z.number(),
          b: z.number(),
          operator: z.enum(["+", "-", "*", "/"])
        }),
        execute: async ({ a, b, operator }) => {
          const ops: Record<string, (x: number, y: number) => number> = {
            "+": (x, y) => x + y,
            "-": (x, y) => x - y,
            "*": (x, y) => x * y,
            "/": (x, y) => x / y
          };
          return { result: ops[operator](a, b) };
        }
      })
    };
  }
}
```

Custom tools stay direct and are merged after the four built-ins. A custom `read`, `write`, or `edit` tool overrides the matching file helper. A custom `code` or `bash` execution surface requires `codeTool = false`; Think rejects two runtime owners instead of silently pairing one tool with another runtime's approval state.

### Tool Approval

Tools can require user approval before execution using the `needsApproval` option:

```typescript
getTools(): ToolSet {
  return {
    deleteFile: tool({
      description: "Delete a file from the system",
      inputSchema: z.object({ path: z.string() }),
      needsApproval: async ({ path }) => path.startsWith("/important/"),
      execute: async ({ path }) => {
        await this.workspace.rm(path);
        return { deleted: path };
      }
    })
  };
}
```

When `needsApproval` returns `true`, the tool call is sent to the client for approval. The conversation pauses until the client responds with `CF_AGENT_TOOL_APPROVAL`. See [Client Tools](./client-tools.md) for the approval flow.

> Inside the [Code Execution Tool](#code-execution-tool)'s sandbox, `needsApproval` behaves differently: it maps to the codemode runtime's durable pause/approve/resume flow, and a function-valued `needsApproval` always requires approval (see [Approvals](#approvals-human-in-the-loop)).

### Per-turn Tool Overrides

The `beforeTurn` hook can restrict or add tools for a specific turn:

```typescript
beforeTurn(ctx: TurnContext) {
  return {
    activeTools: ["read", "write", "getWeather"],
    tools: { emergencyTool: this.createEmergencyTool() }
  };
}
```

`activeTools` limits which tools the model can call. `tools` adds extra tools for this turn only (merged on top of existing tools).

## MCP tools

Think inherits MCP client support from the `Agent` base class. Connecting an MCP
server does not expose its catalog as direct model tools. Each server becomes a
Code Mode namespace based on its registered name.

Set `waitForMcpConnections` to wait for discovery before Think builds `code`:

```typescript
export class MyAgent extends Think<Env> {
  waitForMcpConnections = true; // default 10s timeout
  // or: waitForMcpConnections = { timeout: 5000 };

  getModel() {
    /* ... */
  }
}
```

Add MCP servers programmatically or via `@callable` methods:

```typescript
import { callable } from "agents";

export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }
}
```

Inside `code`, discover and call the server directly:

```js
async () => {
  const matches = await codemode.search("open pull requests");
  const docs = await codemode.describe("github.list_pull_requests");
  return github.list_pull_requests({ owner: "cloudflare", repo: "agents" });
};
```

Names must map to unique JavaScript identifiers and cannot collide with Think
namespaces such as `workspace`, `context`, or `skills`. Applications that
intentionally want direct MCP tools can call `mcp.getAITools(filter)` explicitly
from their own tool assembly.

See [Connecting to MCP Servers](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md) for full MCP client documentation.

## Explicit code execution tool

The built-in `code` tool is the default Code Mode runtime for new Think agents.
`createExecuteTool()` remains available for custom layouts and migration. It
lets the LLM write and run JavaScript in a sandboxed Worker, recorded on a
durable runtime with approvals, audit history, and reusable snippets.

```sh
npm install @cloudflare/codemode
```

The one-liner infers `state.*` from `this.workspace`, the executor from
`env.LOADER`, and a live browser (`cdp.*`) from `env.BROWSER` if bound. Using it
opts the turn into the legacy explicit-runtime layout, so do not add it when the
built-in `code` tool is sufficient:

```typescript
import { Think } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";

export class MyAgent extends Think<Env> {
  readonly codeTool = false;

  getModel() {
    /* ... */
  }

  getTools() {
    return {
      execute: createExecuteTool(this)
    };
  }
}
```

Setup checklist:

```jsonc
// wrangler.jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }],
  "browser": { "binding": "BROWSER" } // optional — enables cdp.*
}
```

```typescript
// worker entry — the runtime lives in a Durable Object facet, so the class
// must be exported (the @cloudflare/codemode/vite plugin does this
// automatically; the Think framework's generated entry already includes it)
export { CodemodeRuntime } from "@cloudflare/codemode";
```

Each missing piece fails with an error naming the step.

Inside this explicit runtime the model sees typed namespaces plus the platform SDK:

- `tools.*` — your AI SDK tools (object args, validated against their schemas). Only tools with an `execute` function are exposed — client-side tools can't run in the sandbox.
- `state.*` — the workspace filesystem (`state.readFile({ path })`, `state.glob({ pattern })`, `state.planEdits(...)`, …)
- `cdp.*` — the browser, when a Browser Rendering binding is configured. The execute tool defaults to `session: { mode: "dynamic" }`: sessions are per-execution unless the model promotes one with `cdp.startSession()`.
- `codemode.search` / `codemode.describe` / `codemode.step` / `codemode.run` — discovery, side-effect boundaries, and saved snippets

Pass overrides for anything beyond the defaults — e.g. custom `tools.*` alongside the agent-derived state:

```typescript
// On the enclosing Think class:
readonly codeTool = false;
execute: createExecuteTool(this, { tools: myDomainTools });
```

Or fully explicit options (no agent inference):

```typescript
import { createWorkspaceStateBackend } from "@cloudflare/shell";

createExecuteTool({
  ctx: this.ctx,
  tools: myDomainTools,
  state: createWorkspaceStateBackend(this.workspace),
  browser: this.env.BROWSER,
  loader: this.env.LOADER
});
```

### Approvals (human-in-the-loop)

An AI SDK tool with `needsApproval` doesn't run immediately inside the sandbox — calling it **pauses the run durably**. The pause comes back as a normal tool output (`{ status: "paused", executionId, pending }`), the model tells the user what it needs, and the turn ends. Note this differs from the client-side approval flow for plain `getTools()` tools: inside the sandbox a function-valued `needsApproval` can't be evaluated against the call's arguments ahead of time, so it conservatively **always** requires approval. Think ships built-in callables to resolve it:

- `approveExecution(executionId)` — resumes the run where it stopped (already-done work is replayed, not re-executed); the outcome replaces the paused output in the transcript and the chat auto-continues.
- `rejectExecution(executionId, reason?)` — ends the run with `{ status: "rejected", reason }` so the model can adapt.
- `pendingExecutions()` — pending actions (with full args) for rendering approval UI.

> **Render approval cards from `pendingExecutions()`, not the transcript.** The `pending` array in the paused tool output is a _truncated preview_ — args are bounded (~2 KB each) so they don't blow up model context, but the full args (up to 1 MB) are what actually execute on approve. A human approving a gated call must see the authoritative args, so fetch them via `pendingExecutions(executionId)` before enabling the Approve button. `examples/assistant`'s `PausedExecutionCard` shows the pattern.

See `examples/assistant` for a working approval card, and `design/think-execute-hitl.md` for the design.

### The runtime handle

`createExecuteRuntime` returns the moving parts when the host needs more than the tool — and the handle is also assigned to `this.codemode` when created from an agent:

```typescript
import { createExecuteRuntime } from "@cloudflare/think/tools/execute";

const { runtime, connectors, tool } = createExecuteRuntime(this);
await runtime.executions(); // audit trail
await runtime.expirePaused(); // reclaim stale never-approved pauses (call from a scheduled task)
await runtime.saveSnippet("name", { executionId }); // promote a script for reuse
```

## Browser Tools

Give your agent full access to the Chrome DevTools Protocol (CDP) for web page inspection, scraping, screenshots, and debugging. Requires `@cloudflare/codemode` and a Browser Rendering binding.

```sh
npm install @cloudflare/codemode
```

```typescript
import { Think } from "@cloudflare/think";
import { createBrowserTools } from "@cloudflare/think/tools/browser";

export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  getTools() {
    return {
      ...createBrowserTools({
        ctx: this.ctx,
        browser: this.env.BROWSER,
        loader: this.env.LOADER
      })
    };
  }
}
```

Add the Browser Rendering and Worker Loader bindings in `wrangler.jsonc`:

```jsonc
{
  "browser": { "binding": "BROWSER" },
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

This adds the durable CDP tool plus — whenever a `browser` binding is present — the stateless [Quick Action](https://github.com/cloudflare/agents/blob/main/docs/agents/browse-the-web.md#quick-actions-stateless-browsing) tools by default:

| Tool               | Description                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `browser_execute`  | Run TypeScript against a live browser over CDP (screenshots, DOM reads, JS evaluation, …) |
| `browser_markdown` | Read a page (or raw HTML) as Markdown                                                     |
| `browser_extract`  | Extract structured data from a page with AI                                               |
| `browser_links`    | List every link on a page                                                                 |
| `browser_scrape`   | Scrape specific elements by CSS selector                                                  |

Pass `quickActions: false` to keep only `browser_execute`, or `quickActions: { actions, maxChars, options }` to configure them. They share the `browser` binding, need no Worker Loader, and `ctx` is resolved from the current Agent automatically (you only need to pass it outside an Agent). For the stateless tools _without_ the CDP tool, import `createQuickActionTools` directly from `@cloudflare/think/tools/browser`.

`browser_execute` is backed by a codemode runtime with the `cdp` connector: the model writes async arrow functions that run in a sandboxed Worker isolate, with `cdp.send()`, `cdp.attachToTarget()`, `cdp.spec()` (the live, normalized protocol description), session helpers (`cdp.startSession()`, `cdp.sessionInfo()`, `cdp.closeSession()`), and debug-log helpers. Executions are recorded for abort-and-replay, so browser sessions survive approval pauses.

By default each execution gets a fresh browser session (`one-shot`), torn down when the run ends. Pass `session: { mode: "dynamic" }` to let the model promote a session with `cdp.startSession()` so later executions continue in the same browser, or `session: { mode: "reuse", key }` for a named long-lived session. Stale sessions are reclaimed by the connector's `sweep()` — call it from a scheduled task (see `createBrowserRuntime` in `agents/browser` for the connector handle).

> The simplest setup is the unified execute tool above: `createExecuteTool(this)` already includes `cdp.*` alongside `state.*` and `tools.*` when `env.BROWSER` is bound — one tool, one durable history. Use `createBrowserTools` when you want a separate, browser-only tool.

### Combining with Other Tools

Browser tools compose naturally with workspace tools, code execution, MCP, and extensions:

```typescript
import { createBrowserTools } from "@cloudflare/think/tools/browser";
import { createExecuteTool } from "@cloudflare/think/tools/execute";

export class ResearchAgent extends Think<Env> {
  readonly codeTool = false;

  getModel() {
    /* ... */
  }

  getTools() {
    return {
      // Browse the web (separate browser-only tool with its own history)
      ...createBrowserTools({
        ctx: this.ctx,
        browser: this.env.BROWSER,
        loader: this.env.LOADER
      }),
      // Run sandboxed code against workspace files
      execute: createExecuteTool(this)
    };
  }
}
```

### Custom CDP Endpoint

To connect to a Chrome instance running outside of Browser Rendering (e.g. `chrome --remote-debugging-port=9222`), pass `cdpUrl` instead of `browser`:

```typescript
createBrowserTools({
  ctx: this.ctx,
  cdpUrl: "http://localhost:9222",
  loader: this.env.LOADER
});
```

See [Browse the Web](https://github.com/cloudflare/agents/blob/main/docs/agents/browse-the-web.md) for the full CDP helper API reference, security model, and limitations.

## Extensions

Extensions are dynamically loaded sandboxed Workers that add tools at runtime. The LLM can write extension source code, load it, and use the new tools on the next turn.

### Setup

Extensions require `extensionLoader` (a `worker_loaders` binding) and the `ExtensionManager`:

```typescript
import { Think } from "@cloudflare/think";
import { ExtensionManager } from "@cloudflare/think/extensions";
import { createExtensionTools } from "@cloudflare/think/tools/extensions";

export class MyAgent extends Think<Env> {
  extensionLoader = this.env.LOADER;

  getModel() {
    /* ... */
  }
}
```

When `extensionLoader` is set, Think automatically creates an `ExtensionManager` and loads extensions from `getExtensions()`.

### Static Extensions

Define extensions that load at startup:

```typescript
export class MyAgent extends Think<Env> {
  extensionLoader = this.env.LOADER;

  getModel() {
    /* ... */
  }

  getExtensions() {
    return [
      {
        manifest: {
          name: "math",
          version: "1.0.0",
          permissions: { network: false }
        },
        source: `({
          tools: {
            add: {
              description: "Add two numbers",
              parameters: {
                a: { type: "number" },
                b: { type: "number" }
              },
              execute: async ({ a, b }) => ({ result: a + b })
            }
          }
        })`
      }
    ];
  }
}
```

Extension tools are namespaced — `math` extension with `add` tool becomes `math_add` in the model's tool set.

### LLM-Driven Extensions

Give the model `createExtensionTools` so it can load extensions dynamically:

```typescript
import { createExtensionTools } from "@cloudflare/think/tools/extensions";

export class MyAgent extends Think<Env> {
  extensionLoader = this.env.LOADER;

  getModel() {
    /* ... */
  }

  getTools() {
    return {
      ...createExtensionTools({ manager: this.extensionManager! }),
      ...this.extensionManager!.getTools()
    };
  }
}
```

This gives the model two tools:

- `load_extension` — load a new extension from JavaScript source
- `list_extensions` — list currently loaded extensions

Loaded extensions persist across DO restarts via `extensionManager.restore()`.

### Extension Context Blocks

Extensions can declare context blocks in their manifest. These are automatically registered with the Session:

```typescript
getExtensions() {
  return [{
    manifest: {
      name: "notes",
      version: "1.0.0",
      permissions: { network: false },
      context: [
        { label: "scratchpad", description: "Extension scratch space", maxTokens: 500 }
      ]
    },
    source: `({ tools: { /* ... */ } })`
  }];
}
```

The context block is registered as `notes_scratchpad` (namespaced by extension name).

## Workspace Tools for Custom Backends

The individual tool factories are exported for use with custom storage backends that implement the operations interfaces:

```typescript
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createListTool,
  createFindTool,
  createGrepTool,
  createDeleteTool
} from "@cloudflare/think/tools/workspace";
import type {
  ReadOperations,
  WriteOperations,
  EditOperations,
  ListOperations,
  FindOperations,
  GrepOperations,
  DeleteOperations
} from "@cloudflare/think/tools/workspace";
```

Implement the operations interface for your storage backend:

```typescript
const myReadOps: ReadOperations = {
  readFile: async (path) => fetchFromMyStorage(path),
  readFileBytes: async (path) => fetchBytesFromMyStorage(path),
  stat: async (path) => getFileInfo(path)
};

const readTool = createReadTool({ ops: myReadOps });
```

Or create the full set from a Workspace:

```typescript
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";

const tools = createWorkspaceTools(myCustomWorkspace);
const toolsWithoutBash = createWorkspaceTools(myCustomWorkspace, {
  bash: false
});
```
