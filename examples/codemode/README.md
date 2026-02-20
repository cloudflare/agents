# Codemode Example

A project management chat app where the LLM writes and executes code to orchestrate tools, instead of calling them one at a time. Built with `@cloudflare/codemode` and `@cloudflare/ai-chat`.

## What it demonstrates

**Server (`src/server.ts`):**

- `AIChatAgent` with `createCodeTool` -- the LLM gets a single "write code" tool
- `DynamicWorkerExecutor` -- runs LLM-generated code in isolated Worker sandboxes
- `NodeServerExecutor` -- alternative executor using a Node.js VM (for local dev)
- SQLite-backed tools (projects, tasks, sprints, comments) via `SqlStorage`
- Switchable executor at runtime via HTTP endpoint

**Client (`src/client.tsx`):**

- `useAgentChat` for streaming chat with message persistence
- Collapsible tool cards showing generated code, results, and console output
- Settings panel to switch between Dynamic Worker and Node Server executors
- Kumo design system components with dark/light mode

**Tools (`src/tools.ts`):**

- 10 project management tools: createProject, listProjects, createTask, listTasks, updateTask, deleteTask, createSprint, listSprints, addComment, listComments
- All backed by SQLite -- data persists across conversations

## Running

```bash
npm install   # from repo root
npm run build # from repo root
npm start     # from this directory -- starts Vite dev server
```

Uses Workers AI (no API key needed) with `@cf/zai-org/glm-4.7-flash`.

To also run the Node executor (optional):

```bash
npm run start:node-executor  # starts Node VM server on port 3001
```

## Try it

- "Create a project called Alpha" -- LLM writes code that calls `codemode.createProject()`
- "Add 3 tasks to Alpha" -- LLM chains multiple tool calls in a single code block
- "What is 17 + 25?" -- simple calculation via `codemode.addNumbers()`
- "List all projects and their tasks" -- LLM composes results from multiple tools
- Open Settings to switch between Dynamic Worker and Node Server executors
