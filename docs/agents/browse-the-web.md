# Browse the Web

Browser tools give your agents the full Chrome DevTools Protocol (CDP). Instead of a fixed set of actions (click, screenshot, navigate), the model writes code that sends CDP commands to a live browser, so it can use every domain, command, and event in the protocol.

`browserTool` gives the model one browser that stays open between turns, so tabs, cookies, and logins carry over. There is a version for pi, TanStack AI, and the AI SDK.

> `createBrowserTools`, `createBrowserRuntime`, and Quick Actions are deprecated. They are documented under [Deprecated](#deprecated).

## When to use browser tools

Browser tools are useful when your agent needs to:

- **Inspect web pages** — DOM structure, computed styles, accessibility tree
- **Debug frontend issues** — network waterfalls, console errors, performance traces
- **Scrape structured data** — extract content from rendered pages
- **Capture screenshots or PDFs** — visual snapshots of web content
- **Work behind a login** — sign in once and keep the session across turns

For simple page fetches where you do not need a full browser, `fetch()` is simpler. To let a model read pages as Markdown without a browser, use the [`web_fetch` tool](./fetch-the-web.md) from `agents/webfetch`.

## Persistent browser

You create the browser once on your agent and give the model a tool that drives it. The model never starts or closes the browser.

### Setup

Add a [Browser Run](https://developers.cloudflare.com/browser-run/) binding and a Worker Loader binding to your `wrangler.jsonc`. The model's code runs in Dynamic Workers from the loader.

```jsonc
// wrangler.jsonc
{
  "browser": { "binding": "BROWSER" },
  "worker_loaders": [{ "binding": "LOADER" }],
  "compatibility_flags": ["nodejs_compat"]
}
```

Install `agents`, plus the package for your harness: the pi packages for [pi-durable](./harnesses/pi.md), `@tanstack/ai` for TanStack AI, or `ai` for the AI SDK.

Create a `Browser` on your agent and install it on the agent's [Lifecycle](./lifecycle.md), which stores the browser's record and keeps it across hibernation:

```ts
import { Agent } from "agents";
import { Browser, browserRun } from "agents/browser";

export class MyAgent extends Agent<Env> {
  browser = new Browser({ provider: browserRun(this.env.BROWSER) });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.browser);
  }
}
```

Only Chromium on Browser Run is supported.

### pi

Import `browserTool` from `agents/browser/pi` and install it in an extension. It takes an optional `name` (default `"browser"`):

```ts
import { browserTool } from "agents/browser/pi";

this.registry.install({
  name: "browser",
  tools: [browserTool({ browser: this.browser, loader: this.env.LOADER })]
});
```

- A returned screenshot comes back as an image in the tool result, so the model can see the page and a UI can show it from the transcript. pi-ai only sends the image to models that accept images; other models get the text alone.
- Each pi conversation gets its own active tab: `scope` defaults to the calling conversation, so sessions, forks, and subagents on one object do not drive each other's page. Pass `scope` as a string to share one tab, or as a function of the call (`(api) => string`) to choose.
- pi does not rerun a browser call cut off by an eviction, because the code may have clicked or submitted something. The model gets an interrupted result and can try again; the browser itself is still there.
- Stopping a conversation does not stop a browser call already running. It finishes or times out.

### TanStack AI

Import `browserTool` from `agents/browser/tanstack-ai`. It takes an optional `name` (default `"browser"`) and returns a `ServerTool`:

```ts
import { chat } from "@tanstack/ai";
import { browserTool } from "agents/browser/tanstack-ai";

const stream = chat({
  adapter,
  tools: [browserTool({ browser: this.browser, loader: this.env.LOADER })],
  messages
});
```

The TanStack AI tool does not support screenshots yet. TanStack AI gives the host and the model the same output, so a returned screenshot is replaced with a note, and the tool tells the model to read the page with `Runtime.evaluate` instead.

### AI SDK

Import `browserTool` from `agents/browser/ai-sdk` and pass it wherever you pass AI SDK tools, under any name:

```ts
import { streamText } from "ai";
import { browserTool } from "agents/browser/ai-sdk";

const result = streamText({
  model,
  messages,
  tools: {
    browser: browserTool({ browser: this.browser, loader: this.env.LOADER })
  }
});
```

To show a screenshot, the model returns it from its code. The full result, image included, stays on the message for your UI, and the model gets a short text summary.

### How the tool behaves

- The model writes an async arrow function against a `browser` global: `browser.cdp({ method, params, sessionId })` sends a command, `browser.attachToTarget({ targetId })` switches tabs, `browser.spec()` lists the protocol's domains and `browser.spec({ domain })` returns one, and `browser.getDebugLog()` shows recent traffic. `sessionId: "active"` points at the tab it is working in, and that tab is remembered across turns.
- The code runs in a fresh Dynamic Worker for each call, with no network access: `browser` is its only way out.
- The tool's description covers the `browser` API and the CDP mistakes models commonly make, so the model does not need a discovery pass first.
- If several chats or users share one `Browser` (for example, many threads on one agent), pass each one's id as `scope`: `browserTool({ browser, loader, scope: threadId })`. Each scope keeps its own active tab, so one chat never drives another's page, while cookies and logins stay shared. Tools that leave `scope` out share one tab. Calls in the same scope wait for each other; calls in different scopes run in parallel.
- The result's `notice` tells the model what happened to its browser: it was lost (idle past `keepAliveMs`, closed, or crashed) and the code ran in a new one, another chat closed its tab or works in it too, or the page opened new tabs.
- Each call times out after `timeoutMs` (default 60 seconds).
- Results are cut to about 24,000 characters. A screenshot can be at most 1 MB, so a full-page screenshot of a long page fails; the model is told to capture the viewport or use JPEG instead.

### Configure the browser

Pass options to `browserRun(binding, options)`:

- `keepAliveMs` is how long an idle browser stays alive: 10 minutes by default, up to 20. Browser Run bills the idle time, so a longer value keeps tabs and logins across longer gaps between turns but costs more when a conversation is abandoned.
- `guardrails` restricts which hostnames the browser may reach, for example `{ allowedDomains: ["example.com", "*.example.com"] }`. See [guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/).
- `recording` turns on [session recording](#session-recording).

To have more than one browser on an agent, give each `Browser` a different `name`.

### Live View and closing

Call `this.browser.liveView()` to get [Live View](https://developers.cloudflare.com/browser-run/features/live-view/) links into the browser's open tabs, so a person can watch or take over, for example to log in. The links are credentials that can only be opened for about five minutes: give them to a trusted person, never to the model. The agent can end its turn and pick up once the person is done.

Call `this.browser.close()` to shut the browser down. The next call starts a new one.

### Driving the browser from your own code

`browser.session()` gives you what the tool's `browser` global is built on: one connection to the browser, with the same `sessionId: "active"` handling and error hints. Close it when you are done to save the scope's active tab and get a report of what happened to the browser:

```ts
const session = this.browser.session({ scope: threadId });
try {
  await session.send({
    method: "Page.navigate",
    params: { url: "https://example.com" },
    sessionId: "active"
  });
} finally {
  const report = await session.close();
  // { restarted, newTabs, tabClosed, tabShared }, or undefined if unused
}
```

## Session recording

[Session recording](https://developers.cloudflare.com/browser-run/features/session-recording/) captures everything the agent did so you can review it afterward: an [rrweb](https://github.com/rrweb-io/rrweb) capture of DOM changes, input, and navigation (structured JSON, not video). Turn it on with `browserRun(binding, { recording: true })`. A recording is finalized when the browser closes, so note the session id while the browser is alive and fetch the recording later:

```ts
import { getBrowserRecording } from "agents/browser";

const { sessionId } = await this.browser.resolve();
// ...later, after the browser has closed...
const recording = await getBrowserRecording({
  accountId: this.env.CF_ACCOUNT_ID,
  apiToken: this.env.CF_API_TOKEN,
  sessionId
});
// recording.events is keyed by CDP target (one rrweb event array per tab),
// ready to hand to rrweb-player.
```

Retrieval goes through the Browser Run REST API, so it needs an account id and an API token with `Browser Rendering` read access. Recordings are retained for 30 days and capped at 2 hours per session. A recording spans the browser's whole life, across every turn and every scope sharing it. rrweb masks input fields by default, but treat a recording as potentially sensitive.

## Lower-level helpers

For your own integrations, `agents/browser` also exports the pieces `Browser` is built on:

```ts
import {
  connectUrl,
  createBrowserSession,
  connectBrowserSession,
  loadCdpSpec
} from "agents/browser";

// A CDP connection to any endpoint, such as a local Chrome
const connection = await connectUrl("http://localhost:9222");
const version = await connection.send("Browser.getVersion");
connection.close();

// A Browser Run session you manage yourself
const { sessionId } = await createBrowserSession(this.env.BROWSER, {
  guardrails: { allowedDomains: ["example.com"] }
});
const session = await connectBrowserSession(this.env.BROWSER, sessionId, {
  timeoutMs: 30_000
});

// The normalized CDP protocol, read from a live browser
const spec = await loadCdpSpec({ browser: this.env.BROWSER, sessionId });
```

`connectBrowserSession` does not delete the session when the connection closes, so you can reconnect. `loadCdpSpec` without a `sessionId` creates a temporary session to read the protocol, then deletes it.

## Local development

Recent Wrangler releases support Browser Run in local development. `npx wrangler dev` provisions the browser automatically, so the same `browser: env.BROWSER` setup works locally and when deployed.

## Security considerations

- The model's code runs in a fresh Dynamic Worker for every call, with no network access (`fetch` and `connect` are blocked). `browser` is its only way out.
- CDP commands go to your agent over Workers RPC. The WebSocket and the browser stay in your agent, not the sandbox.
- The model cannot close or crash the browser; `Browser.close` and `Browser.crash*` are refused.
- Live View links give whoever holds them control of the browser, including its logins. Do not show them to the model or store them.

# Deprecated

These APIs keep working until they are removed, but will not change.

## `createBrowserTools` and `createBrowserRuntime`

> **Deprecated.** Use [`browserTool`](#persistent-browser). Pausing a run with its session kept while a person works in Live View has no replacement yet, so keep using `createBrowserTools` if you rely on it.

`createBrowserTools` returns a `browser_execute` tool that runs the model's code against a browser through a `cdp` connector on a durable codemode runtime. A run can pause for approval and resume with its browser session intact. It needs `@cloudflare/codemode`, the same `BROWSER` and `LOADER` bindings as `browserTool`, and a `CodemodeRuntime` export from your worker (the `@cloudflare/codemode/vite` plugin adds it):

```ts
export { CodemodeRuntime } from "agents/browser";
```

Create the tools inside a Durable Object, such as an Agent:

```ts
import { createBrowserTools } from "agents/browser/ai"; // or agents/browser/tanstack-ai

const tools = createBrowserTools({
  ctx: this.ctx,
  browser: this.env.BROWSER,
  loader: this.env.LOADER,
  session: { mode: "dynamic" }
});
```

| Option       | Type                             | Default    | Description                                                |
| ------------ | -------------------------------- | ---------- | ---------------------------------------------------------- |
| `ctx`        | `DurableObjectState`             | current Agent | The DO hosting the runtime facet and session store         |
| `browser`    | `BrowserBinding`                 | —          | Browser Run binding                                        |
| `cdpUrl`     | `string`                         | —          | A custom CDP endpoint; takes priority over `browser`       |
| `cdpHeaders` | `Record<string, string>`         | —          | Headers for CDP URL discovery (e.g. Cloudflare Access)     |
| `loader`     | `WorkerLoader`                   | required   | Worker Loader binding for sandboxed execution              |
| `session`    | `BrowserConnectorSessionOptions` | `one-shot` | Session lifecycle mode                                     |
| `store`      | `BrowserSessionStore`            | DO storage | Durable store for session ids                              |
| `timeout`    | `number`                         | `30000`    | Execution timeout (also the per-CDP-command timeout)       |
| `name`       | `string`                         | `browser`  | Runtime name — the durable identity of executions/snippets |

Session modes:

- **`one-shot`** (default) — a fresh session per execution, closed when it ends.
- **`reuse`** — a named shared session (`{ mode: "reuse", key }`) that persists across executions until closed or swept.
- **`dynamic`** — starts one-shot; the model can keep the session with `cdp.startSession()`.

Set `session: { recording: true }` to record sessions, or `session: { browser: "kitesurf" }` to use Kitesurf (one-shot only). `createBrowserRuntime` takes the same options and also returns the `connector` for host-side calls: `sessionInfo()`, `liveView()`, `closeSession()`, and `sweep()` (call it from a scheduled task to reclaim stale sessions).

The model's `cdp` connector:

| Method                                                        | Description                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `cdp.send({ method, params?, sessionId?, timeoutMs? })`       | Send a CDP command                                             |
| `cdp.attachToTarget({ targetId, timeoutMs? })`                | Attach to a target; returns a `sessionId` that survives resume |
| `cdp.spec()`                                                  | The normalized CDP protocol                                    |
| `cdp.getDebugLog({ limit? })` / `cdp.clearDebugLog()`         | Recent CDP traffic for this execution                          |
| `cdp.getLiveViewUrl({ targetId?, mode? })`                    | A Live View URL for a person to watch or take over             |
| `cdp.startSession()` _(reuse/dynamic)_                        | Keep the shared session; returns its info                      |
| `cdp.sessionInfo()` _(reuse/dynamic)_                         | Shared session info, or `null`                                 |
| `cdp.closeSession()` / `cdp.resetSession()` _(reuse/dynamic)_ | Close, or close and replace, the shared session                |

For a Live View handoff, the model calls `cdp.getLiveViewUrl()`, shows the link to the user, then makes an approval-gated call. The run pauses while the person works in the browser and resumes in the same session. Connector calls are recorded and replayed on resume, so they must be sequential (no `Promise.all`).

## Quick Actions (stateless browsing)

> **Deprecated.** Use [`browserTool`](#persistent-browser) to drive a browser, the [`web_fetch` tool](./fetch-the-web.md) from `agents/webfetch` to read a page, or call the binding's `quickAction()` directly.

[Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/) are one-shot Browser Run calls that need only the `browser` binding. `createQuickActionTools` turns them into tools, and `createBrowserTools` includes them by default when a `browser` binding is present (pass `quickActions: false` to leave them out):

```ts
import { createQuickActionTools } from "agents/browser/ai";

const tools = createQuickActionTools({
  browser: this.env.BROWSER,
  maxChars: 20_000 // default 50000; 0 turns truncation off
});
// browser_markdown, browser_extract, browser_links, browser_scrape
```

Pass `actions` to choose tools (`browser_content`, raw HTML, is opt-in) and `options` for host-supplied settings such as `cookies`, `authenticate`, or `gotoOptions`. The same calls are exported as functions: `browserMarkdown`, `browserExtract`, and `runQuickAction(browser, action, params)` for the raw `Response`. Quick Actions need a `compatibility_date` of `2026-03-24` or later, and `remote: true` on the browser binding for local `wrangler dev`.
