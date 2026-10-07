# Web Research Example

A chat agent that answers questions from the live web. It searches with the `web_search` tool from `agents/websearch/ai-sdk`, which wraps [Cloudflare's Web Search API](https://developers.cloudflare.com/web-search/), and cites what it finds.

Every search also shows up in the panel next to the chat, so you can see three views of the same call:

- **Results**: the ranked pages the search returned.
- **Model saw**: the trimmed text the model actually read (the tool's `toModelOutput`).
- **You got**: the full structured response your code keeps in the message history.

## What it demonstrates

**Server (`src/server.ts`):**

- `webSearchTool()` on the Worker's `AI` binding, with the host deciding the provider, the result cap, and how much of each result the model reads
- Provider and result cap kept in the agent's state, changed from the UI with `setState` and checked in `validateStateChange`
- `convertToModelMessages(messages, { tools })`, so earlier searches are replayed to the model as the trimmed text it first saw, not as the full JSON
- A custom `onError` that shows why a search or model call failed (for example, missing AI Gateway credits) instead of the AI SDK's generic "An error occurred."
- A system prompt with today's date and inline numbered citations

**Client (`src/client.tsx`):**

- Typed `tool-web_search` parts via `useAgentChat<unknown, ResearchMessage>()`
- Search settings (provider, max results) in the panel, synced through `useAgent` state
- `renderWebSearchResults()` from `agents/websearch` to show the exact text the model saw, using the same `maxDescriptionChars` as the server (`src/shared.ts`)
- A feed that follows the stream only while you're at the bottom, so you can scroll up and read mid-reply
- Reusable chat pieces (feed, composer, markdown, tool rows) in `src/chat-ui.tsx`, built on Kumo

## Running

```bash
npm install
npm start
```

You need:

- **Wrangler 4.141.0 or later** (the example uses 4.145). Older runtimes don't have `env.AI.websearch()`.
- **A Cloudflare account that can pay for searches.** Searches are billed to the default AI Gateway on the account the Worker runs on, from AI Gateway credits or a provider key stored on the gateway (BYOK). Without either, every search fails with `web_search_payment_required` and the agent tells you so.

The `AI` binding has no local implementation, so `npm start` runs it remotely against the account you're logged in to with `wrangler login`. If you belong to more than one account, set `CLOUDFLARE_ACCOUNT_ID`. If your `workers.dev` subdomain is behind Cloudflare Access, sign in through the browser when Wrangler asks.

The model is `@cf/deepseek-ai/deepseek-v4-pro-0813` on Workers AI (`MODEL` in `src/shared.ts`).

## Try it

- "Who won the most recent Formula 1 Grand Prix?": the model usually searches more than once, rephrasing as it goes
- "What's new in the Cloudflare Agents SDK this month?": open a search and compare **Model saw** with **You got** to see how much the tool trims
- Ask a follow-up question. Earlier searches stay in context, so the model can answer without searching again.

## Choosing a provider

The default is `ceramic`. `exa` and `linkup` cost more per search but often return better results for specific factual questions. Switch between them under **Search settings** to compare; the change applies from your next message.
