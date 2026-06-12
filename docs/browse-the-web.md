# Browse the Web (Experimental)

Browser tools give your agents full access to the Chrome DevTools Protocol (CDP) through the code mode pattern. Instead of a fixed set of browser actions (click, screenshot, navigate), the LLM writes code that runs CDP commands against a live browser session — accessing all domains, commands, events, and types in the protocol.

One durable tool is provided:

- **`browser_execute`** — run sandboxed code against a live browser via the `cdp` connector. Executions are recorded on a durable codemode runtime (abort-and-replay), so a run can pause for approval and resume with its browser session intact.

> **Experimental** — this feature may have breaking changes in future releases.

## When to use browser tools

Browser tools are useful when your agent needs to:

- **Inspect web pages** — DOM structure, computed styles, accessibility tree
- **Debug frontend issues** — network waterfalls, console errors, performance traces
- **Scrape structured data** — extract content from rendered pages
- **Capture screenshots or PDFs** — visual snapshots of web content
- **Profile performance** — Core Web Vitals, JavaScript profiling, memory analysis

For simple page fetches where you do not need a full browser, `fetch()` is simpler.

## Installation

Browser tools require the Agents SDK and `@cloudflare/codemode`:

```sh
npm install agents @cloudflare/codemode ai zod
```

## Quick Start

### 1. Configure bindings

Add the Browser Rendering and Worker Loader bindings to your `wrangler.jsonc`:

```jsonc
// wrangler.jsonc
{
  "browser": { "binding": "BROWSER" },
  "worker_loaders": [{ "binding": "LOADER" }],
  "compatibility_flags": ["nodejs_compat"]
}
```

### 2. Export the runtime class

The durable runtime behind the tool lives in a Durable Object facet, so your worker entry must export it (the `@cloudflare/codemode/vite` plugin does this automatically):

```ts
export { CodemodeRuntime } from "agents/browser";
```

### 3. Create browser tools

Browser tools must be created from inside a Durable Object (e.g. an Agent) — the runtime facet and the session store live on its `ctx`:

```ts
import { createBrowserTools } from "agents/browser/ai";

const browserTools = createBrowserTools({
  ctx: this.ctx,
  browser: this.env.BROWSER,
  loader: this.env.LOADER
});
```

If you need to connect to a custom CDP endpoint instead of the Browser Rendering binding, pass `cdpUrl`.

### 4. Use with streamText

Pass browser tools alongside your other tools:

```ts
import { streamText } from "ai";

const result = streamText({
  model,
  system: "You are a helpful assistant that can inspect web pages.",
  messages,
  tools: {
    ...browserTools,
    ...otherTools
  }
});
```

When the LLM uses `browser_execute`, the `code` field is an async arrow function. Connector methods take a single object argument:

```javascript
async () => {
  const { targetId } = await cdp.send({
    method: "Target.createTarget",
    params: { url: "https://example.com" }
  });
  const { sessionId } = await cdp.attachToTarget({ targetId });
  const { root } = await cdp.send({ method: "DOM.getDocument", sessionId });
  const { outerHTML } = await cdp.send({
    method: "DOM.getOuterHTML",
    params: { nodeId: root.nodeId },
    sessionId
  });
  await cdp.send({ method: "Target.closeTarget", params: { targetId } });
  return outerHTML;
};
```

To discover protocol surface, the model calls `cdp.spec()` — the live, normalized CDP protocol description (domains with commands, events, and types) — or uses the runtime's built-in `codemode.search` / `codemode.describe`.

## Use with an Agent

The typical pattern is to create browser tools inside the agent's message handler:

```ts
import { Agent } from "agents";
import { createBrowserTools } from "agents/browser/ai";
import { streamText, convertToModelMessages, stepCountIs } from "ai";

export class MyAgent extends Agent<Env> {
  async onChatMessage() {
    const browserTools = createBrowserTools({
      ctx: this.ctx,
      browser: this.env.BROWSER,
      loader: this.env.LOADER
    });

    const result = streamText({
      model,
      system: "You can browse the web and inspect pages.",
      messages: await convertToModelMessages(this.messages),
      tools: {
        ...browserTools,
        ...this.mcp.getAITools()
      },
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
  }
}
```

> Using `@cloudflare/think`? The unified execute tool (`createExecuteTool(this)`) already includes `cdp.*` alongside `state.*` and `tools.*` when `env.BROWSER` is bound. See the [Think tools documentation](./think/tools.md).

## TanStack AI

For TanStack AI, use the `/tanstack-ai` export:

```ts
import { createBrowserTools } from "agents/browser/tanstack-ai";
import { chat } from "@tanstack/ai";

const browserTools = createBrowserTools({
  ctx: this.ctx,
  browser: env.BROWSER,
  loader: env.LOADER
});

const stream = chat({
  adapter: openaiText("gpt-4o"),
  tools: [...browserTools, ...otherTools],
  messages
});
```

## Session lifecycle

By default each execution gets a fresh browser session, torn down when the run ends (`one-shot`). Two more modes via the `session` option:

```ts
createBrowserTools({
  ctx: this.ctx,
  browser: this.env.BROWSER,
  loader: this.env.LOADER,
  session: { mode: "dynamic" } // or { mode: "reuse", key: "main" }
});
```

- **`one-shot`** (default) — fresh session per execution; deterministic cleanup when the execution reaches a terminal status.
- **`reuse`** — a named shared session that persists across executions until explicitly closed or swept.
- **`dynamic`** — starts one-shot; the model can promote the session with `cdp.startSession()` (e.g. after logging in to a page) so later executions continue in the same browser.

In `reuse`/`dynamic` modes the sandbox additionally gets `cdp.startSession()`, `cdp.sessionInfo()`, `cdp.closeSession()`, and `cdp.resetSession()`.

Sessions are tracked durably (in the DO's storage), so they survive hibernation and approval pauses — a run that pauses for human approval resumes with its browser session, tabs, and cookies intact. If Browser Rendering expires the session while a pause waits, the resume surfaces a clear error and the model starts over.

### Host-side management and cleanup

`createBrowserRuntime` returns the moving parts for host-side wiring:

```ts
import { createBrowserRuntime } from "agents/browser/ai";

const { runtime, connector, tools } = createBrowserRuntime({
  ctx: this.ctx,
  browser: this.env.BROWSER,
  loader: this.env.LOADER,
  session: { mode: "dynamic" }
});

await connector.sessionInfo(); // shared session id + open targets
await connector.closeSession(); // close the shared session
await connector.sweep(); // reclaim expired/stale sessions — call from a scheduled task
await runtime.expirePaused(); // reject stale never-approved pauses, freeing their sessions
```

## Execution model

- LLM-generated code runs in a Worker sandbox; the CDP WebSocket and the browser session stay in the host worker.
- Every `cdp.*` call is recorded in the runtime's durable log. If a run pauses (approval) or the sandbox aborts, resuming replays the log and continues — which is why connector calls must be sequential and deterministic (wrap nondeterministic non-connector work in `codemode.step`).
- `cdp.attachToTarget` returns `{ sessionId }` where the id is a **stable session handle** (not a raw CDP session id), so handles stay valid across pause/resume reconnects.
- The protocol spec is fetched from the live browser, normalized, and cached per binding.

## CDP connector API

Inside `browser_execute`, the `cdp` namespace provides (all methods take one object argument):

| Method                                                  | Description                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `cdp.send({ method, params?, sessionId?, timeoutMs? })` | Send a CDP command and wait for the response                                   |
| `cdp.attachToTarget({ targetId, timeoutMs? })`          | Attach to a target; returns `{ sessionId }` for page-scoped `send` calls       |
| `cdp.spec()`                                            | The searchable, normalized CDP protocol spec                                   |
| `cdp.getDebugLog({ limit? })`                           | Recent CDP traffic (sends, receives, warnings) for this execution's connection |
| `cdp.clearDebugLog()`                                   | Clear the debug log buffer                                                     |
| `cdp.startSession()` _(reuse/dynamic)_                  | Promote/ensure the shared session; returns its info                            |
| `cdp.sessionInfo()` _(reuse/dynamic)_                   | Shared session info, or `null`                                                 |
| `cdp.closeSession()` _(reuse/dynamic)_                  | Close the shared session                                                       |
| `cdp.resetSession()` _(reuse/dynamic)_                  | Close and replace the shared session                                           |

## Configuration

### `createBrowserTools(options)` / `createBrowserRuntime(options)`

| Option       | Type                             | Default    | Description                                                |
| ------------ | -------------------------------- | ---------- | ---------------------------------------------------------- |
| `ctx`        | `DurableObjectState`             | required   | The DO hosting the runtime facet and session store         |
| `browser`    | `BrowserBinding`                 | —          | Browser Rendering binding                                  |
| `cdpUrl`     | `string`                         | —          | Optional override for a custom CDP endpoint                |
| `cdpHeaders` | `Record<string, string>`         | —          | Headers for CDP URL discovery (e.g. Cloudflare Access)     |
| `loader`     | `WorkerLoader`                   | required   | Worker Loader binding for sandboxed execution              |
| `session`    | `BrowserConnectorSessionOptions` | `one-shot` | Session lifecycle mode                                     |
| `store`      | `BrowserSessionStore`            | DO storage | Durable store for session ids                              |
| `timeout`    | `number`                         | `30000`    | Execution timeout (also the per-CDP-command timeout)       |
| `name`       | `string`                         | `browser`  | Runtime name — the durable identity of executions/snippets |

Either `browser` or `cdpUrl` must be provided. When both are set, `cdpUrl` takes priority.

### Raw access

For custom integrations, import the building blocks directly:

```ts
import { BrowserConnector, CdpSession, connectUrl } from "agents/browser";

// Connect to a custom CDP endpoint
const session = await connectUrl("http://localhost:9222");
const version = await session.send("Browser.getVersion");
session.close();

// Or plug the connector into your own codemode runtime
const connector = new BrowserConnector(this.ctx, {
  browser: this.env.BROWSER,
  store,
  session: { mode: "dynamic" }
});
```

## Local development

Recent Wrangler releases support Browser Rendering in local development. `npx wrangler dev` provisions the browser automatically, so the same `browser: env.BROWSER` setup works locally and when deployed.

Use `cdpUrl` only when you intentionally want to connect to some other CDP-compatible browser endpoint, such as a tunnel or a manually managed Chrome instance.

## Security considerations

- LLM-generated code runs in **isolated Worker sandboxes** — each execution gets its own Worker instance
- External network access (`fetch`, `connect`) is **blocked** in the sandbox at the runtime level
- CDP commands are dispatched via Workers RPC — the WebSocket lives in the host, not the sandbox
- The CDP spec stays on the server — only query results flow to the LLM
- Completed results are truncated to approximately 6,000 tokens to prevent context window overflow; the full result is kept on the execution record

## Current limitations

- **Sequential connector calls** — the durable replay log requires deterministic ordering, so model code must not `Promise.all` CDP calls (the tool instructions enforce this).
- **Local development depends on Wrangler support** — if Browser Rendering local mode is unavailable in your environment, upgrade Wrangler or provide `cdpUrl` explicitly. The local simulator also differs from production in places (e.g. session DELETE is a no-op).
- **No authenticated sessions out of the box** — the browser starts without cookies or login state, but with `dynamic`/`reuse` modes a logged-in session can be kept alive across executions.
- Requires `@cloudflare/codemode` as a peer dependency

## Example

See [`examples/ai-chat/`](../examples/ai-chat/) for a working example that combines browser tools with other AI SDK tools, MCP servers, and tool approval, and [`examples/codemode-connectors/`](../examples/codemode-connectors/) for the connector playground (including in-sandbox approvals).
