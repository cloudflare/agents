# Sidekick — Discord Bot on Cloudflare Workers

A Discord bot built with [Chat SDK](https://chat-sdk.dev) and [Cloudflare Workers](https://developers.cloudflare.com/workers/). Supports slash commands, @mention conversations via the Discord Gateway, interactive cards, and persistent state via Durable Objects.

## Architecture

```
Discord
  │
  ├─ Slash commands (/ask, /help)       ─── HTTP POST ──▶ ┌─────────────────────┐
  │  Button clicks (mode, feedback)                       │   Cloudflare Worker  │
  │                                                       │   (fetch handler)    │
  │                                                       │                      │
  └─ @mentions                          ─── Gateway ───▶  │   (scheduled handler)│
     (requires WebSocket)                   WebSocket     └──────────┬──────────┘
                                                                    │
                                           Chat SDK routes events   │
                                           to handlers              │
                                                                    │
                                              ┌─────────────────────┤
                                              │                     │
                                     handler RPC             Chat SDK (auto)
                                              │                     │
                                              ▼                     ▼
                              ┌──────────────────────┐    ┌────────────────┐
                              │    ChatAgent DO      │    │  ChatStateDO   │
                              │    (one per channel) │    │  (shared)      │
                              │                      │    │                │
                              │  - History (SQLite)  │    │ - Subscriptions│
                              │  - ask()             │    │ - Thread state │
                              │  - summarize()       │    │ - Locks/cache  │
                              └──────────┬───────────┘    └────────────────┘
                                         │
                                         │ generateText()
                                         ▼
                                  ┌────────────┐
                                  │ Workers AI │
                                  │ GLM-4.7    │
                                  │ Flash      │
                                  └────────────┘
```

**Key components:**

- **Runtime**: Cloudflare Workers
- **Bot framework**: [Chat SDK](https://chat-sdk.dev) with the Discord adapter
- **AI**: Workers AI (GLM-4.7 Flash) via the [Agents SDK](https://developers.cloudflare.com/agents/) `ChatAgent` Durable Object
- **State**: [chat-state-cloudflare-do](https://github.com/dcartertwo/chat-state-cloudflare-do) — SQLite-backed DO for subscriptions, thread state, and caching
- **Gateway**: Cron trigger (every 2 min) opens a Discord Gateway WebSocket to receive @mentions

### How the two entry points work

| Path        | Trigger                | What happens                                                                            |
| ----------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `fetch`     | HTTP POST from Discord | Slash commands (`/ask`, `/help`) and button interactions (mode, feedback, summarize)    |
| `scheduled` | Cron every 2 min       | Opens a Gateway WebSocket for 2 min to receive @mentions, then the next cron takes over |

Slash commands arrive via Discord's HTTP Interactions API. @mentions only arrive via the Gateway WebSocket — there is no HTTP fallback for mentions.

## Features

- `/ask <question>` — AI response with conversation memory (per channel)
- `/help` — interactive help card with links
- `@Sidekick <question>` — mention-based conversation via Gateway WebSocket
- **Mode selection** — concise, detailed, or creative response styles (persisted per thread)
- **Thread summarization** — condense conversation history into key points
- **Feedback buttons** — thumbs up/down with ephemeral acknowledgement

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Secret                   | Source                                         |
| ------------------------ | ---------------------------------------------- |
| `DISCORD_BOT_TOKEN`      | Discord Developer Portal → Bot → Token         |
| `DISCORD_PUBLIC_KEY`     | Discord Developer Portal → General Information |
| `DISCORD_APPLICATION_ID` | Discord Developer Portal → General Information |

AI is provided by Workers AI (`env.AI` binding) — no API key needed.

For production:

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APPLICATION_ID
```

### 3. Discord Developer Portal

1. Create an application at https://discord.com/developers/applications
2. Go to **Bot** → enable **Message Content Intent** under Privileged Gateway Intents
3. Invite the bot with `bot` and `applications.commands` scopes
4. Set **Interactions Endpoint URL** to `https://<your-worker>.workers.dev/api/webhooks/discord`

### 4. Development

```bash
npm start
```

### 5. Deploy

```bash
npm run deploy
```

## Project Structure

```
src/
  index.ts       Worker entry — fetch (HTTP) and scheduled (cron) handlers
  bot.ts         Chat SDK bot creation, Discord adapter + DO state config
  handlers.ts    /ask, /help, @mention, mode/feedback/summarize handlers
  agent.ts       ChatAgent Durable Object — conversation history + AI calls
  prompts.ts     System prompts per mode (concise/detailed/creative)
  cards.ts       Interactive card components (ResponseCard, HelpCard, SummaryCard)
  types.ts       Shared types — ThreadState, Mode, AgentState
  ws-shim.ts     WebSocket shim for discord.js on Workers (see below)
wrangler.jsonc   Worker config, cron triggers, DO bindings, module aliases
```

## discord.js WebSocket Shim

discord.js has built-in support for the Web WebSocket API, but its runtime detection (`shouldUseGlobalFetchAndWebSocket()` in `@discordjs/util`) fails on Workers when `nodejs_compat` is enabled. The polyfilled `globalThis.process` makes it think it's Node.js, so it uses the `ws` npm package (TCP sockets) which silently hangs — Workers doesn't support raw TCP.

The fix is a two-line module alias:

- `wrangler.jsonc`: `"alias": { "ws": "./src/ws-shim.ts" }`
- `src/ws-shim.ts`: re-exports `globalThis.WebSocket`

This makes every `import { WebSocket } from "ws"` in discord.js resolve to the native Web WebSocket API, which Workers supports for outbound connections.

## Note on `@callable()` Decorators

The `ask()` and `summarize()` methods on `ChatAgent` are marked `@callable()`. This example uses Cloudflare native RPC (`stub.ask(...)`) to call them from the Worker, which works without any decorator transform. However, if you add a React frontend using `useAgent` + `agent.call("ask", [...])`, you'll need a `vite.config.ts` with the `agents()` plugin to transform the decorators at build time:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import agents from "agents/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agents(), cloudflare()]
});
```

See the [`ai-chat`](../ai-chat) example for a full-stack reference.

## Related Examples

- [`ai-chat`](../ai-chat) — Web-based chat using `AIChatAgent` with Workers AI
- [`github-webhook`](../github-webhook) — External webhook → Agent DO → React dashboard
