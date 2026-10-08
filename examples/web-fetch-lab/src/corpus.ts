import type { WebFetchFormat, WebFetchVia } from "agents/webfetch";
import type { CorpusActual } from "./shared";

/**
 * What a corpus entry expects. Every field is optional; only the ones set
 * are checked. An entry with `errorCode` expects the fetch to fail with that
 * code; any other entry expects it to succeed.
 */
export interface CorpusExpectation {
  status?: number;
  via?: WebFetchVia;
  /** The content is at least this many characters. */
  minChars?: number;
  /** The content is at most this many characters (JS-only pages). */
  maxChars?: number;
  /** The fetch fails with this `WebFetchError` code. */
  errorCode?: string;
  /** The final URL, after redirects, contains this. */
  finalUrlIncludes?: string;
  /** At least this many redirects were followed. */
  minRedirects?: number;
  /** The content contains this (charset decoding, raw format). */
  contentIncludes?: string;
  /** These kept response headers have these values. */
  headers?: Record<string, string>;
}

export interface CorpusEntry {
  id: string;
  url: string;
  format?: WebFetchFormat;
  expect: CorpusExpectation;
  /**
   * How sure we are the expectation holds from a Worker on the live web.
   * `low` means the site may block, challenge, or change; a failure there
   * is information, not necessarily a bug.
   */
  confidence: "high" | "medium" | "low";
  note: string;
}

/**
 * URLs that exercise every branch of `web_fetch`: Markdown for Agents,
 * HTML conversion, JSON, text, documents, redirects, errors, size limits,
 * and the URL policy. Expectations were checked with curl from a laptop on
 * 2026-10-07; a Worker's egress can see different answers (bot protection,
 * geo redirects), so read failures with the `confidence` in mind.
 *
 * Add an entry: give it a unique `id`, the `url`, only the expectations you
 * are sure of, and a note saying what it tests.
 */
export const CORPUS: CorpusEntry[] = [
  // ── Markdown for Agents ───────────────────────────────────────────
  {
    id: "cf-docs",
    url: "https://developers.cloudflare.com/agents/",
    expect: { status: 200, via: "markdown-negotiated", minChars: 500 },
    confidence: "high",
    note: "Markdown for Agents zone: answers Accept: text/markdown directly, no conversion."
  },
  {
    id: "cf-blog",
    url: "https://blog.cloudflare.com/markdown-for-agents/",
    expect: { status: 200, via: "markdown-negotiated", minChars: 2000 },
    confidence: "high",
    note: "The blog post announcing Markdown for Agents, served as Markdown."
  },

  // ── HTML → Markdown (Workers AI toMarkdown) ───────────────────────
  {
    id: "example",
    url: "https://example.com/",
    expect: { status: 200, via: "converted", minChars: 50 },
    confidence: "high",
    note: "The smallest real HTML page."
  },
  {
    id: "wikipedia",
    url: "https://en.wikipedia.org/wiki/Cloudflare",
    expect: { status: 200, via: "converted", minChars: 5000 },
    confidence: "high",
    note: "Long article; pages past the first window. Wikipedia wants a descriptive User-Agent, which the tool sends."
  },
  {
    id: "github-repo",
    url: "https://github.com/cloudflare/agents",
    expect: { status: 200, via: "converted", minChars: 1000 },
    confidence: "high",
    note: "GitHub repo page with the README rendered server-side."
  },
  {
    id: "mdn",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
    expect: { status: 200, via: "converted", minChars: 2000 },
    confidence: "high",
    note: "MDN reference page."
  },
  {
    id: "python-docs",
    url: "https://docs.python.org/3/library/json.html",
    expect: { status: 200, via: "converted", minChars: 5000 },
    confidence: "high",
    note: "Sphinx docs page."
  },
  {
    id: "bbc-news",
    url: "https://www.bbc.com/news",
    expect: { status: 200, via: "converted", minChars: 1000 },
    confidence: "medium",
    note: "News front page (~380 KB HTML). Article URLs rot, so this uses the section front. May geo-redirect."
  },
  {
    id: "hacker-news",
    url: "https://news.ycombinator.com/item?id=1",
    expect: {},
    confidence: "low",
    note: "Hacker News item 1: table-based HTML. From a laptop this is a 200 that converts fine; from Workers egress HN answers 419 'Sorry' (its own block on datacenter IPs), which comes back as a 6-char text page with status 419. No assertion: inspect the row."
  },
  {
    id: "npm",
    url: "https://www.npmjs.com/package/agents",
    expect: { errorCode: "web_fetch_blocked" },
    confidence: "medium",
    note: "npm package page. 200 from a laptop; from Workers egress npm answers a Cloudflare managed challenge (403, cf-mitigated: challenge), reported as web_fetch_blocked."
  },
  {
    id: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    expect: { status: 200, via: "converted" },
    confidence: "medium",
    note: "~1.3 MB of mostly script. Output is small relative to the HTML; EU egress may redirect to consent.youtube.com."
  },
  {
    id: "substack",
    url: "https://www.astralcodexten.com/p/still-alive",
    expect: { via: "converted", minChars: 2000 },
    confidence: "low",
    note: "Substack post on a custom domain. Substack rate-limits datacenter IPs: from Workers egress this is often a 429 'Too Many Requests' text page."
  },
  {
    id: "reddit",
    url: "https://www.reddit.com/r/CloudFlare/",
    expect: { via: "converted" },
    confidence: "low",
    note: "Reddit serves a small shell (or 403 'blocked') to non-browsers, especially datacenter IPs. Watch the char count."
  },
  {
    id: "spa",
    url: "https://excalidraw.com/",
    expect: { status: 200, via: "converted", maxChars: 3000 },
    confidence: "medium",
    note: "JS-only app: the HTML is a shell, so the Markdown is tiny. What V2 browser rendering would fix."
  },
  {
    id: "shift-jis",
    url: "https://www.aozora.gr.jp/cards/000148/files/773_14560.html",
    expect: { status: 200, via: "converted", contentIncludes: "こころ" },
    confidence: "medium",
    note: "Non-UTF-8: Shift_JIS declared only in <meta http-equiv> (no charset on the header). Garbled text means the meta sniff failed. ~600 KB."
  },

  // ── JSON ──────────────────────────────────────────────────────────
  {
    id: "github-api",
    url: "https://api.github.com/repos/cloudflare/agents",
    expect: { via: "json", minChars: 500 },
    confidence: "medium",
    note: "JSON, pretty-printed. Unauthenticated GitHub API is 60 req/h per IP; a shared egress IP may get a 403 JSON body (still via json)."
  },
  {
    id: "hn-api",
    url: "https://hacker-news.firebaseio.com/v0/item/8863.json",
    expect: { status: 200, via: "json", contentIncludes: '"by": "dhouston"' },
    confidence: "high",
    note: "Small JSON object; checks the two-space pretty-printing."
  },
  {
    id: "plus-json",
    url: "https://mastodon.social/.well-known/webfinger?resource=acct:Mastodon@mastodon.social",
    expect: { status: 200, via: "json" },
    confidence: "high",
    note: "application/jrd+json: a +json media type is treated as JSON."
  },

  // ── Text ──────────────────────────────────────────────────────────
  {
    id: "raw-github-ts",
    url: "https://raw.githubusercontent.com/cloudflare/agents/main/packages/agents/src/index.ts",
    expect: { status: 200, via: "text", minChars: 10_000 },
    confidence: "high",
    note: "A .ts file served as text/plain, passed through. Long: page through it."
  },
  {
    id: "robots",
    url: "https://www.google.com/robots.txt",
    expect: { status: 200, via: "text", contentIncludes: "User-agent" },
    confidence: "high",
    note: "Small text/plain file."
  },
  {
    id: "rfc-txt",
    url: "https://www.rfc-editor.org/rfc/rfc9110.txt",
    expect: { status: 200, via: "text", minChars: 400_000 },
    confidence: "high",
    note: "~500 KB of text/plain: many windows."
  },
  {
    id: "rss",
    url: "https://blog.cloudflare.com/rss/",
    expect: { status: 200, via: "text", minChars: 10_000 },
    confidence: "high",
    note: "application/rss+xml: +xml types are text, passed through."
  },
  {
    id: "raw-format",
    url: "https://example.com/",
    format: "raw",
    expect: { status: 200, via: "raw", contentIncludes: "<html" },
    confidence: "high",
    note: 'format: "raw" returns the HTML as served, unconverted.'
  },

  // ── Documents ─────────────────────────────────────────────────────
  {
    id: "arxiv-pdf",
    url: "https://arxiv.org/pdf/1706.03762",
    expect: { status: 200, via: "converted", minChars: 10_000 },
    confidence: "medium",
    note: "~2.2 MB PDF (Attention Is All You Need) through toMarkdown. Probes toMarkdown's size limit and latency."
  },
  {
    id: "docx",
    url: "https://calibre-ebook.com/downloads/demos/demo.docx",
    expect: { status: 200, via: "converted", minChars: 1000 },
    confidence: "medium",
    note: "~1.3 MB .docx with the proper Office media type, converted by toMarkdown."
  },
  {
    id: "docx-raw",
    url: "https://calibre-ebook.com/downloads/demos/demo.docx",
    format: "raw",
    expect: { errorCode: "web_fetch_unsupported_content_type" },
    confidence: "high",
    note: 'Documents can\'t be returned with format: "raw".'
  },

  // ── Redirects ─────────────────────────────────────────────────────
  {
    id: "http-to-https",
    url: "http://github.com/",
    expect: {
      status: 200,
      finalUrlIncludes: "https://github.com",
      minRedirects: 1
    },
    confidence: "high",
    note: "301 from http to https on the same host."
  },
  {
    id: "cross-host",
    url: "http://cloudflare.com/",
    expect: {
      status: 200,
      finalUrlIncludes: "www.cloudflare.com",
      minRedirects: 1
    },
    confidence: "high",
    note: "301 to https://www.cloudflare.com/: a different host, so request headers are dropped on the hop."
  },
  {
    id: "idn",
    url: "https://münchen.de/",
    expect: { status: 200, finalUrlIncludes: "muenchen.de", minRedirects: 1 },
    confidence: "medium",
    note: "IDN host, punycoded to xn--mnchen-3ya.de by the URL parser, which 301s to www.muenchen.de."
  },
  {
    id: "fragment",
    url: "https://en.wikipedia.org/wiki/HTTP#History",
    expect: { status: 200, via: "converted", finalUrlIncludes: "/wiki/HTTP" },
    confidence: "high",
    note: "The fragment is stripped before fetching: the final URL should have no #History."
  },
  {
    id: "too-many-redirects",
    url: "https://httpbin.org/redirect/6",
    expect: { errorCode: "web_fetch_too_many_redirects" },
    confidence: "medium",
    note: "Six hops, one more than the limit of 5. httpbin.org is sometimes slow or down."
  },
  {
    id: "redirect-to-private",
    url: "https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%2F",
    expect: { errorCode: "web_fetch_disallowed_redirect" },
    confidence: "medium",
    note: "A public URL that redirects to loopback: the policy runs again on every hop."
  },

  // ── HTTP errors and limits ────────────────────────────────────────
  {
    id: "github-404",
    url: "https://github.com/cloudflare/does-not-exist-xyz",
    expect: { status: 404, via: "converted", minChars: 100 },
    confidence: "high",
    note: "A 404 with an HTML body comes back as a page with status 404, not an error."
  },
  {
    id: "empty-500",
    url: "https://httpbin.org/status/500",
    expect: { errorCode: "web_fetch_http_error" },
    confidence: "medium",
    note: "A 500 with an empty body becomes web_fetch_http_error (retryable)."
  },
  {
    id: "challenge",
    url: "https://stackoverflow.com/questions/11227809",
    expect: { status: 403, errorCode: "web_fetch_blocked" },
    confidence: "medium",
    note: "Stack Overflow question behind a Cloudflare managed challenge ('Just a moment...', cf-mitigated: challenge). Reported as web_fetch_blocked rather than returning the challenge HTML."
  },
  {
    id: "challenge-js",
    url: "https://www.g2.com/",
    expect: { status: 403, via: "converted", contentIncludes: "enable JS" },
    confidence: "low",
    note: "Bot-protected site that answers 403 'Please enable JS' without cf-mitigated, so the body comes back as a page with status 403 in the header line."
  },
  {
    id: "too-large",
    url: "https://speed.cloudflare.com/__down?bytes=10000000",
    expect: { errorCode: "web_fetch_too_large" },
    confidence: "high",
    note: "10 MB, over the 5 MB cap. Content-Length is declared, so it fails before reading."
  },
  {
    id: "image",
    url: "https://httpbin.org/image/png",
    expect: { errorCode: "web_fetch_unsupported_content_type" },
    confidence: "medium",
    note: "image/png is binary: unsupported in V1."
  },

  // ── URL policy rejections (no request is made) ────────────────────
  {
    id: "data-url",
    url: "data:text/plain,hello",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "Only http and https."
  },
  {
    id: "file-url",
    url: "file:///etc/passwd",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "Only http and https."
  },
  {
    id: "localhost",
    url: "http://localhost:8787/",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "Loopback by name."
  },
  {
    id: "loopback-ip",
    url: "http://127.0.0.1/",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "Loopback IPv4."
  },
  {
    id: "metadata",
    url: "http://169.254.169.254/latest/meta-data",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "Link-local cloud metadata address."
  },
  {
    id: "metadata-name",
    url: "http://metadata.google.internal/",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "The .internal suffix is local-only."
  },
  {
    id: "private-ip",
    url: "http://10.0.0.1/",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "RFC 1918 private range."
  },
  {
    id: "ipv6-loopback",
    url: "http://[::1]/",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "IPv6 loopback."
  },
  {
    id: "hex-ip",
    url: "http://0x7f000001/",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "127.0.0.1 spelled in hex."
  },
  {
    id: "decimal-ip",
    url: "http://2130706433/",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "127.0.0.1 spelled as one decimal number."
  },
  {
    id: "userinfo",
    url: "https://user:pass@example.com/",
    expect: { errorCode: "web_fetch_disallowed_url" },
    confidence: "high",
    note: "URLs with credentials are refused."
  },
  {
    id: "too-long",
    url: `https://example.com/${"a".repeat(2_000)}`,
    expect: { errorCode: "invalid_web_fetch_input" },
    confidence: "high",
    note: "Over the 2,000-character URL limit."
  },
  {
    id: "not-a-url",
    url: "not a url",
    expect: { errorCode: "invalid_web_fetch_input" },
    confidence: "high",
    note: "Not an absolute URL."
  }
];

/** Compare what a run observed with what the entry expects. */
export function checkCorpusEntry(
  entry: CorpusEntry,
  actual: CorpusActual,
  content: string | undefined
): string[] {
  const { expect } = entry;
  const failures: string[] = [];
  if (expect.errorCode) {
    if (actual.errorCode !== expect.errorCode) {
      failures.push(
        `expected error ${expect.errorCode}, got ${actual.errorCode ?? `success (${actual.status})`}`
      );
    }
    return failures;
  }
  if (actual.errorCode) {
    return [`expected success, got ${actual.errorCode}`];
  }
  if (expect.status !== undefined && actual.status !== expect.status) {
    failures.push(`status ${actual.status}, expected ${expect.status}`);
  }
  if (expect.via && actual.via !== expect.via) {
    failures.push(`via ${actual.via}, expected ${expect.via}`);
  }
  const chars = actual.chars ?? 0;
  if (expect.minChars !== undefined && chars < expect.minChars) {
    failures.push(`${chars} chars, expected at least ${expect.minChars}`);
  }
  if (expect.maxChars !== undefined && chars > expect.maxChars) {
    failures.push(`${chars} chars, expected at most ${expect.maxChars}`);
  }
  if (
    expect.finalUrlIncludes &&
    !actual.finalUrl?.includes(expect.finalUrlIncludes)
  ) {
    failures.push(
      `final URL ${actual.finalUrl}, expected it to include ${expect.finalUrlIncludes}`
    );
  }
  const redirects = actual.redirects?.length ?? 0;
  if (expect.minRedirects !== undefined && redirects < expect.minRedirects) {
    failures.push(
      `${redirects} redirects, expected at least ${expect.minRedirects}`
    );
  }
  if (expect.contentIncludes && !content?.includes(expect.contentIncludes)) {
    failures.push(`content doesn't include ${expect.contentIncludes}`);
  }
  for (const [name, value] of Object.entries(expect.headers ?? {})) {
    const got = actual.headers?.[name];
    if (got !== value) {
      failures.push(`header ${name}: ${got ?? "missing"}, expected ${value}`);
    }
  }
  return failures;
}
