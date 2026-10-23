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

Install `agents` and `@cloudflare/codemode`, plus the package for your harness: the pi packages for [pi-durable](./harnesses/pi.md), `@tanstack/ai` for TanStack AI, or `ai` for the AI SDK.

```sh
npm install agents @cloudflare/codemode
```

`browserTool` does not use codemode, but `agents/browser` still exports the deprecated APIs that do, so your bundler needs it installed. That requirement goes away when those APIs are removed.

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

### Internal hostnames

Give the browser hostnames that your agent serves instead of the internet: a dev server in the agent's sandbox, a staging site behind a header, or another Worker. Each host has a `fetch` function that runs in your agent, so it can use the agent's bindings and state:

```ts
import { Browser, browserRun, proxyTo } from "agents/browser";
import { z } from "zod";

// Browser Run calls back into your Worker through this entrypoint.
export { InternalHostRouter } from "agents/browser";

export class MyAgent extends Agent<Env> {
  browser = new Browser({
    provider: browserRun(this.env.BROWSER, {
      guardrails: { allowedDomains: [] }, // internal hosts only
      internalHosts: {
        router: this.ctx.exports.InternalHostRouter,
        hosts: {
          "docs.internal": {
            description: "Staging docs",
            fetch: proxyTo("https://staging.example.com", {
              headers: { authorization: `Bearer ${this.env.STAGING_TOKEN}` }
            })
          },
          "preview.internal": {
            description: "Your dev servers",
            target: z.object({ port: z.number().int().min(1024) }),
            fetch: (request, { port }) => this.sandbox.fetchPort(port, request)
          },
          "api.internal": { worker: this.env.API }
        }
      }
    })
  });
}
```

- A host with `fetch` always serves the same thing. Add a `target` schema and the model chooses: it calls `browser.assignHost({ host, target })` in its browser code, the target is checked against the schema and stored, and your `fetch` gets it as its second argument. `target` takes a [Standard JSON Schema](https://standardschema.dev) (Zod 4.2+, ArkType, Valibot via its adapter), which types the argument, or a plain JSON Schema object, which leaves it `unknown`.
- Assignments survive the browser being replaced, eviction, and redeploys. An assignable host answers 502 until it is assigned. Call `this.browser.internalHosts.assign()`, `.clear()`, or `.list()` to manage them yourself.
- A host with `worker` (a service binding or a `ctx.exports` entrypoint) goes straight to that Worker, without passing through your agent.
- `proxyTo(url, { headers })` forwards to a site and keeps the browser on the internal hostname: it rewrites redirects and drops the cookies' `Domain` and `Secure` attributes. `__Secure-` and `__Host-` cookies do not work over plain http.
- The browser tool's description lists each host with its description and schema, and its `browser` global gains `listHosts()`, plus `assignHost()` and `clearHost()` when a host is assignable.
- Internal hosts are plain http on port 80. There is no https and no WebSockets, so a dev server's hot reload will not connect.
- At most 8 hostnames, as bare lowercase names ending in `.internal`, `.test`, `.example`, or `.invalid` (`preview.internal`, not `http://preview.internal:5173`). These suffixes never resolve on the internet, so a host cannot shadow a real site. They are fixed when the browser starts. Changing the set replaces the browser on its next use; changing a `fetch` function does not.
- `guardrails` do not apply to internal hosts. `allowedDomains: []` lets the browser reach only them.
- Any plain http page open in the browser can send requests to internal hosts, including a page on another internal host (Chrome blocks this from https pages as mixed content). Use `allowedDomains: []`, and if a host's requests have side effects, check that their `Origin` is that host.
- When a host's `fetch` throws, the browser gets a 502 and the error is logged. The page does not see the error message.
- Internal hosts only work when deployed. In local dev the browser starts without them and logs a warning.
- Install the `Browser` on a top-level agent with `this.lifecycle.use()`. Sub-agents are not supported yet.

`InternalHostRouter` reaches your agent by calling its `fetchInternalHost()` method. `Agent` has it built in, and so does every class built on it, so the code above works as is. On a plain Durable Object that installs `Lifecycle` itself, add the method and pass the message to your `Browser`:

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Browser, browserRun, type InternalHostMessage } from "agents/browser";

export class MyObject extends DurableObject<Env> {
  browser = new Browser({
    provider: browserRun(this.env.BROWSER, {
      internalHosts: {
        router: this.ctx.exports.InternalHostRouter,
        hosts: {
          "preview.internal": {
            fetch: (request) => this.sandbox.fetchPort(5173, request)
          }
        }
      }
    })
  });
  lifecycle = Lifecycle.install(this).use(this.browser);

  fetchInternalHost(message: InternalHostMessage) {
    return this.browser.fetchInternalHost(message);
  }
}
```

With more than one `Browser`, pick the one named by `message.browser`. Without the method, the browser shows a 502 that says what to add.

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
- The model cannot get a Live View link: `Cloudflare.getLiveView` and `Cloudflare.handoff` are refused, and so are `Target.sendMessageToTarget` and `Target.exposeDevToolsProtocol`, which could carry those commands inside them.
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

| Option       | Type                             | Default       | Description                                                |
| ------------ | -------------------------------- | ------------- | ---------------------------------------------------------- |
| `ctx`        | `DurableObjectState`             | current Agent | The DO hosting the runtime facet and session store         |
| `browser`    | `BrowserBinding`                 | —             | Browser Run binding                                        |
| `cdpUrl`     | `string`                         | —             | A custom CDP endpoint; takes priority over `browser`       |
| `cdpHeaders` | `Record<string, string>`         | —             | Headers for CDP URL discovery (e.g. Cloudflare Access)     |
| `loader`     | `WorkerLoader`                   | required      | Worker Loader binding for sandboxed execution              |
| `session`    | `BrowserConnectorSessionOptions` | `one-shot`    | Session lifecycle mode                                     |
| `store`      | `BrowserSessionStore`            | DO storage    | Durable store for session ids                              |
| `timeout`    | `number`                         | `30000`       | Execution timeout (also the per-CDP-command timeout)       |
| `name`       | `string`                         | `browser`     | Runtime name — the durable identity of executions/snippets |

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
