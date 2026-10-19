# Tools

Think provides built-in workspace file tools on every turn, plus integration points for custom tools, code execution, and dynamic extensions.

## Tool Merge Order

On every turn, Think merges tools from multiple sources. Later sources override earlier ones if names collide:

1. **Workspace tools** — `read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, plus `exec` and `publish` when configured (built-in)
2. **`getTools()`** — your custom server-side tools
3. **Extension tools** — tools from loaded extensions (prefixed by extension name)
4. **Context tools** — `set_context`, `search_context` (from `configureContext`)
5. **Skill tools** — `activate_skill`, `read_skill_resource`, `run_skill_script` (from `getSkills()`)
6. **MCP tools** — from connected MCP servers (when `includeMcpTools` is enabled)
7. **Client tools** — from the browser (see [Client Tools](./client-tools.md))

Tools belong to the agent running the turn. For parent-child orchestration,
use [Agent Tools](https://github.com/cloudflare/agents/blob/main/docs/agents/agent-tools.md) instead of passing one-off tools through
`chat()`.

## Built-in Workspace Tools

Every Think agent gets `this.workspace`: a `Workspace` from [`@cloudflare/computer`](https://github.com/cloudflare/computer), stored in the Durable Object's SQLite. Think adds Computer's AI SDK tools to every turn with no configuration.

| Tool      | Description                                                                         |
| --------- | ----------------------------------------------------------------------------------- |
| `read`    | Read text with line and byte paging; pass images and PDFs to multimodal models      |
| `ls`      | List files and directories in a path, with pagination                               |
| `find`    | Find files matching a glob pattern                                                  |
| `grep`    | Search file contents by regex or fixed string                                       |
| `write`   | Write content to a file (creates parent directories)                                |
| `edit`    | Apply exact text replacements to a file, falling back to whitespace-tolerant search |
| `delete`  | Delete a file or directory                                                          |
| `exec`    | Run a command or module on one of the Workspace's execution backends                |
| `publish` | Share a workspace file through a presigned URL, when the Workspace has assets       |

Paths are absolute. Computer's tools and backends treat `/workspace` as the working root, and Think writes its own files there too.

### Running code with `exec`

The default Workspace has no execution backends, so there is no `exec` tool until you add one. Configure the backends, and the modules they offer, on the Workspace:

```typescript
import { Think } from "@cloudflare/think";
import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";

export class MyAgent extends Think<Env> {
  override workspace = new Workspace({
    storage: this.ctx.storage,
    git: createGitClient(),
    backends: [
      new WorkerJavaScriptBackend({
        id: "js",
        loader: this.env.LOADER,
        access: "read-write",
        modules: { "ws:git": createGitModule() }
      })
    ]
  });

  getModel() {
    /* ... */
  }
}
```

Computer ships a JavaScript backend and a just-bash shell backend that run in Dynamic Workers, and a container backend with a full Linux userland. See the [Computer README](https://github.com/cloudflare/computer/tree/main/packages/computer#choosing-a-backend) for each backend's bindings.

### Calling the agent's tools from code

Give a JavaScript backend a `ws:tools` module, and code the model runs with `exec` can import the agent's tools. Files come from `node:fs/promises`, so serve `getTools()` rather than the workspace tools:

```typescript
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import { forAISDKTools } from "@cloudflare/computer/tools/ai-sdk";

new WorkerJavaScriptBackend({
  id: "js",
  loader: this.env.LOADER,
  modules: {
    "ws:tools": createToolBindings(forAISDKTools(() => this.getTools()))
  }
});
```

```ts
import { readFile } from "node:fs/promises";
import { getWeather } from "ws:tools";

export default async function () {
  const cities = JSON.parse(await readFile("/workspace/cities.json", "utf8"));
  const reports = [];
  for (const city of cities) reports.push((await getWeather({ city })).text);
  return reports;
}
```

Tools that need approval, and tools that run in the browser, are not exported: nothing can approve or run them from code. Calls from code do not go through `beforeToolCall`. See [`ws:tools`](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#wstools) for how calls and results work.

### Changing the tools

`exec` offers every backend the Workspace has, and each backend describes itself to the model. To change a built-in tool, return a tool with the same name from `getTools()`; it replaces the built-in. To hide tools for a turn, return `activeTools` from `beforeTurn`.

### A shared workspace

To work in a Workspace another Durable Object owns, wrap `getWorkspace` in `lazyWorkspace`. The owner is only contacted when a turn first touches a file:

```typescript
import { getWorkspace } from "@cloudflare/computer";
import { Think, lazyWorkspace } from "@cloudflare/think";

export class Chat extends Think<Env> {
  override workspace = lazyWorkspace(async () =>
    getWorkspace(await this.parentAgent(Directory))
  );
}
```

Every Think agent can hand out its Workspace this way: `getWorkspace(stub)` calls the agent's `__getWorkspaceStub()` method over RPC. A lazy Workspace gets the file tools but no `exec`.

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

Custom tools are merged with workspace tools automatically. If a custom tool has the same name as a workspace tool, the custom tool wins.

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
        await this.workspace.fs.rm(path);
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

## MCP Tools

Think inherits MCP client support from the `Agent` base class. By default, tools from connected MCP servers are converted to AI SDK tools and merged into every turn.

Set `waitForMcpConnections` to ensure MCP servers are connected before the inference loop runs:

```typescript
export class MyAgent extends Think<Env> {
  waitForMcpConnections = true; // default 10s timeout
  // or: waitForMcpConnections = { timeout: 5000 };

  getModel() {
    /* ... */
  }
}
```

If you expose MCP tools through Code Mode or another mechanism outside Think's automatic tool set, disable direct AI SDK tool exposure:

```typescript
export class MyAgent extends Think<Env> {
  includeMcpTools = false;
  waitForMcpConnections = true;

  getModel() {
    /* ... */
  }
}
```

`includeMcpTools = false` suppresses only Think's automatic `this.mcp.getAITools()` merge. MCP registration, restoration, discovery, waiting, raw catalog access, direct calls, Code Mode connectors, and explicit application calls to `this.mcp.getAITools()` continue to work. This avoids converting every MCP JSON Schema to Zod when the model only uses the raw MCP connection through the connector.

Use the class property instead of `beforeTurn({ activeTools: [] })` for this purpose. `activeTools` limits tools after turn assembly; MCP schema conversion happens while Think assembles the context, before `beforeTurn` runs.

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

See [Connecting to MCP Servers](https://github.com/cloudflare/agents/blob/main/docs/agents/mcp-client.md) for full MCP client documentation.

## Code Execution Tool

> **Deprecated.** Use `exec` on a JavaScript backend with `ws:tools` instead; see [Calling the agent's tools from code](#calling-the-agents-tools-from-code). `createExecuteTool` will be removed along with `@cloudflare/codemode`.

Let the LLM write and run TypeScript in a sandboxed Worker, recorded on a durable codemode runtime (abort-and-replay, human approvals, audit trail, reusable snippets). Requires `@cloudflare/codemode` and a `worker_loaders` binding.

```sh
npm install @cloudflare/codemode
```

The one-liner infers the executor from `env.LOADER` and a live browser (`cdp.*`) from `env.BROWSER` if bound. Pass tools for `tools.*`, including the workspace tools if the sandbox should reach the workspace:

```typescript
import { Think } from "@cloudflare/think";
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";
import { createExecuteTool } from "@cloudflare/think/tools/execute";

export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  getTools() {
    return {
      execute: createExecuteTool(this, {
        tools: createAITools({ workspace: this.workspace })
      })
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
// Worker entry — the runtime lives in a Durable Object facet, so the class
// must be exported. The @cloudflare/codemode/vite plugin can do this
// automatically; otherwise export it explicitly.
export { CodemodeRuntime } from "@cloudflare/codemode";
```

Each missing piece fails with an error naming the step.

Inside the sandbox the model sees typed namespaces plus the platform SDK:

- `tools.*` — your AI SDK tools (object args, validated against their schemas). Only tools with an `execute` function are exposed — client-side tools can't run in the sandbox.
- `cdp.*` — the browser, when a Browser Rendering binding is configured. The execute tool defaults to `session: { mode: "dynamic" }`: sessions are per-execution unless the model promotes one with `cdp.startSession()`.
- `codemode.search` / `codemode.describe` / `codemode.step` / `codemode.run` — discovery, side-effect boundaries, and saved snippets

Or pass fully explicit options (no agent inference):

```typescript
createExecuteTool({
  ctx: this.ctx,
  tools: myDomainTools,
  browser: this.env.BROWSER,
  loader: this.env.LOADER
});
```

### Approvals (human-in-the-loop)

An AI SDK tool with `needsApproval` doesn't run immediately inside the sandbox — calling it **pauses the run durably**. The pause comes back as a normal tool output (`{ status: "paused", executionId, pending }`), the model tells the user what it needs, and the turn ends. Note this differs from the client-side approval flow for plain `getTools()` tools: inside the sandbox a function-valued `needsApproval` can't be evaluated against the call's arguments ahead of time, so it conservatively **always** requires approval. Think ships built-in callables to resolve it:

- `approveExecution(executionId)` — resumes the run where it stopped (already-done work is replayed, not re-executed); the outcome replaces the paused output in the transcript and the chat auto-continues.
- `rejectExecution(executionId, reason?, { autoContinue? })` — ends the run with `{ status: "rejected", reason }` so the model can adapt. Pass `{ autoContinue: false }` to record the rejection without starting another model turn.

Either way, the text and reasoning the model wrote after the paused output (its "waiting for approval" reply) are removed from that assistant message, so the continuation does not read a stale pending state next to the real outcome.

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

> The simplest setup is the unified execute tool above: `createExecuteTool(this)` already includes `cdp.*` alongside `tools.*` when `env.BROWSER` is bound — one tool, one durable history. Use `createBrowserTools` when you want a separate, browser-only tool.

### Combining with Other Tools

Browser tools compose naturally with workspace tools, code execution, MCP, and extensions:

```typescript
import { createBrowserTools } from "@cloudflare/think/tools/browser";
import { createExecuteTool } from "@cloudflare/think/tools/execute";

export class ResearchAgent extends Think<Env> {
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

Extensions can declare context blocks in their manifest. These are automatically added to the agent's context blocks:

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
