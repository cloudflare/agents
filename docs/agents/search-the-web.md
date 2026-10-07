# Search the Web (Beta)

`agents/websearch` gives a model a `web_search` tool over Cloudflare's [Web Search API](https://developers.cloudflare.com/web-search/), called through the `AI` binding and billed by the account's AI Gateway. The same tool is available for the pi harness, the AI SDK, and TanStack AI.

This page covers what the SDK adds on top of the API. For the binding, the providers, pricing, payment, and the error codes, see the [Web Search API docs](https://developers.cloudflare.com/web-search/).

> **Beta** — this feature may have breaking changes in future releases.

## Quick Start

You need:

- An `AI` binding: `"ai": { "binding": "AI" }` in `wrangler.jsonc`.
- workerd 1.20260924.1 or later, which is where `env.AI.websearch()` arrived. It ships with wrangler 4.141.0 and `@cloudflare/vite-plugin` 1.60.2.
- AI Gateway credits or a provider key on the gateway, in the account the Worker runs in. That account pays for every search. The `AI` binding always calls Cloudflare, so under `wrangler dev` searches run against, and bill, the account you are logged in to.

Then add the tool to your harness. Every adapter takes the same options; the TanStack AI adapter also takes `name`, because TanStack AI tools carry their name in the definition.

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
  tools: { web_search: webSearchTool({ binding: this.env.AI }) },
  messages
});
```

If you convert UI messages yourself, pass the same tools to `convertToModelMessages(messages, { tools })`. Without them, the AI SDK sends earlier search results back to the model as the full JSON response instead of the trimmed text. `AiSdkHarness` does this for you.

TanStack AI:

```ts
import { webSearchTool } from "agents/websearch/tanstack-ai";

const tools = [webSearchTool({ binding: this.env.AI })];
```

## Options

The model's input is `{ query, limit? }` and nothing else. The host fixes everything that affects cost or data handling. An invalid `limit`, `maxDescriptionChars`, `timeoutMs`, or `byokAlias` throws a `RangeError` when the tool is created:

| Option                | Default              | Notes                                                                                                                                                     |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binding`             | —                    | The `AI` binding. Or pass `source` instead (see [Other sources](#other-sources)).                                                                         |
| `gateway`             | `"default"`          | AI Gateway id.                                                                                                                                            |
| `provider`            | platform default     | `"ceramic"`, `"exa"`, or `"linkup"`. The model cannot choose or change it.                                                                                |
| `byokAlias`           | —                    | Bill a provider key stored on the gateway. Passed through as the API defines it.                                                                          |
| `limit`               | `5`                  | Results per search when the model does not ask for a count, and the most it gets when it asks for more. The tool description tells the model this number. |
| `maxDescriptionChars` | `600`                | Per-result description length in the model's view. `Infinity` passes descriptions through whole.                                                          |
| `description`         | built-in description | Replaces the tool description the model sees.                                                                                                             |
| `timeoutMs`           | `30000`              | Give up on a search after this long, as a retryable `web_search_timeout` failure.                                                                         |

## Model Interface

The model gets text: a numbered list of title, URL, and description, with descriptions trimmed to `maxDescriptionChars`. Some providers return descriptions of several thousand characters per result, so the default keeps a five-result search to a few kilobytes of context.

```
3 results for "cloudflare web search api":

1. Introducing the Web Search API
https://blog.cloudflare.com/introducing-web-search-api/
Today we are launching the Web Search API in open beta…

2. …
```

The host gets the full API response, without trimming, as `WebSearchToolOutput`: `items` with their whole descriptions and every documented field, `metadata` with `requestId` and `latencyMs`, plus `provider`. Items without a URL are dropped, a missing title falls back to the URL, and fields the API does not document are left out:

- **Pi**: in the tool result's `details`, as `{ ok: true, output }`. The tool is `replay: "safe"`: if a search is interrupted mid-call, for example by an eviction, pi runs it again when the session recovers, and that is a second billed search. Completed results are stored and not searched again.
- **AI SDK**: as the return value of `execute`, so `onFinish`, UI message parts, and logs see the full response. `toModelOutput` renders the text for the model.
- **TanStack AI**: the server tool returns the rendered text, so the host gets the same text the model does.

`renderWebSearchResults(output, { maxDescriptionChars })` from `agents/websearch` is the renderer, if you want the same text elsewhere.

The API has no pagination. The tool description tells the model to search again with a rephrased query when it wants more or different results.

## Failures

A failed search becomes a `WebSearchError` with `status`, `code`, `retryable`, and `requestId` (AI Gateway's id for the request, for the gateway log). Every error has a `code`: the API's own when it sends one, for example `web_search_payment_required`, otherwise one derived from the HTTP status, such as `web_search_rate_limited` or `web_search_unavailable`. On a runtime older than the one above, the binding has no `websearch()` and the search fails with code `web_search_unsupported_runtime`.

The error's `message` is written for you, and can say to top up credits or configure a key. The model gets different text that tells it what to do next: fix the query, retry once, or carry on without search.

- **Pi**: the tool returns an error result with the model's text, and `details` is `{ ok: false, message, status, code, retryable, requestId }`.
- **AI SDK** and **TanStack AI**: the tool throws a `WebSearchError`, which is how those frameworks report tool errors. Its `message` is the model's text, and its `cause` is the original error with the API's detail.

Every adapter entry point re-exports `WebSearchError`, so `instanceof` checks do not need a second import.

If the harness cancels the call, the search is aborted and the abort propagates instead of becoming a failed result.

## Other sources

`createAIWebSearch` and `createHTTPWebSearch` from `agents/websearch` return a `WebSearchSource`: an object whose `search({ query, limit? }, { signal? })` returns the API response (`limit` defaults to 5), with no model involved. Use them from scheduled jobs, or outside Workers:

```ts
import { createHTTPWebSearch } from "agents/websearch";

const search = createHTTPWebSearch({
  accountId: env.CF_ACCOUNT_ID,
  apiToken: env.CF_API_TOKEN,
  provider: "linkup"
});
const { items } = await search.search({
  query: "cloudflare agents sdk",
  limit: 3
});
```

Any `WebSearchSource` can be passed to a tool as `source` instead of `binding`. That is how tests substitute a fake, and how you wrap a source with caching or logging. Spread the source you wrap so its `provider` is kept:

```ts
webSearchTool({
  source: {
    search: async ({ query }) => ({
      items: [{ url: "https://example.com", title: query }],
      metadata: { query, requestId: "test", latencyMs: 0 }
    })
  }
});
```
