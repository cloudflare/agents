# Fetch the Web (Beta)

`agents/webfetch` gives a model a `web_fetch` tool that reads one URL and returns the most useful text form of it: Markdown for HTML pages, PDFs, and Office documents, pretty-printed JSON, or plain text as served. Long content is windowed, so the model reads a page in parts. The same tool is available for the pi harness, the AI SDK, and TanStack AI.

The host decides which URLs can be fetched, how much is read, and how long a fetch may take. The model only chooses the URL, where to continue reading, and whether to get the body converted or raw.

> **Beta** — this feature may have breaking changes in future releases.

## Quick Start

You need an `AI` binding in `wrangler.jsonc`. The tool fetches pages with the Worker's own `fetch` and uses `env.AI.toMarkdown()` from [Workers AI Markdown Conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/) to turn HTML and documents into Markdown. There is no API token to set up.

```jsonc
{
  // No local implementation: under `wrangler dev` or `vite dev`, conversions
  // run against the account you are logged in to.
  "ai": { "binding": "AI", "remote": true }
}
```

Pages that are already Markdown, JSON, or plain text never reach the binding. The tool asks for `text/markdown` first, so sites with [Markdown for Agents](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/) enabled answer in Markdown and skip conversion.

Then add the tool to your harness. Every adapter takes the same options; the TanStack AI adapter also takes `name`, because TanStack AI tools carry their name in the definition.

Pi harness:

```ts
import { webFetchTool } from "agents/webfetch/pi";

this.registry.install({
  name: "tools",
  tools: [webFetchTool({ binding: this.env.AI })]
});
```

AI SDK:

```ts
import { webFetchTool } from "agents/webfetch/ai-sdk";

const result = streamText({
  model,
  tools: { web_fetch: webFetchTool({ binding: this.env.AI }) },
  messages
});
```

If you convert UI messages yourself, pass the same tools to `convertToModelMessages(messages, { tools })`. Without them, the AI SDK sends earlier fetches back to the model as the JSON output: the same window, but without the header line or the `<untrusted_web_content>` wrapper. `AiSdkHarness` does this for you.

TanStack AI:

```ts
import { webFetchTool } from "agents/webfetch/tanstack-ai";

const tools = [webFetchTool({ binding: this.env.AI })];
```

## Options

An invalid value throws a `RangeError` when the tool is created.

| Option              | Default                 | Notes                                                                                                                                         |
| ------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `binding`           | —                       | The `AI` binding, for converting HTML and documents. Or pass `source` instead (see [Other sources](#other-sources)).                          |
| `pageChars`         | `20000`                 | Characters the model reads per call. It continues with `offset`.                                                                              |
| `maxBytes`          | `5000000`               | Stop reading a response body past this many bytes, as a `web_fetch_too_large` failure. Bodies are streamed, so a large one is never buffered. |
| `timeoutMs`         | `30000`                 | Give up on a fetch after this long, redirects and conversion included, as a retryable `web_fetch_timeout` failure.                            |
| `maxRedirects`      | `5`                     | Redirects to follow, from 0 to 20.                                                                                                            |
| `allowedHosts`      | any public host         | Host patterns URLs must match: `example.com`, `*.example.com` (subdomains, not the apex), or `*`.                                             |
| `blockedHosts`      | —                       | Host patterns never fetched, in the same syntax. Checked first.                                                                               |
| `allowPrivateHosts` | `false`                 | Allow loopback, private, and local-only hosts. For local development against `localhost`; see [URL policy](#url-policy).                      |
| `userAgent`         | `Cloudflare-Agents (…)` | The `User-Agent` header.                                                                                                                      |
| `description`       | built-in description    | Replaces the tool description the model sees.                                                                                                 |

With `source`, only `pageChars`, `timeoutMs`, and `description` apply: the URL policy and limits belong to the source.

## Model Interface

The model sends:

| Field    | Notes                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| `url`    | The http(s) URL to read, at most 2,000 characters.                                                                   |
| `offset` | Character offset to continue a long page from, as the previous result says. Default `0`.                             |
| `format` | `"auto"` (default) converts to the most readable form; `"raw"` returns a textual body exactly as the server sent it. |

The model gets text: a header line, then one window of the content inside `<untrusted_web_content>`:

```
web_fetch: https://developers.cloudflare.com/agents/ · 200 · text/html → markdown · chars 0–19873 of 81200 · continue with offset=19873
<untrusted_web_content>
# Agents
…
</untrusted_web_content>
```

The header line names the final URL after redirects, the status, the content type and how it was read, and where the window sits. A window ends on a line break when one is close to its end, so `offset` values are rarely round numbers; the model continues from the offset the header gives. When the window reaches the end, the header has no `continue with`. An error status reads `404 Not Found` rather than `404`, so the model cannot miss it.

The wrapper and the tool description tell the model to treat the content as data, not instructions. A page cannot close the wrapper early: a closing tag inside the content is escaped.

`renderWebFetchPage(output)` from `agents/webfetch` is the renderer, if you want the same text elsewhere. It formats a stored output as is, so re-rendering an old result gives the text the model read.

## Host Output

The host gets `WebFetchToolOutput`: the window the model read and the page's metadata. The rest of the content is not stored, so a long page does not bloat the conversation history:

| Field                   | Notes                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `url`, `finalUrl`       | The URL as requested, and after redirects.                                                                     |
| `status`                | The final response's HTTP status.                                                                              |
| `contentType`           | The media type, lowercased, without parameters.                                                                |
| `via`                   | How the content was produced; see [Conversion](#conversion).                                                   |
| `content`, `totalChars` | The window of converted content the model read, and the whole page's length.                                   |
| `offset`, `nextOffset`  | The window the model read, and where the next one starts (`null` at the end).                                  |
| `title`                 | The page title, from `<title>` for HTML or the first `# ` heading for Markdown, when there is one.             |
| `headers`               | `content-type`, `content-length`, `last-modified`, `etag`, `x-markdown-tokens`, and `cf-mitigated`, when sent. |
| `bytes`                 | Body bytes read.                                                                                               |
| `redirects`             | The URLs that redirected, in order; `finalUrl` is not included.                                                |

Where it arrives depends on the harness:

- **Pi**: in the tool result's `details`, as `{ ok: true, output }`. The tool is `replay: "safe"`: if a fetch is interrupted mid-call, for example by an eviction, pi runs it again when the session recovers. Completed results are stored and not fetched again.
- **AI SDK**: as the return value of `execute`, so `onFinish`, UI message parts, and logs see it. `toModelOutput` renders it for the model.
- **TanStack AI**: the server tool returns the rendered window, so the host gets the same text the model does.

Each call fetches the page again; there is no cache between calls, so reading a long page in five windows fetches it five times.

## Conversion

With `format: "auto"`, the content type decides what the model reads:

| Content type                                                                                                         | Handling                                               | `via`                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------- |
| `text/markdown`                                                                                                      | Passed through                                         | `markdown-negotiated` |
| `text/html`, `application/xhtml+xml`                                                                                 | Converted with `env.AI.toMarkdown()`                   | `converted`           |
| `application/pdf`, Word (`.docx`), Excel (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`), OpenDocument (`.odt`, `.ods`), Numbers | Converted with `env.AI.toMarkdown()`                   | `converted`           |
| `application/json`, `*+json`                                                                                         | Pretty-printed; invalid JSON is passed through as text | `json`                |
| Other `text/*`, `application/xml`, `*+xml`, JavaScript, YAML, TOML, NDJSON, SQL, GraphQL, shell                      | Passed through                                         | `text`                |
| Images, audio, video, fonts, archives, binary `application/octet-stream`, anything else                              | Rejected as `web_fetch_unsupported_content_type`       | —                     |

Bodies are decoded with the charset from a byte-order mark, the `Content-Type` header, or an HTML `<meta charset>`, falling back to UTF-8. A response without a `Content-Type`, or sent as `application/octet-stream` (common for `.md`, `.yaml`, and source files), is sniffed as HTML, PDF, binary, or plain text.

With `format: "raw"`, textual bodies, HTML included, are returned exactly as served with `via: "raw"`. Documents and binary bodies are rejected, because their raw bytes are not text.

A 4xx or 5xx response with a readable body is returned like any page, with its status in the header line: error pages often explain what went wrong. Only an empty or non-textual error body becomes a `web_fetch_http_error` failure. A bot-management challenge page (sent with `cf-mitigated: challenge`) is reported as `web_fetch_blocked` rather than returned as content, because a plain fetch cannot pass it; the model is told to use a browser tool or another source.

## URL Policy

Every URL is checked before it is fetched, and every redirect target is checked again before it is followed. A redirect from `https:` down to `http:` is refused. Requests are GET only, with no cookies, credentials, or host-supplied headers.

Always rejected:

- Schemes other than `http:` and `https:`.
- URLs with a username or password.
- URLs longer than 2,000 characters.

Rejected unless `allowPrivateHosts` is `true`:

- Loopback, private, CGNAT, link-local (including cloud metadata at `169.254.169.254`), multicast, and reserved addresses, in IPv4 or IPv6, including IPv4-mapped, NAT64, and 6to4 forms. The list is a subset of the IANA special-purpose address registries ([RFC 6890](https://www.rfc-editor.org/rfc/rfc6890)).
- `localhost` and names ending in `.localhost` or `.internal`.

Hosts are checked after the URL parser has canonicalised them, so a private address cannot hide behind an unusual spelling such as `2130706433`, `0x7f.1`, `0177.0.0.1`, or `[::ffff:127.0.0.1]`. Names are not resolved: a public name that points at a private address, such as `127.0.0.1.nip.io`, passes the policy. In production, Workers egress cannot reach private ranges anyway; the policy is for local development, other runtimes, and defence in depth. The fragment is dropped from every URL.

`blockedHosts` is checked first, then `allowedHosts`, then the private-host rule. To keep the model on your documentation:

```ts
webFetchTool({
  binding: this.env.AI,
  allowedHosts: ["developers.cloudflare.com", "*.cloudflare.com"]
});
```

No DNS lookup is done: a public name that resolves to a private address is the runtime's to refuse. Deployed Workers cannot reach private networks. Under `wrangler dev` they can, which is why the private-host rule exists, and why `allowPrivateHosts` is the switch for testing against a server on `localhost`:

```ts
webFetchTool({
  binding: this.env.AI,
  // Local development only: lets the model reach http://localhost:8787.
  allowPrivateHosts: true
});
```

## Failures

A failed fetch becomes a `WebFetchError` with `status`, `code`, `retryable`, and, where there is one, `url`, `contentType`, and (for a timeout) `timeoutMs`. Every error has a `code`:

| Code                                 | Retryable              | When                                                                     |
| ------------------------------------ | ---------------------- | ------------------------------------------------------------------------ |
| `invalid_web_fetch_input`            | No                     | The URL, `offset`, or `format` is malformed, or the URL is too long.     |
| `web_fetch_disallowed_url`           | No                     | The URL's scheme, credentials, or host is not allowed by the URL policy. |
| `web_fetch_disallowed_redirect`      | No                     | A redirect pointed at a URL the policy does not allow, or https to http. |
| `web_fetch_too_many_redirects`       | No                     | More than `maxRedirects` redirects, or a redirect loop.                  |
| `web_fetch_timeout`                  | Yes                    | The fetch took longer than `timeoutMs`.                                  |
| `web_fetch_too_large`                | No                     | The body is larger than `maxBytes`.                                      |
| `web_fetch_unsupported_content_type` | No                     | The body is binary, or a document requested with `format: "raw"`.        |
| `web_fetch_http_error`               | 5xx, 408, and 429 only | A 4xx or 5xx response with an empty or non-textual body.                 |
| `web_fetch_blocked`                  | No                     | The site answered with a bot challenge (`cf-mitigated: challenge`).      |
| `web_fetch_conversion_failed`        | Yes                    | Workers AI could not convert the body to Markdown.                       |
| `web_fetch_unavailable`              | Yes                    | The network failed: DNS, TLS, the connection, or reading the body.       |

The error's `message` is written for you. The model gets different text that tells it what to do next: fix the input, retry once, retry with `format: "raw"` after a failed HTML conversion (a document that fails to convert is not retried), or move on.

- **Pi**: the tool returns an error result with the model's text, and `details` is `{ ok: false, message, status, code, retryable, url?, contentType? }`.
- **AI SDK** and **TanStack AI**: the tool throws a `WebFetchError`, which is how those frameworks report tool errors. Its `message` is the model's text, and its `cause` is the original error with the detail.

Every adapter entry point re-exports `WebFetchError`, so `instanceof` checks do not need a second import.

If the harness cancels the call, the fetch is aborted and the abort propagates instead of becoming a failed result.

## With Web Search

`web_fetch` pairs with [`web_search`](./search-the-web.md): search finds pages, fetch reads them. Each tool's description names the other, so a model with both searches, then fetches the results it wants to read.

```ts
import { webFetchTool } from "agents/webfetch/ai-sdk";
import { webSearchTool } from "agents/websearch/ai-sdk";

const tools = {
  web_search: webSearchTool({ binding: this.env.AI }),
  web_fetch: webFetchTool({ binding: this.env.AI })
};
```

## What It Is Not

- **Not an HTTP client.** There is no POST, no request body, and no custom headers, cookies, or credentials. For calls to your own APIs, write a tool for them.
- **Not a browser.** Pages are not rendered, so content that only appears after JavaScript runs is missing. For rendered pages, screenshots, or interaction, see [Browse the Web](./browse-the-web.md).
- **Not a summariser.** The model reads the page itself, a window at a time.

## Other Sources

`fetchWeb` from `agents/webfetch` fetches one URL with no model involved: the same pipeline, URL policy, limits, and `timeoutMs`. It returns the whole page as a `WebFetchPage`: the fields of `WebFetchToolOutput` with all of `content`, and no `offset` or `nextOffset`. Use it from scheduled jobs, callables, or tests:

```ts
import { WebFetchError, fetchWeb } from "agents/webfetch";

try {
  const page = await fetchWeb(
    { url: "https://developers.cloudflare.com/agents/" },
    { binding: this.env.AI, maxBytes: 1_000_000 }
  );
  console.log(page.title, page.via, page.totalChars);
} catch (error) {
  if (error instanceof WebFetchError) console.log(error.code, error.retryable);
}
```

To show a page a window at a time without a model, for example in a UI that pages through what the model would read, cut it with `windowWebFetchPage` and render each window with `renderWebFetchPage`. This is exactly what the tool does, and it does not fetch again:

```ts
import { renderWebFetchPage, windowWebFetchPage } from "agents/webfetch";

const first = windowWebFetchPage(page, { offset: 0, pageChars: 20_000 });
console.log(renderWebFetchPage(first));
// Next window: windowWebFetchPage(page, { offset: first.nextOffset, … }),
// until nextOffset is null.
```

`createDirectWebFetch` from `agents/webfetch` returns a `WebFetchSource`: an object whose `fetch({ url, format? }, { signal? })` returns a `WebFetchPage`. A source validates `url` and `format` itself (the tool checks only `offset`), throwing `invalid_web_fetch_input` for a malformed request. Any `WebFetchSource` can be passed to a tool as `source` instead of `binding`. That is how tests substitute a fake, and how you wrap a source with caching or logging:

```ts
import { createDirectWebFetch } from "agents/webfetch";
import { webFetchTool } from "agents/webfetch/ai-sdk";

const direct = createDirectWebFetch({ binding: this.env.AI });

webFetchTool({
  source: {
    async fetch(request, options) {
      const page = await direct.fetch(request, options);
      console.log(request.url, page.status, page.bytes);
      return page;
    }
  }
});
```
