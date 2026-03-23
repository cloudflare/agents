# Browse the Web (Experimental)

Browser tools give your agents full access to the Chrome DevTools Protocol (CDP) through the code mode pattern. Instead of a fixed set of browser actions (click, screenshot, navigate), the LLM writes JavaScript code that runs CDP commands against a live browser session — accessing all 55 domains, 666 commands, and 633 types in the protocol.

Two tools are provided:

- **`browser_search`** — query the CDP spec to discover commands, events, and types. The 1.7MB spec stays server-side; only query results return to the LLM.
- **`browser_execute`** — run CDP commands against a live browser via a `cdp` helper. Each call opens a fresh browser session, executes the code, and closes it.

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

## Quick start

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

For **local development**, add a `CDP_BASE_URL` variable pointing to a local Chrome instance:

```jsonc
{
  "vars": {
    "CDP_BASE_URL": "http://localhost:9222"
  }
}
```

Start Chrome with remote debugging enabled:

```sh
chrome --headless --remote-debugging-port=9222
```

### 2. Create browser tools

```typescript
import { createBrowserTools } from "agents/browser/ai";

const browserTools = createBrowserTools({
  browser: env.BROWSER, // Browser Rendering binding (production)
  cdpUrl: env.CDP_BASE_URL, // Local Chrome URL (development)
  loader: env.LOADER
});
```

### 3. Use with streamText

Pass browser tools alongside your other tools:

```typescript
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

When the LLM uses `browser_search`, it writes code like:

```javascript
async () => {
  const s = await spec.get();
  return s.domains
    .find((d) => d.name === "Network")
    .commands.map((c) => ({ method: c.method, description: c.description }));
};
```

When the LLM uses `browser_execute`, it writes code like:

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

## Using with an Agent

The typical pattern is to create browser tools inside the agent's message handler:

```typescript
import { Agent } from "agents";
import { createBrowserTools } from "agents/browser/ai";
import { streamText, convertToModelMessages, stepCountIs } from "ai";

export class MyAgent extends Agent<Env> {
  async onChatMessage() {
    const browserTools = createBrowserTools({
      browser: this.env.BROWSER,
      cdpUrl: this.env.CDP_BASE_URL || undefined,
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

```typescript
import { createBrowserTools } from "agents/browser/tanstack-ai";
import { chat } from "@tanstack/ai";

const browserTools = createBrowserTools({
  browser: env.BROWSER,
  cdpUrl: env.CDP_BASE_URL,
  loader: env.LOADER
});

const stream = chat({
  adapter: openaiText("gpt-4o"),
  tools: [...browserTools, ...otherTools],
  messages
});
```

## How it works

```
┌──────────────────────┐
│  Host Worker / DO    │
│                      │        ┌──────────────────────────────┐
│  browser_search:     │        │  Dynamic Worker (sandbox)    │
│  spec stays here     │  RPC   │                              │
│  ◄───────────────────────────►│  LLM code runs here          │
│                      │        │  spec.get() → host           │
│  browser_execute:    │        │  cdp.send() → host           │
│  CDP WebSocket here  │        │                              │
│  ◄──── WebSocket ──► Browser  │  fetch() blocked by default  │
└──────────────────────┘        └──────────────────────────────┘
```

1. **`browser_search`**: The LLM's code runs in an isolated sandbox. It calls `spec.get()` which dispatches via RPC to the host, returning the full CDP spec. The LLM filters and queries it in-sandbox.

2. **`browser_execute`**: The host opens a CDP WebSocket to the browser (via Browser Rendering binding or local Chrome URL), then provides `cdp.send()`, `cdp.attachToTarget()`, `cdp.getDebugLog()`, and `cdp.clearDebugLog()` as RPC-dispatched functions. The LLM's code calls these from the sandbox; actual CDP traffic flows through the host. The session is closed after each execution.

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

Returns AI SDK tools (`browser_search` and `browser_execute`).

| Option       | Type                     | Default  | Description                                            |
| ------------ | ------------------------ | -------- | ------------------------------------------------------ |
| `browser`    | `Fetcher`                | —        | Browser Rendering binding (production)                 |
| `cdpUrl`     | `string`                 | —        | CDP base URL for local Chrome (development)            |
| `cdpHeaders` | `Record<string, string>` | —        | Headers for CDP URL discovery (e.g. Cloudflare Access) |
| `loader`     | `WorkerLoader`           | required | Worker Loader binding for sandboxed execution          |
| `timeout`    | `number`                 | `30000`  | Execution timeout in milliseconds                      |

Either `browser` or `cdpUrl` must be provided. When both are set, `cdpUrl` takes priority.

### Raw access

For custom integrations, import the building blocks directly:

```typescript
import {
  CdpSession,
  connectBrowser,
  connectUrl,
  createBrowserToolHandlers
} from "agents/browser";

// Connect to a local Chrome
const session = await connectUrl("http://localhost:9222");
const version = await session.send("Browser.getVersion");
session.close();
```

## Local development

The Browser Rendering binding does not support raw CDP WebSocket connections in local development (via `wrangler dev`). Use a local Chrome instance instead:

1. Start Chrome with remote debugging:

```sh
chrome --headless --remote-debugging-port=9222 --no-first-run
```

2. Set `CDP_BASE_URL` in your `wrangler.jsonc`:

```jsonc
{
  "vars": {
    "CDP_BASE_URL": "http://localhost:9222"
  }
}
```

3. Pass it to `createBrowserTools`:

```typescript
createBrowserTools({
  browser: env.BROWSER,
  cdpUrl: env.CDP_BASE_URL || undefined,
  loader: env.LOADER
});
```

When deployed to Cloudflare, remove the `CDP_BASE_URL` variable. The Browser Rendering binding handles browser provisioning automatically.

## Security considerations

- LLM-generated code runs in **isolated Worker sandboxes** — each execution gets its own Worker instance
- External network access (`fetch`, `connect`) is **blocked** in the sandbox at the runtime level
- CDP commands are dispatched via Workers RPC — the WebSocket lives in the host, not the sandbox
- The 1.7MB CDP spec never leaves the server — only query results flow to the LLM
- Responses are truncated to approximately 6,000 tokens to prevent context window overflow

## Current limitations

- **One session per execute call** — each `browser_execute` invocation opens a fresh browser session. Multi-step workflows must be completed within a single code block.
- **Browser Rendering binding** — raw CDP support via the binding is in progress. Local development requires a separate Chrome process.
- **No authenticated sessions** — the browser starts without any cookies or login state. A future Browser Isolation integration could enable user-authenticated sessions.
- Requires `@cloudflare/codemode` as a peer dependency
- Limited to JavaScript execution in the sandbox (no TypeScript syntax)

## Example

See [`examples/ai-chat/`](../examples/ai-chat/) for a working example that combines browser tools with other AI SDK tools, MCP servers, and tool approval.
