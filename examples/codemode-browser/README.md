# Browser Codemode Example

A minimal codemode app where the LLM calls a single `codemode` client tool, and
that tool runs generated JavaScript in a browser iframe sandbox via
`IframeSandboxExecutor`.

This example is intentionally separate from `examples/codemode`, which remains
the server-side `DynamicWorkerExecutor` example with SQLite-backed tools and MCP
server management.

## What it demonstrates

**Server (`src/server.ts`):**

- `AIChatAgent` with `createToolsFromClientSchemas()`
- no server-side code executor — the server only streams model responses and
  advertises client-provided tool schemas

**Client (`src/client.tsx`):**

- `createBrowserCodeTool()` from `@cloudflare/codemode/browser`
- `IframeSandboxExecutor` for sandboxed browser execution
- `useAgentChat({ tools, onToolCall })` to execute the client-side codemode tool
- browser-memory project/task tools and a `getPageInfo` browser-only tool

## Running

```bash
npm install   # from repo root
npm run build --workspace agents
npm run build --workspace @cloudflare/ai-chat
npm run build --workspace @cloudflare/codemode
npm start     # from this directory
```

Uses Workers AI through the `AI` binding.

## Try it

- "Create a project called Alpha, add two tasks, then list all projects and tasks"
- "What is the current page title?"
- "Use codemode to create a project and then update the first task to done"
