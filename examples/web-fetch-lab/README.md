# Web Fetch Lab

A workbench for the `web_fetch` tool from `agents/webfetch`. It has three tabs:

- **Chat**: an `AIChatAgent` with `web_search` and `web_fetch`. It searches, reads the pages it finds, and cites them. Open a tool row to see exactly what the model read.
- **URL Lab**: paste a URL and fetch it with no model involved. See the status, redirect chain, content type, how the body was converted (`via`), bytes in, characters out, timing, the response headers the tool keeps, the exact text the model would read (with Prev/Next paging), and the raw output. Failures show their error code, message, and whether they're retryable.
- **Corpus**: about 50 URLs in `src/corpus.ts`, each with what we expect the tool to do. Run them all (or one at a time) and get a pass/fail table with timings.

## What it demonstrates

**Server (`src/server.ts`):**

- `webFetchTool()` from `agents/webfetch/ai-sdk` next to `webSearchTool()`, on one `AI` binding
- Host-side settings (page size, default format, private hosts) kept in the agent's state, changed from the UI with `setState` and checked in `validateStateChange`
- Applying a default `format` by wrapping the tool's `execute`
- `fetchWeb()` from `agents/webfetch` in a `@callable` method, for fetching without a model
- A streaming `@callable` (`runCorpus`) that fetches one URL at a time and streams each result back as it finishes

**Client (`src/client.tsx`, `src/url-lab.tsx`, `src/corpus-tab.tsx`):**

- Typed `tool-web_search` and `tool-web_fetch` parts via `useAgentChat<unknown, LabMessage>()`
- `renderWebFetchPage()` to show the text the model reads, and to page through a fetched page locally
- `agent.call()` with `onChunk`/`onDone` for the streaming corpus run

## Running

```bash
pnpm install
pnpm start
```

The `AI` binding has no local implementation, so `pnpm start` runs it remotely against the account you're logged in to with `wrangler login`. The model, `web_search`, and HTML/PDF/Office → Markdown conversion (`env.AI.toMarkdown`) all go through it. If you belong to more than one account, set `CLOUDFLARE_ACCOUNT_ID`.

The URL Lab and the corpus only use `toMarkdown`, which is available on every account. The chat also needs `web_search`, which is billed to your account's default AI Gateway (see the [web-research example](../web-research/README.md)); without credits, searches fail and the model can still fetch URLs you give it.

The model is `@cf/moonshotai/kimi-k2.7-code` on Workers AI (`MODEL` in `src/shared.ts`).

## Driving it from the command line

The URL Lab and the corpus runner are also plain HTTP routes on the agent, so you can script them:

```sh
BASE=http://localhost:5173/agents/web-fetch-lab-agent/lab
curl "$BASE/api/fetch?url=https://developers.cloudflare.com/workers/&format=auto&offset=0"
curl -N "$BASE/api/corpus"            # NDJSON: one result per line, then the summary
curl -N "$BASE/api/corpus?ids=cf-docs,arxiv-pdf"
```

## The live web

Everything here hits real sites. Pages change, sites rate-limit or challenge bots, and a Worker's egress can get different answers than your laptop (bot protection, geo redirects, shared-IP rate limits on `api.github.com`). Each corpus entry has a `confidence` (high, medium, low): a failing `low` entry is information about the web, not necessarily a bug in the tool.

The **Allow private hosts** setting lets `web_fetch` reach `localhost` and private IPs. In `vite dev`, the Worker runs locally, so this reaches your machine; deployed, it can't. The corpus always runs with the defaults (private hosts refused).

## Adding corpus entries

Add an object to `CORPUS` in `src/corpus.ts`:

```ts
{
  id: "my-page",                 // unique, shown in the table
  url: "https://example.com/",
  format: "raw",                 // optional; defaults to "auto"
  expect: {                      // only what you're sure of
    status: 200,
    via: "converted",            // markdown-negotiated | converted | json | text | raw
    minChars: 100,
    // maxChars, finalUrlIncludes, minRedirects, contentIncludes, headers,
    // or errorCode: "web_fetch_too_large" to expect a failure
  },
  confidence: "medium",
  note: "What this tests, and anything that might make it flaky."
}
```

An entry with `errorCode` expects the fetch to fail with that code; every other entry expects it to succeed. `checkCorpusEntry()` in the same file does the comparison.
