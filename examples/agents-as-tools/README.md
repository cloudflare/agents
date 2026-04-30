# Agents as Tools

A focused demo of the framework **agent tools** pattern: during a chat turn, the
assistant dispatches chat-capable sub-agents, streams their timelines inline, and
keeps those sub-agents available for replay and drill-in.

This example now uses the shipped primitives:

- `agentTool(Researcher, ...)` for ordinary LLM-selected helper calls.
- `this.runAgentTool(Researcher, ...)` for explicit fan-out from the `compare`
  tool.
- `useAgentToolEvents({ agent })` to collect `agent-tool-event` frames in React.
- `clearAgentToolRuns()` to delete retained child facets when the chat is
  cleared.

For the general API guide, see [`docs/agent-tools.md`](../../docs/agent-tools.md).

## Run

```bash
npm install
npm start
```

Open the dev URL and ask for research or planning:

- _Research the top three Rust web frameworks and compare their throughput._
- _Find me three good arguments for and against monorepos._
- _What changed in HTTP/3 versus HTTP/2?_
- _Plan how I should add rate limiting to a Worker._

The assistant can call `research`, `plan`, or `compare`. Each call starts a real
Think sub-agent (`Researcher` or `Planner`) with its own model, tools, messages,
SQLite storage, and resumable chat stream. The parent forwards the child stream
as `agent-tool-event` frames and the UI renders a live mini-chat panel under the
matching tool call.

## What It Demonstrates

```text
Browser ──ws──▶ Assistant DO ──┬──▶ chat stream
                                │
                                └──▶ agent-tool-event frames
                                           │
                                           ▼
                                Researcher / Planner facet
```

The important pieces are:

- **Agent tools as real chat agents.** Children extend `Think`, so each helper
  has its own prompt, tools, stream durability, and direct chat endpoint.
- **Inline child timelines.** The parent broadcasts `started`, `chunk`, and
  terminal events tagged with the parent `toolCallId`. The React hook groups
  runs by tool call and rebuilds child message parts from stored AI SDK chunks.
- **Parallel fan-out.** `compare` dispatches two `Researcher` runs with the same
  parent tool call id and different display order values, so both panels render
  under one tool part.
- **Drill-in.** Each panel has an open button that connects directly to
  `/sub/{agent}/{runId}` with `useAgentChat`; it is the child agent's real chat,
  not a synthetic event viewer.
- **Retention and cleanup.** Runs are retained for refresh replay until the user
  clears the chat, which calls the framework cleanup API.

## Server

`src/server.ts` defines three agents:

- `Assistant extends Think` is the parent chat agent. It exposes `research` and
  `plan` through `agentTool(...)`, and implements `compare` by calling
  `runAgentTool(...)` twice in parallel.
- `Researcher extends Think` uses a simulated `web_search` tool and summarizes a
  topic.
- `Planner extends Think` uses a simulated `inspect_file` tool and writes an
  implementation plan.

The example also keeps the production sub-agent gate:

```ts
override async onBeforeSubAgent(_request, child) {
  if (!this.hasAgentToolRun(child.className, child.name)) {
    return new Response("Not found", { status: 404 });
  }
}
```

That prevents callers from inventing arbitrary child names and opening empty
facets.

## Client

`src/client.tsx` uses one parent connection:

```ts
const agent = useAgent({ agent: "Assistant", name: USER });
const chat = useAgentChat({ agent });
const agentTools = useAgentToolEvents({ agent });
```

`agentTools.runsByToolCallId` is passed into the message renderer. When a tool
part appears, the renderer looks up child runs with the same `toolCallId` and
renders a panel for each run.

For drill-in, the panel opens a direct sub-agent connection:

```ts
const helperAgent = useAgent({
  agent: "Assistant",
  name: USER,
  sub: [{ agent: helperType, name: runId }]
});
const { messages, sendMessage } = useAgentChat({ agent: helperAgent });
```

## Tests

Run the example tests and typecheck with:

```bash
npm test
npx tsc -p examples/agents-as-tools/tsconfig.json --noEmit
```

The example-level tests validate the public contract it relies on: retained
agent-tool rows, drill-in gating, and cleanup. Deeper framework coverage lives
in `packages/agents` and `packages/think`.
