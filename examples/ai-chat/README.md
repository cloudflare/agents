# AI Chat Example

A complete chat application built with `@cloudflare/ai-chat` showcasing the recommended patterns.

## What it demonstrates

**Server (`src/server.ts`):**

- `toUIMessageStreamResponse()` -- the simplest streaming pattern
- One-shot Kitesurf browser automation via the CDP-backed `browser_execute` tool from `agents/browser/ai`
- Server-side tools with `execute` (weather lookup)
- Client-side tools without `execute` (browser timezone)
- Tool approval with `needsApproval` (calculation with amount threshold)
- `pruneMessages()` for managing LLM context in long conversations
- `maxPersistedMessages` for storage management
- client resumable streaming on reconnect, plus `chatRecovery` for Durable Object eviction recovery: an interrupted turn (deploy/OOM/hibernation mid-stream) self-resumes from its persisted partial via `_chatRecoveryContinue`, and clients see a live "recovering…" status (also replayed on reconnect)

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

Uses Workers AI (no API key needed) with `@cf/moonshotai/kimi-k2.7-code`.

The Browser Run binding is configured with `remote: true`, so Kitesurf runs remotely while the rest of the Worker runs locally. No separate browser process is required.

## Try it

- "Open https://example.com and tell me the page title" -- navigates and evaluates the page through Kitesurf CDP
- "Visit https://developers.cloudflare.com/agents/ and summarize the page" -- reads a page in one Kitesurf execution
- "Take a screenshot of https://example.com" -- captures the page through Kitesurf and renders the image inline.
- "Visit https://example.com, list its links, and take a screenshot" -- exercises multi-step automation over one Kitesurf connection
- "What's the weather in London?" -- server-side tool, executes automatically
- "What timezone am I in?" -- client-side tool, browser provides the result
- "Calculate 150 \* 3, amount is $450" -- requires approval before executing
- Have a long conversation -- old tool calls are pruned from LLM context automatically

This example uses Kitesurf as a one-shot browser and disables Quick Actions, which cannot currently select the Kitesurf engine.
