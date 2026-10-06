# Search the Web (Beta)

`agents/websearch` gives a model a `websearch` tool over Cloudflare's [Web Search API](https://developers.cloudflare.com/web-search/), called through the `AI` binding and billed by the account's AI Gateway. The same tool is available for the pi harness, the AI SDK, and TanStack AI, with the same options.

This page covers what the SDK adds on top of the API. For the binding, the providers, pricing, payment, and the error codes, see the [Web Search API docs](https://developers.cloudflare.com/web-search/).

> **Beta** — this feature may have breaking changes in future releases.

## Quick Start

You need:

- An `AI` binding: `"ai": { "binding": "AI" }` in `wrangler.jsonc`.
- workerd 1.20260924.1 or later, which is where `env.AI.websearch()` arrived. It ships with wrangler 4.141.0 and `@cloudflare/vite-plugin` 1.60.2.
- AI Gateway credits or a provider key on the gateway, in the account the Worker runs in. That account pays for every search. The `AI` binding always calls Cloudflare, so under `wrangler dev` searches run against, and bill, the account you are logged in to.

Then add the tool to your harness. Every adapter takes the same options.

Pi harness:

```ts
import { webSearchTool } from "agents/websearch/pi";

this.registry.install({
  name: "tools",
  tools: [webSearchTool({ binding: this.env.AI, provider: "exa" })]
});
```

AI SDK:

```ts
import { webSearchTool } from "agents/websearch/ai-sdk";

const result = streamText({
  model,
  tools: { websearch: webSearchTool({ binding: this.env.AI }) },
  messages
});
```

TanStack AI:

```ts
import { webSearchTool } from "agents/websearch/tanstack-ai";

const tools = [webSearchTool({ binding: this.env.AI })];
```

## Options

The model's input is `{ query, limit? }` and nothing else. The host fixes everything that affects cost or data handling:

| Option                | Default              | Notes                                                                                                                                   |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `binding`             | —                    | The `AI` binding. Or pass `source` instead (see [Other sources](#other-sources)).                                                       |
| `gateway`             | `"default"`          | AI Gateway id.                                                                                                                          |
| `provider`            | platform default     | `"ceramic"`, `"exa"`, or `"linkup"`. The model cannot choose or change it.                                                              |
| `byokAlias`           | —                    | Bill a provider key stored on the gateway. Passed through as the API defines it.                                                        |
| `limit`               | `5`                  | Results per search when the model does not ask for a count, and the most it may ask for. The input schema tells the model this maximum. |
| `maxDescriptionChars` | `600`                | Per-result description length in the model's view. `Infinity` passes descriptions through whole.                                        |
| `description`         | built-in description | Replaces the tool description the model sees.                                                                                           |

## Model Interface

The model gets text: a numbered list of title, URL, and description, with descriptions trimmed to `maxDescriptionChars`. Some providers return descriptions of several thousand characters per result, so the default keeps a five-result search to a few kilobytes of context.

```
3 results for "cloudflare web search api":

1. Introducing the Web Search API
https://blog.cloudflare.com/introducing-web-search-api/
Today we are launching the Web Search API in open beta…

2. …
```

The host gets the API response untouched — `items` with every field the provider returned, `metadata` with `requestId` and `latencyMs`, plus `provider` — as `WebSearchToolOutput`:

- **Pi**: in the tool result's `details`, as `{ ok: true, output }`. The tool is `replay: "safe"`, so a session resumed after an eviction reuses the stored result instead of searching again.
- **AI SDK**: as the return value of `execute`, so `onFinish`, UI message parts, and logs see the full response. `toModelOutput` renders the text for the model.
- **TanStack AI**: the server tool returns the rendered text.

`renderWebSearchResults(output, { maxDescriptionChars })` from `agents/websearch` is the renderer, if you want the same text elsewhere.

## Failures

A failed search becomes a `WebSearchError` with `status`, `code`, `retryable`, and `requestId` (AI Gateway's id for the request, for the gateway log). The `code` is the API's, for example `web_search_payment_required`. On a runtime older than the one above, the binding has no `websearch()` and the search fails with code `websearch_unsupported_runtime`.

The pi and TanStack tools do not throw. The model gets `Web search failed: <message> (<code>)` as an error result and the turn continues; in pi, `details` is `{ ok: false, status, code, retryable, requestId }`. The AI SDK tool throws the `WebSearchError`, which is how AI SDK tools report errors.

## Other sources

`createAIWebSearch` and `createHTTPWebSearch` from `agents/websearch` return a `WebSearchSource`: a function from `{ query, limit? }` to the API response, with no model involved. Use them from scheduled jobs, or outside Workers:

```ts
import { createHTTPWebSearch } from "agents/websearch";

const search = createHTTPWebSearch({
  accountId: env.CF_ACCOUNT_ID,
  apiToken: env.CF_API_TOKEN,
  provider: "linkup"
});
const { items } = await search({ query: "cloudflare agents sdk", limit: 3 });
```

Any `WebSearchSource` can be passed to a tool as `source` instead of `binding`, which is also how tests substitute a fake:

```ts
webSearchTool({
  source: async ({ query }) => ({
    items: [{ url: "https://example.com", title: query }],
    metadata: { query, requestId: "test", latencyMs: 0 }
  })
});
```
