# WebMCP Adapter

> **WARNING: EXPERIMENTAL.** This example uses `agents/experimental/webmcp` which is under active development and **will break** between releases. Google's WebMCP API (`navigator.modelContext`) is still in early preview.

Bridges tools registered on an `McpAgent` to Chrome's native `navigator.modelContext` API, and shows how to combine them with page-local tools so the browser AI sees a single, unified toolbox.

## What it demonstrates

- **`registerWebMcp()`** — one-line adapter that discovers MCP tools and registers them with Chrome's WebMCP
- **In-page tools alongside remote tools** — page-only behaviors (scrolling, theme switching, reading `location.href`) registered directly with `navigator.modelContext.registerTool` and shown side-by-side with bridged `McpAgent` tools
- **Namespacing via `prefix`** — bridged tools come in as `remote.add`, `remote.greet`, etc. so they can't collide with page-local names
- **Connect / Disconnect / Refresh** — explicit lifecycle controls so you can see `dispose()` and `refresh()` in action
- **In-page invoke UI** — for in-page tools, click "Invoke" to run them straight from the page (remote tools are meant to be called by the browser AI, so the UI links to the WebMCP Chrome extension instead)
- **Feature detection** — graceful no-op + visible status when `navigator.modelContext` is unavailable
- **Dynamic sync** — listens for `tools/list_changed` notifications and re-registers automatically

## Running

```sh
npm install
npm start
```

Open in Chrome Canary with `#enable-webmcp-testing` and `#enable-experimental-web-platform-features` enabled at `chrome://flags` to see full WebMCP integration. On other browsers, the page still loads — the adapter detects the missing API, shows a status banner, and the in-page invoke buttons still work for testing the tools' execute functions directly.

## How it works

The server defines tools using `McpAgent` as usual:

```typescript
export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({ name: "WebMCP Demo", version: "1.0.0" });

  async init() {
    this.server.registerTool(
      "greet",
      {
        description: "Greet someone by name",
        inputSchema: { name: z.string() }
      },
      async ({ name }) => ({
        content: [{ type: "text", text: `Hello, ${name}!` }]
      })
    );
  }
}

export default MyMCP.serve("/mcp", { binding: "MyMCP" });
```

The client registers a few in-page tools and bridges the remote ones:

```typescript
import { registerWebMcp } from "agents/experimental/webmcp";

// 1. In-page tools — things only the page can do
navigator.modelContext?.registerTool({
  name: "page.scroll_to_top",
  description: "Scroll the demo page back to the top",
  execute: async () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return "ok";
  }
});

// 2. Bridge the McpAgent — durable storage, server-side auth, etc.
const handle = await registerWebMcp({
  url: "/mcp",
  prefix: "remote.",
  getHeaders: async () => ({ Authorization: `Bearer ${await getToken()}` })
});

// Clean up when the page is leaving
await handle.dispose();
```

The browser AI now sees `page.scroll_to_top` and `remote.greet` / `remote.add` / `remote.get_counter` in the same `navigator.modelContext` registry. It picks tools by name without knowing or caring whether they execute in the page or on the server.

## When to use page tools vs. remote tools

| Use case                                                | Where it should live                           |
| ------------------------------------------------------- | ---------------------------------------------- |
| DOM manipulation, scrolling, theme, focus, clipboard    | **In-page** — direct `navigator.modelContext`  |
| Reading local UI state (Zustand, Redux, IndexedDB)      | **In-page**                                    |
| Calling Web APIs (geolocation, file picker, WebRTC)     | **In-page**                                    |
| Reading or mutating durable data (KV, R2, D1, DO state) | **Remote** — via `registerWebMcp` + `McpAgent` |
| Calling third-party APIs with secret credentials        | **Remote** (so the secret stays in the Worker) |
| Anything that needs to survive the tab being closed     | **Remote**                                     |
| Tools that should be available across many browsers     | **Remote**                                     |

## Related examples

- [`mcp`](../mcp/) — stateful MCP server with built-in tool tester UI
- [`mcp-client`](../mcp-client/) — connecting to MCP servers as a client

## See also

- [`experimental/webmcp.md`](../../experimental/webmcp.md) — design notes, options reference, and edge cases
