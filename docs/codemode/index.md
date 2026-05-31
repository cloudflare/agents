# Codemode

Codemode lets LLMs write and execute TypeScript instead of making individual tool calls. The model gets one tool (`codemode`) that executes code in a sandboxed Worker. Inside the sandbox, connector SDKs and a platform discovery SDK are available as globals.

## Concepts

- [Connectors](./connectors.md) — class-based integrations that bridge external services
- [Sessions](./sessions.md) — DurableObject facets that hold per-connector state and manage approvals
- [Skills](./skills.md) — reusable code patterns that combine connector methods
- [Search & Describe](./search-and-describe.md) — in-sandbox discovery via the `codemode` platform SDK
- [Approvals & Simulation](./approvals.md) — annotation-based HITL with provisional results
- [Executor State](./executor-state.md) — persistent scratchpad for working memory across tool calls
- [Vite Plugin](./vite-plugin.md) — auto-discovers `*.codemode.ts` files and exports connector classes

## Architecture

```
Agent DO
  ├─ facet: codemode:executor   (working memory — set/get)
  ├─ facet: codemode:github     (CodemodeSession → GithubConnector)
  ├─ facet: codemode:repoApi    (CodemodeSession → RepoApiConnector)
  └─ createProxyTool
       ├─ spawns session facets
       ├─ builds platform SDK (codemode namespace)
       └─ executes code in DynamicWorkerExecutor sandbox

Sandbox (isolated Worker)
  ├─ codemode.search("query")           → platform provider (ToolDispatcher)
  ├─ codemode.describe("github.foo")    → platform provider
  ├─ codemode.set("key", value)         → executor facet storage
  ├─ github.list_pull_requests(args)    → session facet → connector RPC
  └─ repoApi.request(args)             → session facet → connector RPC
```

## Quick Start

```ts
// github.codemode.ts
import { McpConnector, type McpConnectionLike } from "@cloudflare/codemode";

export class GithubConnector extends McpConnector<Env> {
  #conn?: McpConnectionLike;
  setConnection(conn: McpConnectionLike) {
    this.#conn = conn;
  }

  name() {
    return "github";
  }
  protected instructions() {
    return "Use for GitHub operations.";
  }
  protected createConnection() {
    return this.#conn!;
  }
}
```

```ts
// server.ts
import { createProxyTool, DynamicWorkerExecutor } from "@cloudflare/codemode";
import { GithubConnector } from "./github.codemode" with { type: "connectors" };

export class Chat extends AIChatAgent<Env> {
  async onChatMessage() {
    const github = new GithubConnector(this.ctx as any, this.env);
    github.setConnection(conn);

    const result = streamText({
      tools: {
        codemode: createProxyTool({
          ctx: this.ctx,
          executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
          connectors: [github]
        })
      }
    });
  }
}
```

The model writes code like:

```ts
codemode({
  code: `async () => {
    const matches = await codemode.search("pull request");
    const docs = await codemode.describe(matches.results[0].path);
    return await github.list_pull_requests({ owner: "cloudflare", repo: "agents" });
  }`
});
```
