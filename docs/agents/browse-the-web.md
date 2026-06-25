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

> Using `@cloudflare/think`? The unified execute tool (`createExecuteTool(this)`) already includes `cdp.*` alongside `state.*` and `tools.*` when `env.BROWSER` is bound. See the [Think tools documentation](https://github.com/cloudflare/agents/blob/main/docs/think/tools.md).

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
await connector.liveView(); // Live View URLs for the shared session's tabs
await connector.closeSession(); // close the shared session
await connector.sweep(); // reclaim expired/stale sessions — call from a scheduled task
await runtime.expirePaused(); // reject stale never-approved pauses, freeing their sessions
```

## Quick Actions (stateless browsing)

`browser_execute` drives a full, stateful CDP session — the right tool for interactive, multi-step automation. But a lot of agent browsing is really one-shot: _read this page as Markdown_, _extract these fields_, _list the links_. For those, [Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/) are simpler, faster, and cheaper. They need only the `browser` binding — no Durable Object, Worker Loader, or sandbox — so they work from any Worker.

```ts
import { createQuickActionTools } from "agents/browser/ai";

const tools = createQuickActionTools({ browser: this.env.BROWSER });
// browser_markdown, browser_extract, browser_links, browser_scrape
const result = await generateText({ model, tools, messages });
```

By default you get the text-returning, model-friendly tools; `browser_content` (raw HTML) is opt-in via `actions`.

**Context safety.** Every result is bounded to roughly `maxChars` (default 50000) so a single browse cannot blow the context window, while preserving each result's shape so the model sees a consistent type: text (markdown/content) is truncated to a string, oversized link/scrape arrays are trimmed but stay arrays, and only an opaque oversized object (e.g. a sprawling `extract`) degrades to a `{ truncated, note, preview }` summary. Set `maxChars: 0` to disable.

**Authenticated and JavaScript-heavy pages.** The model only ever supplies the page (`url`/`html`) and action-specific fields. Host-supplied options — `cookies`, `authenticate`, `setExtraHTTPHeaders` for protected pages, or `gotoOptions` / `viewport` for pages that need to settle — are passed once via `options` and merged into every request:

```ts
const tools = createQuickActionTools({
  browser: this.env.BROWSER,
  actions: ["markdown", "extract", "links"],
  maxChars: 20_000,
  options: {
    authenticate: { username: "user", password: env.SITE_PASSWORD },
    gotoOptions: { waitUntil: "networkidle0" }
  }
});
```

You can also call the primitives directly:

```ts
import { browserMarkdown, browserExtract } from "agents/browser";

const md = await browserMarkdown(this.env.BROWSER, { url });
const data = await browserExtract<{ price: number }>(this.env.BROWSER, {
  url,
  prompt: "the product price",
  response_format: { type: "json_schema", schema: priceSchema }
});
```

For an endpoint or option not yet wrapped, `runQuickAction(browser, action, params)` returns the raw `Response`; its `params` are typed against the action (`"json"` expects an extract input, `"scrape"` expects `elements`, and so on).

**Using them with `browser_execute`.** Quick Actions and the durable CDP tool share the same `BROWSER` binding and complement each other — one-shot reads versus interactive sessions. `createBrowserTools` / `createBrowserRuntime` expose **both by default** whenever a `browser` binding is present, and resolve `ctx` from the current Agent (via `getCurrentAgent()`) so you can skip threading `this.ctx`:

```ts
// Inside an Agent method — ctx is picked up automatically:
const tools = createBrowserTools({
  browser: this.env.BROWSER,
  loader: this.env.LOADER
});
// browser_execute + browser_markdown + browser_extract + browser_links + browser_scrape

// Configure or disable the Quick Action half:
createBrowserTools({ browser, loader, quickActions: { maxChars: 20_000 } });
createBrowserTools({ browser, loader, quickActions: false });
```

When only `cdpUrl` is set (no binding), the Quick Action tools are skipped silently.

**Using them with `@cloudflare/think`.** Quick Action tools are an ordinary `ToolSet`, so a Think agent exposes them by spreading them from `getTools()`:

```ts
class Researcher extends Think<Env> {
  getTools() {
    return { ...createQuickActionTools({ browser: this.env.BROWSER }) };
  }
}
```

Quick Actions require a Worker `compatibility_date` of `2026-03-24` or later and `remote: true` on the browser binding for local `wrangler dev`.

## Live View and human-in-the-loop

[Live View](https://developers.cloudflare.com/browser-run/features/live-view/) lets a human open a URL and watch — or take control of — a running browser session in real time. It is the building block for human-in-the-loop steps such as logging in, solving a CAPTCHA, completing MFA, or entering data you do not want to pass through an automation script.

Because the codemode runtime can already pause a run for approval _with the browser session intact_, a handoff is a four-step pattern:

1. The model calls `cdp.getLiveViewUrl()` to get a link to the current tab.
2. It surfaces the link to the user (for example by returning it, writing it to state, or sending it via Slack or email).
3. It makes an approval-gated call, so the run pauses durably while the human acts in the live browser.
4. After approval, the run resumes against the same session — cookies and login state intact.

```javascript
async () => {
  const { targetId } = await cdp.send({
    method: "Target.createTarget",
    params: { url: "https://example.com/login" }
  });

  // A link the user opens to log in themselves.
  const { url } = await cdp.getLiveViewUrl({ targetId, mode: "tab" });
  return { needsHumanLogin: url };
};
```

Pass `mode: "tab"` for a standalone interactive page view (best for a handoff) or `mode: "devtools"` for the full DevTools inspector panel. The URL is valid for about five minutes; call again for a fresh one.

From the host side, `connector.liveView()` returns the shared (`reuse`/`dynamic`) session's tabs and their Live View URLs, so an agent can render a "take over this session" link in its own UI without entering the sandbox. Each tab also carries its current `pageUrl`, so a UI can label tabs and skip blank or internal (`about:blank`, `chrome://`) pages.

## Session recording

Where Live View lets you watch a session _live_, [session recording](https://developers.cloudflare.com/browser-run/features/session-recording/) captures everything the agent did so you can review it _afterward_ — an [rrweb](https://github.com/rrweb-io/rrweb) capture of DOM changes, input, and navigation (structured JSON, not video). It is the natural audit trail for an autonomous browser run.

Opt in per session via the `session` option; sessions this connector creates then record until they close:

```ts
const { connector, tools } = createBrowserRuntime({
  ctx: this.ctx,
  browser: this.env.BROWSER,
  loader: this.env.LOADER,
  session: { mode: "reuse", key: "main", recording: true }
});
```

A recording is only finalized once the session closes (an explicit `connector.closeSession()`, idle `keep_alive` expiry, or `connector.sweep()`), so capture the session id while the session is alive and fetch the recording later:

```ts
import { getBrowserRecording } from "agents/browser";

const { sessionId } = (await connector.sessionInfo()) ?? {};
// ...later, after the session has closed...
const recording = await getBrowserRecording({
  accountId: this.env.CF_ACCOUNT_ID,
  apiToken: this.env.CF_API_TOKEN,
  sessionId
});
// recording.events is keyed by CDP target (one rrweb event array per tab),
// ready to hand to rrweb-player.
```

Retrieval goes through the Browser Rendering REST API, so it needs an account id and an API token with `Browser Rendering` read access (the Workers binding cannot read recordings). Recordings are retained for 30 days and capped at 2 hours per session.

Be deliberate with recording on shared (`reuse`/`dynamic`) sessions: the recording spans the session's _entire_ lifetime — every turn, and every user that shares the session `key` — until it closes. rrweb masks input fields by default, but treat a recording as potentially sensitive and scope the session `key` accordingly.

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
| `cdp.getLiveViewUrl({ targetId?, mode? })`              | A Live View URL a human can open to watch/control the session in real time     |
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

See [`examples/ai-chat/`](https://github.com/cloudflare/agents/tree/main/examples/ai-chat) for a working example that combines browser tools with other AI SDK tools, MCP servers, and tool approval, and [`examples/codemode-connectors/`](https://github.com/cloudflare/agents/tree/main/examples/codemode-connectors) for the connector playground (including in-sandbox approvals).
