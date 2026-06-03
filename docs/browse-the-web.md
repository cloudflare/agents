# Browse the Web (Experimental)

Browser tools give your agents full access to the Chrome DevTools Protocol (CDP) through the code mode pattern. Instead of a fixed set of browser actions (click, screenshot, navigate), the LLM writes JavaScript code that runs CDP commands against a live browser session — accessing all domains, commands, events, and types in the protocol.

One code-mode tool is provided:

- **`browser_execute`** — query the CDP spec and run CDP commands against a live browser via a `cdp` helper. Each call opens a fresh browser session, executes the code, and closes it by default.

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

For agent-controlled persistent sessions, pass `session: { mode: "dynamic", store }`. Until the model calls `cdp.startSession()` inside `browser_execute`, browser calls stay one-shot. This is the recommended mode for most agents because the model only keeps a browser open when the task needs tabs, cookies, local storage, or navigation history to persist across calls.

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

When the LLM needs to inspect the CDP spec, it can call `cdp.spec()` inside `browser_execute`:

```javascript
async () => {
  const s = await cdp.spec();
  return s.domains
    .find((d) => d.name === "Network")
    .commands.map((c) => ({ method: c.method, description: c.description }));
};
```

Browser commands use the same `browser_execute` tool:

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

- `cdp.spec()` fetches the live CDP protocol from the browser's `/json/protocol` endpoint and caches it briefly.
- `browser_execute` opens a fresh browser session for the call, exposes a small `cdp` helper API to sandboxed code, and closes the session when execution finishes.
- With `session.mode: "dynamic"`, `browser_execute` is one-shot until the model calls `cdp.startSession()`; subsequent calls reuse that Browser Run session until `cdp.closeSession()` is called. Use this for agent chats and assistants.
- With `session.mode: "reuse"`, every `browser_execute` call uses a reusable Browser Run session until `cdp.closeSession()` is called. Use this when the app always wants browser state to persist from the first browser command.
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

### Reusable session helpers

When `session.mode` is `"reuse"` or `"dynamic"`, `browser_execute` also exposes `cdp.startSession()`, `cdp.sessionInfo()`, `cdp.closeSession()`, and `cdp.resetSession()`.

`cdp.sessionInfo()` returns target metadata. When Browser Rendering provides Live View metadata, targets include `devtoolsFrontendUrl` so you can surface an inspectable browser URL in your UI.

Use `cdp.closeSession()` when persistent browsing is complete to release Browser Run resources.

### Live View UI pattern

For human-in-the-loop browser tasks, return a Live View URL as a user-facing action rather than relying on the model to describe it in text:

```javascript
async () => {
  await cdp.startSession();
  const info = await cdp.sessionInfo();
  const page = info.targets?.find((target) => target.type === "page");
  return {
    button: page?.devtoolsFrontendUrl
      ? { url: page.devtoolsFrontendUrl, text: "Open Live View" }
      : undefined
  };
};
```

After the user completes login, MFA, CAPTCHA, or sensitive input in Live View, the agent can call `browser_execute` again to inspect the page and continue. If the Live View URL is no longer usable, call `cdp.sessionInfo()` again to fetch fresh target metadata from Browser Run.

## Configuration

### `createBrowserTools(options)`

Returns an AI SDK `browser_execute` tool.

| Option       | Type                     | Default  | Description                                            |
| ------------ | ------------------------ | -------- | ------------------------------------------------------ |
| `browser`    | `Fetcher`                | —        | Browser Rendering binding                              |
| `cdpUrl`     | `string`                 | —        | Optional override for a custom CDP endpoint            |
| `cdpHeaders` | `Record<string, string>` | —        | Headers for CDP URL discovery (e.g. Cloudflare Access) |
| `loader`     | `WorkerLoader`           | required | Worker Loader binding for sandboxed execution          |
| `timeout`    | `number`                 | `30000`  | Execution timeout in milliseconds                      |
| `session`    | `BrowserSessionOptions`  | one-shot | Browser Run session policy                             |

Either `browser` or `cdpUrl` must be provided.

`session` defaults to `{ mode: "one-shot" }`, which opens a fresh browser for each execution. Persistent Browser Run sessions use `{ mode: "reuse", store }` or `{ mode: "dynamic", store }`, where `store` is a `BrowserSessionStore`. Use `new DurableBrowserSessionStore(this.ctx.storage)` inside an Agent or Durable Object to persist the Browser Run session id. You can also pass `key` to isolate users or workflows and `keepAliveMs` to request a Browser Run inactivity timeout.

Reusable and dynamic sessions require the Browser Rendering `browser` binding. They are not supported with `cdpUrl`, because custom CDP endpoints are externally managed.

### Manual session management

Apps that need browser controls outside the chat can manage the same session directly from server code:

```ts
import {
  createBrowserSessionManager,
  DurableBrowserSessionStore
} from "agents/browser";

const browserSessions = createBrowserSessionManager({
  browser: env.BROWSER,
  session: {
    mode: "dynamic",
    key: chatId,
    store: new DurableBrowserSessionStore(ctx.storage),
    keepAliveMs: 600_000
  }
});

const info = await browserSessions.info();
await browserSessions.close();
```

Use `info()` to render a browser status panel or an "Open Live View" button, `start()` to proactively open a browser, `reset()` to clear browser state, and `close()` when the task, chat, or user session ends.

### Cleanup and limits

Reusable sessions keep the Browser Run browser alive after a `browser_execute` call finishes. Browser Run closes idle sessions after 60 seconds by default. `keepAliveMs` requests a longer inactivity timeout, up to the Browser Run maximum of 10 minutes.

Close persistent sessions explicitly when:

- the user is done browsing
- the user deletes or clears a chat
- the user signs out
- the app resets agent state
- the task no longer needs cookies, local storage, open tabs, or navigation history

Browser Sessions count toward Browser Run browser-hours and concurrent-browser usage. Leaving sessions open can increase usage until Browser Run closes them for inactivity. One-shot mode closes sessions automatically after each tool call, so it is the safest default when persistence is not required.

### Raw access

For custom integrations, import the building blocks directly:

```ts
import {
  CdpSession,
  connectBrowser,
  connectUrl,
  createBrowserProvider
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

- **One-shot by default** — each `browser_execute` invocation opens a fresh browser session unless you configure `session: { mode: "reuse" | "dynamic", store }`.
- **Local development depends on Wrangler support** — if Browser Rendering local mode is unavailable in your environment, upgrade Wrangler or provide `cdpUrl` explicitly.
- **No pre-authenticated sessions** — the browser starts without cookies or login state. Reusable sessions can retain cookies and storage after login until you call `cdp.closeSession()` or Browser Run expires the session.
- Requires `@cloudflare/codemode` as a peer dependency
- Limited to JavaScript execution in the sandbox (no TypeScript syntax)

## Example

See [`examples/ai-chat/`](../examples/ai-chat/) for a working example that combines browser tools with other AI SDK tools, MCP servers, and tool approval.
