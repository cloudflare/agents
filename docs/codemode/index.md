# Codemode

Codemode lets a model use external systems by **writing TypeScript** instead of making individual tool calls. The model gets one tool — `codemode({ code })` — that executes its code in a sandboxed Worker. Inside the sandbox, every integration the developer configured is available as a typed global, and a four-method platform SDK handles discovery, side effects, and reuse.

```ts
// the developer configures this
const runtime = createCodemodeRuntime({ ctx, executor, connectors });
tools: {
  codemode: runtime.tool();
}

// the model writes this
const matches = await codemode.search("pull request");
const docs = await codemode.describe(matches.results[0].path);
const prs = await github.list_pull_requests({
  owner: "cloudflare",
  repo: "agents"
});
```

## Why we think this is a good idea

**Tool descriptions don't scale.** The classic approach generates types for every tool and puts them all in the tool description. Ten tools is fine; a GitHub MCP server plus a Stripe spec plus an internal API is thousands of prompt tokens the model pays for on every request, mostly for tools it won't call. Codemode moves discovery _inside the sandbox_: `codemode.search` and `codemode.describe` return results into the running code, not into the context window. The model pulls exactly the type information it needs, when it needs it.

**Models are better at code than at tool protocols.** Filtering, joining, retrying, looping over pages — in tool-call style each step is a round trip through the model. In code it's just code: the model fetches an OpenAPI spec _as data_ and writes its own three-line lookup instead of us shipping a search endpoint. One sandbox run can do what would otherwise take a dozen tool calls.

**Real work needs durable state.** Creating issues, sending messages, merging PRs — these need human approval, an audit trail, and sometimes an undo. Those concerns have one home, the runtime, instead of being rebuilt per app. The model's code pauses at an approval-required call and continues after approval as if nothing happened.

## The pieces

| Piece          | What it is                                                                                                                             | State                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Executor**   | Runs a block of code once in an isolated sandbox (`DynamicWorkerExecutor` on Workers, `IframeSandboxExecutor` in the browser)          | None — deliberately stateless and replaceable |
| **Connectors** | Classes that bridge an external service (MCP server, OpenAPI spec, AI SDK toolset, anything custom) into the sandbox as a global       | Own their connection/credentials              |
| **Runtime**    | The thing you hold onto: `runtime.tool()` for the model, `pending`/`approve`/`reject`/`rollback` for your app, a durable log behind it | Durable — survives hibernation                |

The sandbox has **no network access**. Model code cannot `fetch`; every effect goes through a connector (which routes through the runtime's log) or through `codemode.step`.

## Configure it (developer)

**1. Add the Vite plugin** — it exports the runtime facet class that `createCodemodeRuntime()` needs:

```ts
// vite.config.ts
import codemode from "@cloudflare/codemode/vite";
import agents from "agents/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default { plugins: [agents(), codemode(), cloudflare()] };
```

**2. Write a connector** — a class per service. Mark only the tools that need a human; everything else executes immediately:

```ts
// github.codemode.ts
import {
  McpConnector,
  type McpConnectionLike,
  type ConnectorTool
} from "@cloudflare/codemode";

export class GithubConnector extends McpConnector<Env> {
  constructor(
    ctx: ExecutionContext,
    env: Env,
    private conn: McpConnectionLike
  ) {
    super(ctx, env);
  }

  name() {
    return "github";
  }
  protected instructions() {
    return "Use for GitHub repositories, issues, and pull requests.";
  }
  protected createConnection() {
    return this.conn;
  }
  protected tool(name: string, t: ConnectorTool): ConnectorTool {
    return name === "create_issue" ? { ...t, requiresApproval: true } : t;
  }
}
```

**3. Create a runtime in your agent** and hand the model `runtime.tool()`. Approval handling is two `@callable` methods:

```ts
// server.ts
import {
  createCodemodeRuntime,
  DynamicWorkerExecutor
} from "@cloudflare/codemode";
import { GithubConnector } from "./github.codemode";

export class Chat extends AIChatAgent<Env> {
  codemode() {
    const conn = this.mcp.mcpConnections[this.githubServerId];
    return createCodemodeRuntime({
      ctx: this.ctx,
      executor: new DynamicWorkerExecutor({ loader: this.env.LOADER }),
      connectors: [
        new GithubConnector(
          this.ctx as unknown as ExecutionContext,
          this.env,
          conn
        )
      ]
    });
  }

  async onChatMessage() {
    return streamText({
      model,
      messages: await convertToModelMessages(this.messages),
      tools: { codemode: this.codemode().tool() }
    });
  }

  @callable()
  listPending() {
    return this.codemode().pending();
  }

  @callable()
  approve(executionId?: string) {
    return this.codemode().approve({ executionId });
  }

  // e.g. a "save this script" button after a run the user liked
  @callable()
  saveSnippet(name: string, executionId?: string) {
    return this.codemode().saveSnippet(name, { executionId });
  }
}
```

That's the whole developer surface: a connector class, `createCodemodeRuntime`, and the runtime handle. The handle is the control plane — `tool()` for the model, `pending()`/`approve()`/`reject()`/`rollback()` for approvals, `executions()` for the audit trail, and `saveSnippet()`/`snippets()`/`deleteSnippet()` for curating what the model gets to reuse.

## Use it (what the model writes)

The sandbox SDK is four methods — discover, learn, do-once, reuse — plus one global per connector:

```ts
async () => {
  // discover: ranked search over connector methods and saved snippets
  const matches = await codemode.search("open pull requests");

  // learn: TypeScript docs for one method — fetched on demand, not pre-dumped
  const docs = await codemode.describe(matches.results[0].path);

  // act: connector methods are typed globals
  const prs = await github.list_pull_requests({
    owner: "cloudflare",
    repo: "agents",
    state: "open"
  });

  // do-once: anything nondeterministic goes in a step so replay is exact
  const stamp = await codemode.step("now", () => Date.now());

  return { count: prs.length, stamp };
};
// reuse: once the developer promotes a run with runtime.saveSnippet("open-prs"),
// the model finds it via codemode.search and re-runs it by name:
const prs = await codemode.run("open-prs", {
  owner: "cloudflare",
  repo: "agents"
});
```

When the code hits an approval-required method (`github.create_issue`), the run pauses and the tool returns `{ status: "paused", executionId, pending }`. After `runtime.approve({ executionId })`, the same code re-runs: completed calls replay from the durable log, the approved action executes for real, and the script continues — the model never writes pause/resume logic.

## How the code actually runs

`runtime.tool()` builds the sandbox per run: it spawns the durable runtime facet on your agent's Durable Object, exposes each connector as an RPC-backed global, injects the `codemode` SDK, and hands the code to the executor. Every connector call routes through the runtime first — replay it, execute it, or pause — so the durable log is always the source of truth:

```
sandbox: github.create_issue(args)
  → runtime.decide("github", "create_issue", args)   // replay | execute | pause
  → GithubConnector.executeTool(...)                 // only on execute
  → runtime.recordResult(...)                        // logged for replay/audit
```

## Docs

- [Connectors](./connectors.md) — write one class per service; MCP, OpenAPI, toolset, and custom bases
- [Runtime](./runtime.md) — both API surfaces (handle + sandbox SDK), the durable log, abort-and-replay
- [Approvals](./approvals.md) — annotations, pause/resume flow, wiring an approval UI
- [Snippets](./snippets.md) — scripts the model saves and reuses
- [Vite Plugin](./vite-plugin.md) — auto-export the `CodemodeRuntime` facet class
