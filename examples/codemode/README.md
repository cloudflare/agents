# Codemode Example

A project management chat app where the LLM writes and executes code to orchestrate tools, instead of calling them one at a time. Built with `@cloudflare/codemode` and `@cloudflare/ai-chat`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agents/tree/main/examples/codemode)

## What it demonstrates

**Server (`src/server.ts`):**

- `AIChatAgent` with `createCodeTool` -- the LLM gets a single "write code" tool
- `DynamicWorkerExecutor` -- runs LLM-generated code in isolated Worker sandboxes
- SQLite-backed tools (projects, tasks, sprints, comments) via `SqlStorage`

**Client (`src/client.tsx`):**

- `useAgentChat` for streaming chat with message persistence
- Collapsible tool cards showing generated code, results, and console output
- Kumo design system components with dark/light mode
- Browser client-tool variant documented in [`../../docs/codemode.md`](../../docs/codemode.md#browser-executor-with-dynamic-client-tools)

**Tools (`src/tools.ts`):**

- 10 project management tools: createProject, listProjects, createTask, listTasks, updateTask, deleteTask, createSprint, listSprints, addComment, listComments
- All backed by SQLite -- data persists across conversations

## Running

```bash
npm install   # from repo root
npm run build # from repo root
npm start     # from this directory -- starts Vite dev server
```

Uses Workers AI (no API key needed) with `@cf/moonshotai/kimi-k2.5`.

## Try it

- "Create a project called Alpha" -- LLM writes code that calls `codemode.createProject()`
- "Add 3 tasks to Alpha" -- LLM chains multiple tool calls in a single code block
- "List all projects and their tasks" -- LLM composes results from multiple tools
- Open Settings to switch between Dynamic Worker and Node Server executors

## Browser client-tool variant

The example app in this folder is server-executor focused to keep the runtime
surface small for review. If you want codemode to run entirely in the browser,
the docs now include a companion pattern that:

- defines browser-side tool functions directly
- builds codemode with `createBrowserCodeTool(...)`
- adapts the resulting descriptor to the client-tool shape your app uses
- registers the resulting `codemode` tool through `useAgentChat({ tools })`

See [`docs/codemode.md`](../../docs/codemode.md#browser-executor-with-dynamic-client-tools)
for the full server + client example.
