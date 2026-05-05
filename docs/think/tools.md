# Tools

Think provides built-in workspace file tools on every turn, plus integration points for custom tools, code execution, and dynamic extensions.

## Tool Merge Order

On every turn, Think merges tools from multiple sources. Later sources override earlier ones if names collide:

1. **Workspace tools** — `read`, `write`, `edit`, `list`, `find`, `grep`, `delete` (built-in)
2. **`getTools()`** — your custom server-side tools
3. **Session tools** — `set_context`, `load_context`, `search_context` (from `configureSession`)
4. **Extension tools** — tools from loaded extensions (prefixed by extension name)
5. **MCP tools** — from connected MCP servers
6. **Client tools** — from the browser (see [Client Tools](./client-tools.md))
7. **Caller tools** — from `chat()` options when used as a sub-agent

## Built-in Workspace Tools

Every Think agent gets `this.workspace` — a virtual filesystem backed by the Durable Object's SQLite storage. Workspace tools are automatically available to the model with no configuration.

| Tool     | Description                                                                 |
| -------- | --------------------------------------------------------------------------- |
| `read`   | Read text with line numbers; pass images and PDFs to multimodal models      |
| `write`  | Write content to a file (creates parent directories)                        |
| `edit`   | Apply a find-and-replace edit to an existing file (supports fuzzy matching) |
| `list`   | List files and directories in a path                                        |
| `find`   | Find files matching a glob pattern                                          |
| `grep`   | Search file contents by regex or fixed string                               |
| `delete` | Delete a file or directory                                                  |

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
        await this.workspace.rm(path);
        return { deleted: path };
      }
    })
  };
}
```

When `needsApproval` returns `true`, the tool call is sent to the client for approval. The conversation pauses until the client responds with `CF_AGENT_TOOL_APPROVAL`. See [Client Tools](./client-tools.md) for the approval flow.

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

Think inherits MCP client support from the `Agent` base class. MCP tools from connected servers are automatically merged into every turn.

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

See [Connecting to MCP Servers](../mcp-client.md) for full MCP client documentation.

## Code Execution Tool

Let the LLM write and run JavaScript in a sandboxed Worker. Requires `@cloudflare/codemode` and a `worker_loaders` binding.

```sh
npm install @cloudflare/codemode
```

```typescript
import { Think } from "@cloudflare/think";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";

export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  getTools() {
    return {
      execute: createExecuteTool({
        tools: createWorkspaceTools(this.workspace),
        loader: this.env.LOADER
      })
    };
  }
}
```

Add the `worker_loaders` binding in `wrangler.jsonc`:

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

The sandbox has access to `codemode.*` tool calls. For richer filesystem access, pass a `state` backend:

```typescript
import { createWorkspaceStateBackend } from "@cloudflare/shell";

createExecuteTool({
  tools: myDomainTools,
  state: createWorkspaceStateBackend(this.workspace),
  loader: this.env.LOADER
});
// sandbox: codemode.myTool() AND state.readFile(), state.planEdits(), etc.
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

This adds two tools to your agent:

| Tool              | Description                                                                             |
| ----------------- | --------------------------------------------------------------------------------------- |
| `browser_search`  | Query the CDP protocol spec to discover commands, events, and types                     |
| `browser_execute` | Run CDP commands against a live browser session (screenshots, DOM reads, JS evaluation) |

Both tools use the code-mode pattern — the model writes JavaScript async arrow functions that run in a sandboxed Worker isolate. In `browser_search`, the sandbox has access to `spec.get()` which returns the full normalized CDP protocol. In `browser_execute`, the sandbox has access to `cdp.send()`, `cdp.attachToTarget()`, and debug log helpers.

Each `browser_execute` call opens a fresh browser session and closes it when the code finishes. For page-scoped CDP commands (`Page.*`, `Runtime.*`, `DOM.*`), the model must create a target, attach to it, and pass the `sessionId`.

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
      // Browse the web
      ...createBrowserTools({
        browser: this.env.BROWSER,
        loader: this.env.LOADER
      }),
      // Run sandboxed code against workspace files
      execute: createExecuteTool({
        tools: createWorkspaceTools(this.workspace),
        loader: this.env.LOADER
      })
    };
  }
}
```

### Custom CDP Endpoint

To connect to a Chrome instance running outside of Browser Rendering (e.g. `chrome --remote-debugging-port=9222`), pass `cdpUrl` instead of `browser`:

```typescript
createBrowserTools({
  cdpUrl: "http://localhost:9222",
  loader: this.env.LOADER
});
```

See [Browse the Web](../browse-the-web.md) for the full CDP helper API reference, security model, and limitations.

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
```
