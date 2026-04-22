# WebMCP — Bridging McpAgent Tools to the Browser AI

`agents/experimental/webmcp` ships a tiny adapter that turns any Cloudflare `McpAgent` into a tool provider for Chrome's native `navigator.modelContext` API. The browser AI (or any WebMCP-aware extension) sees your server's tools alongside any tools the page registers locally — one toolbox, two execution environments.

> **Status: experimental.** Both this adapter and the underlying `navigator.modelContext` API are in early preview and will change. Pin your `agents` version and expect to rewrite calls when upgrading.

## The Pattern

Chrome is shipping `navigator.modelContext` so any web page can register tools the browser's built-in AI can call. The shape is essentially MCP, but the host is the browser and the "server" is in-page JavaScript:

```js
navigator.modelContext.registerTool({
  name: "scroll_to_section",
  description: "...",
  inputSchema: {
    /* JSON schema */
  },
  execute: async (args) => {
    /* run the tool */
  }
});
```

Cloudflare agents already expose tools as MCP servers — `McpAgent` over HTTP/SSE, reachable by Claude/Cursor/etc. WebMCP can't talk to that directly because it expects in-page tool registration, not a remote endpoint.

`registerWebMcp` is the bridge: discover the server's tools, register one shim per tool with `navigator.modelContext`, relay calls back over the existing MCP transport.

```ts
import { registerWebMcp } from "agents/experimental/webmcp";

const handle = await registerWebMcp({ url: "/mcp" });
```

## Why This Exists

Two things become possible at once:

1. **In-page agents can use server-side tools** without re-implementing them in the page. Anything that needs durable storage, secret credentials, third-party API access, fan-out, or scheduling stays in the Worker; it just becomes visible to the browser AI.
2. **Server-side tools and page-side tools live in one registry**. The AI doesn't know or care which is which. You pick the execution environment per tool based on what makes sense — DOM stuff in the page, data stuff on the server.

The split that emerges:

| Use case                                                   | Where it lives                                |
| ---------------------------------------------------------- | --------------------------------------------- |
| DOM manipulation, scrolling, theme, focus, clipboard       | **In-page** — direct `navigator.modelContext` |
| Reading local UI state (Zustand, Redux, IndexedDB)         | **In-page**                                   |
| Web APIs (geolocation, file picker, WebRTC, MediaRecorder) | **In-page**                                   |
| Reading/mutating durable data (KV, R2, D1, DO state)       | **Remote** — `McpAgent` + `registerWebMcp`    |
| Third-party APIs with secret credentials                   | **Remote** (secret stays in the Worker)       |
| Work that must outlive the tab                             | **Remote**                                    |
| Tools you want available across many browser sessions      | **Remote**                                    |

## How It Works

1. **Connect.** The adapter opens an MCP `Client` over `StreamableHTTPClientTransport` against the URL you pass. SSE parsing, session ID handling, reconnection, cursor pagination — all the boring stuff is handled by `@modelcontextprotocol/sdk`.
2. **Discover.** `tools/list` is called (paginated via `nextCursor`) to enumerate every tool the `McpAgent` exposes.
3. **Register.** For each tool, the adapter builds a `ModelContextTool` whose `execute` proxies to `client.callTool(...)` and converts the MCP `content[]` response into a string the browser AI can ingest.
4. **Watch.** The adapter subscribes to MCP `tools/list_changed` notifications. When the server adds, removes, or updates a tool, the adapter re-runs steps 2–3 and re-registers the new set. (Set `watch: false` to disable.)
5. **Tear down.** `await handle.dispose()` aborts every per-tool `AbortController` (the WebMCP spec way to unregister), aborts any in-flight `listTools`/`callTool`, and closes the MCP transport.

The adapter also no-ops gracefully when `navigator.modelContext` is missing (every browser except recent Chrome with `#enable-webmcp-testing`), so you don't need a feature-detect guard at the call site.

## API

### `registerWebMcp(options): Promise<WebMcpHandle>`

```ts
interface WebMcpOptions {
  url: string; // "/mcp", absolute, etc.
  headers?: Record<string, string>; // static auth
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  watch?: boolean; // default true
  prefix?: string; // namespace bridged tools
  timeoutMs?: number; // per-request timeout
  logger?: { info; warn; error }; // default: console
  quiet?: boolean; // default false
  onSync?: (tools: McpTool[]) => void; // called on every (re)sync
  onError?: (error: Error) => void; // background sync errors only
}

interface WebMcpHandle {
  readonly tools: ReadonlyArray<string>; // current names (with prefix)
  readonly disposed: boolean;
  refresh(): Promise<void>; // coalesces with in-flight syncs
  dispose(): Promise<void>; // idempotent
}
```

### Error model

The adapter has three error sources, each with a single, predictable surface:

| Source                                | Behavior                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Initialization (initial connect/list) | The `registerWebMcp(...)` promise rejects. `onError` is **not** called.        |
| Background re-sync (watch mode)       | `onError(err)` is called. Nothing throws.                                      |
| Per-tool `execute` failure            | The `execute` promise rejects. The browser AI / `tools/call` host surfaces it. |

`onError` is reserved for what you can't otherwise observe — work that happens after `registerWebMcp` resolves, in response to server-pushed notifications.

### Concurrency

`refresh()` and the watch-mode notification handler share a single in-flight promise. If a re-sync is already running and another `refresh()` (or a new `tools/list_changed`) arrives, it returns the same promise instead of starting a second sync. This prevents the `unregisterAll → listTools → registerTools` sequence from interleaving with itself and leaving the `navigator.modelContext` registry in an inconsistent state.

### Lifecycle

`dispose()` is async. It:

1. Marks the handle disposed (`handle.disposed === true`).
2. Aborts the lifecycle `AbortController`, which cancels in-flight `listTools` / `callTool`.
3. Aborts every per-tool `AbortController`, removing them from `navigator.modelContext`.
4. Awaits any in-flight sync that's now winding down.
5. Closes the MCP transport.

It's safe to call multiple times. Tool `execute()` calls made after dispose reject with `"WebMCP adapter has been disposed"`.

## Composition

The recommended pattern is to register page-local tools yourself and let the adapter handle the bridged ones, optionally with a `prefix` to keep the namespaces obviously separate:

```ts
import { registerWebMcp } from "agents/experimental/webmcp";

if ("modelContext" in navigator) {
  // 1. In-page tools — DOM, local state, Web APIs
  navigator.modelContext.registerTool({
    name: "page.scroll_to_section",
    description: "Scroll the page to a named section",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    },
    async execute({ id }) {
      document
        .getElementById(String(id))
        ?.scrollIntoView({ behavior: "smooth" });
      return "ok";
    }
  });
}

// 2. Remote tools — durable, authenticated, server-side
const handle = await registerWebMcp({
  url: "/mcp",
  prefix: "remote.",
  getHeaders: async () => ({ Authorization: `Bearer ${await getToken()}` })
});
```

Multiple `registerWebMcp` calls are also fine — bridge two MCP servers into the same page by giving them different prefixes:

```ts
const orders = await registerWebMcp({ url: "/orders/mcp", prefix: "orders." });
const billing = await registerWebMcp({
  url: "/billing/mcp",
  prefix: "billing."
});
```

## Edge Cases & Caveats

- **Tool name collisions are silent.** If two registrations use the same name, the second one wins (or appears alongside; the browser's behavior is unspecified). Use `prefix` and namespaced in-page names (`page.foo`) to stay safe.
- **Lossy content.** The adapter currently flattens MCP content arrays into a string: `text` items are joined with newlines, `image` items become `data:` URLs, anything else is best-effort. The `execute` promise must return a string in the current WebMCP shape; richer return types will need work as the spec evolves.
- **Watch mode requires SSE.** If the server returns 405 on the GET request used to receive notifications, the adapter logs a warning and continues without watch — tools won't auto-refresh, but everything else works.
- **Per-request timeout.** `timeoutMs` applies to `tools/list` and `tools/call`. There's no global "adapter is wedged" timeout; an unresponsive server will affect each call individually.
- **No SSR / Worker support.** The module imports the MCP SDK's HTTP transport and reads `navigator.modelContext`; it's browser-only by design. Importing it in a Worker or during SSR will resolve `globalThis.location` to `undefined` and may throw on relative URLs.
- **Logging.** All adapter messages prefix with `[webmcp-adapter]`. Pass `quiet: true` or a custom `logger` to redirect.

## Testing

The adapter has its own Playwright (Chromium, headless) test suite at `packages/agents/src/webmcp-tests/`. It covers:

- No-op path (no `navigator.modelContext`)
- Static and dynamic headers, merging precedence
- Tool discovery, schema fidelity, description fallback, annotations
- `prefix` — names registered, original names sent on the wire
- Tool execution, multi-content joining, image data-URLs, JSON-RPC errors, `isError: true`
- Async `dispose` aborting all controllers, idempotency, post-dispose execute rejection
- Concurrent `refresh()` calls coalescing into one sync
- Watch-mode re-sync via `tools/list_changed`
- Pagination (`nextCursor`)
- Custom logger and `quiet`
- Init-failure → reject (no `onError` double-fire)
- Server returns 405 on GET → graceful watch degradation

Run them with `npm run test:webmcp` from `packages/agents`.

## Related Material

- [`examples/webmcp/`](../examples/webmcp/) — Live demo with in-page tools + bridged tools, invoke UI, dark mode, connect/disconnect.
- [`packages/agents/src/experimental/webmcp.ts`](../packages/agents/src/experimental/webmcp.ts) — Source.
- [Chrome WebMCP issue (cloudflare/agents#1216)](https://github.com/cloudflare/agents/issues/1216) — Original feature request.
- [WebMCP Chrome extension](https://chromewebstore.google.com/detail/web-mcp/lmhcjoefoeigdnpmiamglmkggbnjlicl) — Inspect registered tools and invoke them outside of the AI flow.

## Open Questions

- **Per-tool filtering / transformation.** No way to opt-out of specific tools or rewrite descriptions before they hit the browser. A `filter?: (tool) => boolean` and `mapTool?: (tool) => tool` would help large MCP servers.
- **Streaming results.** WebMCP's `execute` returns a single value; MCP supports streaming via tasks. Bridging task-based tools is unexplored.
- **`requestUserInteraction` proxying.** WebMCP's `execute` receives a `client` argument with `requestUserInteraction`. The adapter doesn't currently surface this to the MCP server side because MCP has no analogous concept; future work could bridge it via elicitation.
- **Multiple-server orchestration helpers.** Today users glue together multiple `registerWebMcp` handles themselves. A higher-level "registry of registries" could help.

These are deliberately deferred until both the adapter and the browser API stabilize.
