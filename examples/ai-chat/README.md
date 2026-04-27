# AI Chat Example

A complete chat application built with `@cloudflare/ai-chat` showcasing the recommended patterns.

## What it demonstrates

**Server (`src/server.ts`):**

- `toUIMessageStreamResponse()` -- the simplest streaming pattern
- Browser Rendering tools via `agents/browser/ai`
- Server-side tools with `execute` (weather lookup)
- Client-side tools without `execute` (browser timezone)
- Tool approval with `needsApproval` (calculation with amount threshold)
- `pruneMessages()` for managing LLM context in long conversations
- `maxPersistedMessages` for storage management

**Client (`src/client.tsx`):**

- `useAgentChat` with `onToolCall` for client-side tool execution
- `addToolApprovalResponse` for approve/reject UI
- `body` option for sending custom data with every request
- Tool part rendering, including inline browser screenshots
- Kumo design system components

## Running

```bash
npm install
npm start
```

Uses Workers AI (no API key needed) with `@cf/moonshotai/kimi-k2.5`.

Recent Wrangler releases run the Browser Rendering binding locally, so no separate Chrome process is required.

## Try it

- "Open https://example.com and tell me the page title" -- uses the browser binding and CDP tools
- "Search the CDP spec for screenshot commands" -- exercises `browser_search`
- "Take a screenshot of https://example.com" -- exercises `browser_execute` and renders the image inline
- "What's the weather in London?" -- server-side tool, executes automatically
- "What timezone am I in?" -- client-side tool, browser provides the result
- "Calculate 150 \* 3, amount is $450" -- requires approval before executing
- Have a long conversation -- old tool calls are pruned from LLM context automatically

## Related

- [`examples/agents-as-tools`](../agents-as-tools) — for delegating work to a helper sub-agent during a turn, with the helper's lifecycle events streaming live into the chat UI. Built on Think; the AIChatAgent equivalent will land here as a one-tool demo once the design firms up.
