# AI Chat Example

A complete chat application built with `@cloudflare/ai-chat` showcasing the recommended patterns.

## What it demonstrates

**Server (`src/server.ts`):**

- `toUIMessageStreamResponse()` -- the simplest streaming pattern
- Server-side tools with `execute` (weather lookup)
- Client-side tools without `execute` (browser timezone)
- Tool approval with `needsApproval` (calculation with amount threshold)
- `pruneMessages()` for managing LLM context in long conversations
- `maxPersistedMessages` for storage management

**Client (`src/client.tsx`):**

- `useAgentChat` with `onToolCall` for client-side tool execution
- `addToolApprovalResponse` for approve/reject UI
- `body` option for sending custom data with every request
- Tool part rendering (executing, completed, approval requested)
- Kumo design system components

## Running

```bash
npm install
npm run dev
```

Uses Workers AI (no API key needed) with `@cf/zai-org/glm-4.7-flash`.

## Try it

- "What's the weather in London?" -- server-side tool, executes automatically
- "What timezone am I in?" -- client-side tool, browser provides the result
- "Calculate 150 \* 3, amount is $450" -- requires approval before executing
- Have a long conversation -- old tool calls are pruned from LLM context automatically
