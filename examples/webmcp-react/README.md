# WebMCP React Starter

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agents/tree/main/examples/webmcp-react)

A React todo app that exposes the same actions to people and browser-based AI agents with [WebMCP](https://github.com/webmachinelearning/webmcp), deployed as a Cloudflare Worker.

> [!IMPORTANT]
> WebMCP is experimental. The Chrome testing setup below is temporary and may change as browser support evolves.

## What it demonstrates

- Four imperative tools to list, rename, complete or reopen, and delete todos
- One declarative tool generated from the visible add-todo form
- Shared React actions for UI controls and agent tools
- Runtime validation and JSON Schemas generated from Zod Mini
- Lifecycle-managed tool registration with cleanup on unmount
- A useful unsupported-browser state
- Browser-local persistence with `localStorage`

This differs from [`examples/webmcp`](../webmcp/), which bridges remote `McpAgent` tools into WebMCP with `registerWebMcp()`. This example focuses on page-local React state and the browser's imperative and declarative WebMCP APIs.

## WebMCP tools

| Tool                 | API         | Purpose                                      |
| -------------------- | ----------- | -------------------------------------------- |
| `list_todos`         | Imperative  | List all, active, or completed todos and IDs |
| `add_todo`           | Declarative | Create an active todo through the HTML form  |
| `rename_todo`        | Imperative  | Replace a todo's text                        |
| `set_todo_completed` | Imperative  | Complete or reopen a todo                    |
| `delete_todo`        | Imperative  | Permanently remove a todo                    |

Every tool invocation updates the same state as the human-facing controls. Tool output includes todo IDs for reliable follow-up calls.

## Run locally

From this directory:

```bash
pnpm install
pnpm run start
```

Open <http://localhost:5173>. Other useful commands:

```bash
pnpm run test    # Run the jsdom test suite
pnpm run build   # Create a production build
pnpm run types   # Regenerate Worker binding types
pnpm run deploy  # Build and deploy to Cloudflare
```

The directory is self-contained so create-cloudflare-cli can copy it as a standalone starter. Its package metadata and `.mcp.json` should remain usable outside this monorepo.

## Connect a coding agent

The checked-in [`.mcp.json`](./.mcp.json) configures [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) with experimental WebMCP support.

1. Open `chrome://flags/#enable-webmcp-testing` in Chrome, enable **WebMCP for testing**, and relaunch Chrome.
2. Open `chrome://inspect/#remote-debugging` and enable **Allow remote debugging for this browser instance**.
3. Open your MCP-compatible coding agent from this directory and enable the project-level **chrome-devtools** server. Restart an already-running agent so it discovers `.mcp.json`.
4. Start the app, open <http://localhost:5173> in that Chrome instance, and ask your agent:

   > Add a todo to buy groceries on http://localhost:5173

Chrome may ask you to approve the debugging connection, and your coding agent may separately require approval before executing a tool. The MCP configuration exposes only navigation plus WebMCP discovery and execution as direct tools.

WebMCP is governed by the `tools` Permissions Policy. A cross-origin iframe embedding this app must include `allow="tools"`.

## Key patterns

A semantic form declares the add tool:

```tsx
<form
  toolname="add_todo"
  tooldescription="Add one active todo to the current list."
  toolautosubmit=""
  onSubmit={submitTodo}
>
  <input
    name="text"
    required
    maxLength={200}
    toolparamdescription="The todo text, between 1 and 200 characters."
  />
  <button type="submit">Add todo</button>
</form>
```

Imperative tools register for the component lifecycle:

```tsx
useEffect(() => {
  const controller = new AbortController();

  void document.modelContext?.registerTool(tool, {
    signal: controller.signal
  });

  return () => controller.abort();
}, [tool]);
```

Use declarative tools for existing semantic forms. Use imperative tools for reads, complex inputs, or actions that do not naturally map to one form submission. Keep runtime validation in either path; a browser-visible schema is not a validation boundary.

## Persistence

The default uses `localStorage` so it runs without configuration. See [Persist todos with Cloudflare D1](./docs/d1.md) to make todos durable across browsers and devices.

## Project structure

```text
.mcp.json              Coding-agent connection for WebMCP tools
docs/d1.md             Optional D1 persistence guide
src/App.tsx            Todo UI and declarative WebMCP form
src/schemas.ts         Zod Mini contracts and generated JSON Schemas
src/useTodos.ts        Shared localStorage-backed todo actions
src/useWebMCPTools.ts  Imperative WebMCP definitions and registration
src/webmcp.d.ts        Experimental WebMCP type additions
src/server.ts          Worker fallback for unmatched asset requests
```

## Resources

- [WebMCP proposal and specification](https://github.com/webmachinelearning/webmcp)
- [Chrome WebMCP imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [Chrome WebMCP declarative API](https://developer.chrome.com/docs/ai/webmcp/declarative-api)
- [React on Cloudflare Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
