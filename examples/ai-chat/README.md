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
- "Take a screenshot of https://example.com" -- calls Kitesurf's `Page.captureScreenshot` and renders the image inline. Kitesurf navigation can finish before layout and paint, so the generated program polls for a complete, non-empty document and waits another second before capturing. It returns `{ type: "browser_screenshot", mediaType: "image/png", data }`; the full base64 is retained for the UI while `toModelOutput` gives the model only a short attachment summary.
- "Visit https://example.com, list its links, and take a screenshot" -- exercises multi-step automation over one Kitesurf connection
- "What's the weather in London?" -- server-side tool, executes automatically
- "What timezone am I in?" -- client-side tool, browser provides the result
- "Calculate 150 \* 3, amount is $450" -- requires approval before executing
- Have a long conversation -- old tool calls are pruned from LLM context automatically

Kitesurf is scoped to one CDP WebSocket. The browser tool therefore does not expose session reuse, pause/resume, Live View, recording, or CDP protocol discovery. Binding-backed Quick Actions remain disabled because `BrowserRun.quickAction()` does not currently expose a Kitesurf selector.

`cdp.send()` returns the CDP method result directly rather than the outer JSON-RPC envelope. For example, read `target.targetId`, `evaluation.result.value`, and `screenshot.data`—not `target.result.targetId`, `evaluation.result.result.value`, or `screenshot.result.data`. Use `cdp.attachToTarget({ targetId })` rather than sending `Target.attachToTarget` manually.
