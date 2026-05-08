# Browse the Web (Experimental)

Browser tools give your agents full access to the Chrome DevTools Protocol (CDP) through the code mode pattern. Instead of a fixed set of browser actions (click, screenshot, navigate), the LLM writes JavaScript code that runs CDP commands against a live browser session — accessing all domains, commands, events, and types in the protocol.

Two tools are provided:

- **`browser_search`** — query the CDP spec to discover commands, events, and types. The spec is fetched dynamically from the browser's CDP endpoint and cached for performance.
- **`browser_execute`** — run CDP commands against a live browser via a `cdp` helper. By default, each call opens a fresh browser session, executes the code, and closes it. You can opt into reusable sessions for multi-step workflows.

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

### 2. Create browser tools

```ts
import { createBrowserTools } from "agents/browser/ai";

const browserTools = createBrowserTools({
  browser: env.BROWSER,
  loader: env.LOADER
});
```

If you need to connect to a custom CDP endpoint instead of the Browser Rendering binding, pass `cdpUrl`.

To preserve tabs, cookies, local storage, and navigation state across tool calls, enable reusable sessions:

```ts
const browserTools = createBrowserTools({
  browser: env.BROWSER,
  loader: env.LOADER,
  session: {
    mode: "reuse",
    keepAliveMs: 600_000,
    liveView: true
  }
});
```

### 3. Use with streamText

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

When the LLM uses `browser_search`, the `code` field must be JavaScript:

```javascript
async () => {
  const s = await spec.get();
  return s.domains
    .find((d) => d.name === "Network")
    .commands.map((c) => ({ method: c.method, description: c.description }));
};
```

When the LLM uses `browser_execute`, the `code` field must be JavaScript:

```javascript
async () => {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "https://example.com"
  });
  const sessionId = await cdp.attachToTarget(targetId);
  const { root } = await cdp.send("DOM.getDocument", {}, { sessionId });
  const { outerHTML } = await cdp.send(
    "DOM.getOuterHTML",
    {
      nodeId: root.nodeId
    },
    { sessionId }
  );
  await cdp.send("Target.closeTarget", { targetId });
  return outerHTML;
};
```

## Use with an Agent

The typical pattern is to create browser tools inside the agent's message handler:

```ts
import { Agent } from "agents";
import { createBrowserTools } from "agents/browser/ai";
import { streamText, convertToModelMessages, stepCountIs } from "ai";

export class MyAgent extends Agent<Env> {
  async onChatMessage() {
    const browserTools = createBrowserTools({
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

## TanStack AI

For TanStack AI, use the `/tanstack-ai` export:

```ts
import { createBrowserTools } from "agents/browser/tanstack-ai";
import { chat } from "@tanstack/ai";

const browserTools = createBrowserTools({
  browser: env.BROWSER,
  loader: env.LOADER
});

const stream = chat({
  adapter: openaiText("gpt-4o"),
  tools: [...browserTools, ...otherTools],
  messages
});
```

## Execution model

- `browser_search` fetches the live CDP protocol from the browser's `/json/protocol` endpoint and caches it briefly.
- In the default one-shot mode, `browser_execute` opens a fresh browser session for the call, exposes a small `cdp` helper API to sandboxed code, and closes the session when execution finishes.
- In reusable-session mode, `browser_execute` reconnects to the configured Browser Run session for each call, then disconnects the CDP WebSocket without deleting the browser. Browser state remains available until you close/reset the session or Browser Run times it out.
- LLM-generated code runs in a Worker sandbox. CDP traffic stays in the host worker.

## CDP helper API

Inside `browser_execute`, the following functions are available:

### `cdp.send(method, params?, options?)`

Send a CDP command and wait for the response.

| Parameter           | Type      | Description                                               |
| ------------------- | --------- | --------------------------------------------------------- |
| `method`            | `string`  | CDP method (e.g. `"DOM.getDocument"`, `"Network.enable"`) |
| `params`            | `unknown` | Method parameters                                         |
| `options.timeoutMs` | `number`  | Per-command timeout (default: 10s)                        |
| `options.sessionId` | `string`  | Target session ID (required for page-scoped commands)     |

### `cdp.attachToTarget(targetId, options?)`

Attach to a target and get a session ID. Uses `Target.attachToTarget` with `flatten: true`.

| Parameter           | Type     | Description                    |
| ------------------- | -------- | ------------------------------ |
| `targetId`          | `string` | The target to attach to        |
| `options.timeoutMs` | `number` | Timeout for the attach command |

Returns the `sessionId` string.

### `cdp.getDebugLog(limit?)`

Get recent CDP debug log entries (sends, receives, errors). Defaults to the last 50 entries, max 400.

### `cdp.clearDebugLog()`

Clear the debug log buffer.

## Configuration

### `createBrowserTools(options)`

Returns AI SDK tools. In one-shot mode this includes `browser_search` and `browser_execute`. In reusable-session mode this also includes `browser_session_info`, `browser_close_session`, and `browser_reset_session`.

| Option       | Type                     | Default  | Description                                            |
| ------------ | ------------------------ | -------- | ------------------------------------------------------ |
| `browser`    | `Fetcher`                | —        | Browser Rendering binding                              |
| `cdpUrl`     | `string`                 | —        | Optional override for a custom CDP endpoint            |
| `cdpHeaders` | `Record<string, string>` | —        | Headers for CDP URL discovery (e.g. Cloudflare Access) |
| `loader`     | `WorkerLoader`           | required | Worker Loader binding for sandboxed execution          |
| `timeout`    | `number`                 | `30000`  | Execution timeout in milliseconds                      |
| `session`    | `BrowserSessionOptions`  | one-shot | Optional browser session lifecycle                     |

Either `browser` or `cdpUrl` must be provided. When both are set, `cdpUrl` takes priority.

Reusable sessions require the Browser Rendering binding. `cdpUrl` points at an externally managed browser, so the SDK does not create, list, or delete Browser Run sessions for that mode.

### Reusable session options

```ts
createBrowserTools({
  browser: env.BROWSER,
  loader: env.LOADER,
  session: {
    mode: "reuse",
    key: "optional-logical-owner",
    keepAliveMs: 600_000,
    liveView: true,
    onSessionInfo(info) {
      // Broadcast or render session metadata in your UI.
    }
  }
});
```

| Option          | Type                                 | Default     | Description                                                     |
| --------------- | ------------------------------------ | ----------- | --------------------------------------------------------------- |
| `mode`          | `"reuse"`                            | required    | Reuse one Browser Run session across `browser_execute` calls    |
| `key`           | `string`                             | `"default"` | Logical owner key for the reusable session                      |
| `store`         | `BrowserSessionStore`                | memory      | Storage adapter for the Browser Run session id                  |
| `keepAliveMs`   | `number`                             | Browser Run | Browser Run inactivity timeout; Browser Run caps this at 10 min |
| `liveView`      | `boolean`                            | `false`     | Include Live View URLs in session metadata                      |
| `onSessionInfo` | `(info: BrowserSessionInfo) => void` | —           | Callback whenever session metadata is refreshed                 |

The default memory store only persists for the lifetime of the returned tool handlers. If you create browser tools per request and want reuse across requests, provide a durable `store`. Think's `@cloudflare/think/tools/browser` wrapper provides Durable Object storage automatically.

`browser_session_info` lists the active targets and returns fresh Live View URLs when `liveView` is enabled. Live View URLs expire after five minutes if they are not opened; call `browser_session_info` again to refresh them.

Call `browser_close_session` when a task is done to stop browser-hour usage and clear browser state. Call `browser_reset_session` when you need a fresh browser.

### Raw access

For custom integrations, import the building blocks directly:

```ts
import {
  CdpSession,
  connectBrowser,
  connectUrl,
  createBrowserToolHandlers
} from "agents/browser";

// Connect to a custom CDP endpoint
const session = await connectUrl("http://localhost:9222");
const version = await session.send("Browser.getVersion");
session.close();
```

## Local development

Recent Wrangler releases support Browser Rendering in local development. `npx wrangler dev` provisions the browser automatically, so the same `browser: env.BROWSER` setup works locally and when deployed.

Use `cdpUrl` only when you intentionally want to connect to some other CDP-compatible browser endpoint, such as a tunnel or a manually managed Chrome instance.

## Security considerations

- LLM-generated code runs in **isolated Worker sandboxes** — each execution gets its own Worker instance
- External network access (`fetch`, `connect`) is **blocked** in the sandbox at the runtime level
- CDP commands are dispatched via Workers RPC — the WebSocket lives in the host, not the sandbox
- The CDP spec stays on the server — only query results flow to the LLM
- Responses are truncated to approximately 6,000 tokens to prevent context window overflow

## Current limitations

- **One session per execute call by default** — each `browser_execute` invocation opens a fresh browser session unless you opt into reusable sessions.
- **Local development depends on Wrangler support** — if Browser Rendering local mode is unavailable in your environment, upgrade Wrangler or provide `cdpUrl` explicitly.
- **No user-authenticated browser by default** — one-shot sessions start without cookies or login state. Reusable sessions preserve cookies and storage created inside that Browser Run session, but they are not connected to the user's local browser profile.
- Requires `@cloudflare/codemode` as a peer dependency
- Limited to JavaScript execution in the sandbox (no TypeScript syntax)

## Example

See [`examples/ai-chat/`](../examples/ai-chat/) for a working example that combines browser tools with other AI SDK tools, MCP servers, and tool approval.
