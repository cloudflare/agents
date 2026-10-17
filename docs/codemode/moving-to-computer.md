# Moving to `@cloudflare/computer`

`@cloudflare/codemode` is deprecated. To let a model run code, give it the `exec` tool from [`@cloudflare/computer`](https://github.com/cloudflare/computer) on a `Workspace` with a `WorkerJavaScriptBackend`. Codemode keeps working until it is removed, so nothing breaks when you upgrade.

## What replaces what

| Codemode                                      | Computer                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `createCodeTool` (`/ai`, `/tanstack-ai`)      | The `exec` tool from `createAITools`, `createTanStackTools` or `createPiTools`    |
| `DynamicWorkerExecutor`, `Executor`           | `WorkerJavaScriptBackend` and `workspace.runtime.exec()`                          |
| Tools as `codemode.*` globals, `ToolProvider` | Tools imported from `ws:tools`, built with `createToolBindings()`                 |
| `CodemodeConnector`, `OpenApiConnector`       | A host module, `modules: { "ws:<name>": { fn } }`                                 |
| `McpConnector`, `ToolSetConnector`            | `ws:tools` with `forAISDKTools(() => tools)`, for example `this.mcp.getAITools()` |
| `workspace.*` tools in the sandbox            | `node:fs` in the code                                                             |
| `createCodemodeRuntime`, approvals, replay    | Not yet. See [Approvals](#approvals)                                              |

These have no replacement:

- `codeMcpServer` and `openApiMcpServer` (`/mcp`)
- `IframeSandboxExecutor` and `createBrowserCodeTool` (`/browser`)
- Rollback (`revert`, `runtime.rollback()`)
- Snippets (`saveSnippet`, `codemode.run`). Save the code as a Workspace file and import it instead.
- The Vite plugin (`/vite`)
- `generateTypes`, `generateTypesFromJsonSchema`, `jsonSchemaToType`, `normalizeCode`, `sanitizeToolName`, `truncateResult` and `truncateResponse`

## A code tool

Before:

```ts
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";

const codemode = createCodeTool({
  tools: myTools,
  executor: new DynamicWorkerExecutor({ loader: env.LOADER })
});
streamText({ model, messages, tools: { codemode } });
```

After:

```ts
import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createToolBindings } from "@cloudflare/computer/modules/tools";
import {
  createAITools,
  forAISDKTools
} from "@cloudflare/computer/tools/ai-sdk";

const workspace = new Workspace({
  storage: this.ctx.storage,
  backends: [
    new WorkerJavaScriptBackend({
      loader: this.env.LOADER,
      modules: { "ws:tools": createToolBindings(forAISDKTools(() => myTools)) }
    })
  ]
});

streamText({
  model,
  messages,
  tools: createAITools({ workspace, exec: { "worker-javascript": {} } })
});
```

The model now writes an ES module instead of an arrow function:

```js
import { readFile } from "node:fs/promises";
import { getWeather } from "ws:tools";

export default async function () {
  const cities = JSON.parse(await readFile("/workspace/cities.json", "utf8"));
  return Promise.all(
    cities.map(async (city) => (await getWeather({ city })).text)
  );
}
```

Each `ws:tools` export takes the tool's input object and resolves with `{ text, details, isError }`. `details` holds the tool's own result.

In Think, put the backend on the agent's `workspace`. Think already exposes `exec` once the Workspace has a backend. See [Calling the agent's tools from code](../think/tools.md#calling-the-agents-tools-from-code).

## A connector

A connector's methods become functions of a host module. The functions run in your Durable Object and get the arguments as an array.

Before:

```ts
class RepoApi extends CodemodeConnector<Env> {
  name() {
    return "repo";
  }
  protected tools() {
    return {
      listIssues: {
        description: "List issues.",
        inputSchema: { type: "object" },
        execute: (args) => this.env.REPO.listIssues(args)
      }
    };
  }
}
```

After:

```ts
new WorkerJavaScriptBackend({
  loader: this.env.LOADER,
  modules: {
    "ws:repo": {
      listIssues: ([args]) => this.env.REPO.listIssues(args)
    }
  }
});
```

```js
import { listIssues } from "ws:repo";
export default () => listIssues({ state: "open" });
```

## Approvals

`ws:tools` leaves out tools that set `needsApproval`, and Computer has no durable pause yet. If you rely on codemode's approvals (`requiresApproval`, `runtime.approve()`), keep using codemode for now. The Computer replacement is planned on the JavaScript backend's replay journal.

## Browser tools

`agents/browser` tools (`createBrowserTools`, `browserTool`) run on codemode today. They will move to Computer's JavaScript backend. Until then they keep working as they are.
