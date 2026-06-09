# Codemode

Codemode lets LLMs write and execute TypeScript instead of making individual tool calls. The model gets one tool (`codemode`) that executes code in a sandboxed Worker. Inside the sandbox, connector SDKs and a platform discovery SDK are available as globals.

## Concepts

- [Connectors](./connectors.md) — class-based integrations that bridge external services
- [Runtime](./runtime.md) — durable execution engine; abort-and-replay, rollback, scratchpad state
- [Snippets](./snippets.md) — durable, addressable saved scripts the model learns and reuses
- [Search & Describe](./search-and-describe.md) — in-sandbox discovery via the `codemode` platform SDK
- [Approvals](./approvals.md) — annotation-based HITL via pause and replay
- [Vite Plugin](./vite-plugin.md) — auto-discovers `*.codemode.ts` files and exports connector classes

## Architecture

```
Agent DO
  ├─ runtime handle              (executor, connectors, lifecycle helpers)
  └─ facet: codemode             (CodemodeRuntime — durable log, approvals, state)

runtime.tool()
  ├─ spawns the runtime facet
  ├─ builds platform SDK (codemode namespace)
  └─ runs code in the Executor sandbox

Executor sandbox (isolated Worker)
  ├─ codemode.search("query")           → platform SDK
  ├─ codemode.describe("github.foo")    → platform SDK
  ├─ codemode.get/set("key")            → runtime facet (durable scratchpad)
  ├─ github.list_pull_requests(args)    → runtime decides → connector
  └─ repoApi.request(args)                → runtime decides → connector
```

Every tool call routes through the runtime, which records it in a durable log
and decides whether to execute, replay, or pause. See [Runtime](./runtime.md).

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
import {
  createCodemodeRuntime,
  DynamicWorkerExecutor
} from "@cloudflare/codemode";
import { GithubConnector } from "./github.codemode" with { type: "connectors" };

export class Chat extends AIChatAgent<Env> {
  async onChatMessage() {
    const github = new GithubConnector(this.ctx as any, this.env);
    github.setConnection(conn);

    const runtime = createCodemodeRuntime({
      ctx: this.ctx,
      executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
      connectors: [github]
    });

    const result = streamText({
      tools: {
        codemode: runtime.tool()
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
