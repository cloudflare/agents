# 16 — Fetch tool: allowlisted, read-only HTTP

Original: `think/tools/fetch.ts` (1.1k lines). Off by default; gives the model
a conservative GET-only tool. High test value (pure policy logic).

## Config

```ts
export interface FetchToolConfig {
  allowlist?: string[];                  // URL patterns for the generic fetch_url tool
  bindings?: Record<string, {            // one fetch_<name> tool per binding
    fetch: FetchLike;                     // service binding abstraction
    allowlist: string[];                  // path-based patterns ("/v1/docs/**")
    headers?: Record<string, string>;     // fixed server-side headers
  }>;
  maxBytes?: number;                      // download cap (default 1_000_000)
  maxModelChars?: number;                 // model-facing text cap (default 8_000)
  timeoutMs?: number;                     // default 10_000
  followRedirects?: boolean;              // default true (public tool)
  modelHeaderAllowlist?: string[];        // default ["accept","accept-language","range"]
  defaultAccept?: string;                 // weighted markdown-first Accept (below); "" disables
  response?: "auto" | "workspace";        // spill large/binary bodies to workspace
}
```
Default Accept: `text/markdown;q=1.0, text/plain;q=0.9, application/json;q=0.8, text/html;q=0.7, */*;q=0.1`.

## Allowlist semantics (exact spec — implement with globToRegExp from doc 15)
- Compare scheme + host + port + path only; query/fragment ignored for
  matching but still sent.
- Bare origin (`https://example.com`) → that origin + every subpath.
- Explicit path without glob matches literally (`https://x.com/v1` matches
  only `/v1`, not `/v1/a`).
- `**` any chars incl `/`; `*` any chars except `/`.
- Binding allowlists are path-based; a model-supplied absolute URL to a
  binding tool must match the binding's allowlist.

## Safety rails (always on, even when the allowlist is misconfigured)
- GET only.
- Block private/loopback/link-local/`.internal` hosts: `localhost`,
  `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
  `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, `*.internal`, `0.0.0.0`.
  (Literal-IP parsing; hostname DNS resolution is out of scope.)
- Model may set only allowlisted headers; binding fixed headers are never
  shown to the model and are **stripped on cross-origin redirects**.
- Redirects: followed manually up to 5 hops, each hop re-checked against the
  allowlist (`disallowed_redirect` on failure); binding tools never follow
  cross-origin redirects.

## Results (structured values, never throws)
Success: `{ ok: true, status, finalUrl, contentType, bytes, truncated, body? , json?, path? }`
— text bodies → `body` (truncated at maxModelChars); JSON content-type →
parsed `json` (bounded by maxBytes, `invalid_json` on parse failure); with
`response: "workspace"` (or auto-spill for binary/oversized) → write to
workspace `fetch/<host>/<hash>.<ext>` and return `path`.
Failure: `{ ok: false, code, message }` with code ∈ `disallowed_url |
disallowed_redirect | timeout | non_2xx | unsupported_content_type |
invalid_json | too_large | request_failed`.

Every call (including blocked) emits `tool:fetch`
`{ url, ok, code?, status?, bytes? }`.

## Proposed interface
```ts
export function matchesAllowlist(url: string, patterns: string[]): boolean;
export function isForbiddenHost(url: string): boolean;
export function createFetchTools(config: FetchToolConfig, deps: {
  fetch: FetchLike;                      // for fetch_url
  workspace?: Workspace; bus?: EventBus; clock: Clock;
}): ToolSet;                             // fetch_url? + fetch_<name>*
```
Tool input: `{ url, accept?, headers?, response? }` (binding tools accept
path-or-URL as `url`).

## Tests (TDD list — the fake FetchLike drives everything)
- allowlist matrix: bare origin, literal path, `*` vs `**`, query ignored.
- forbidden hosts blocked even when allowlisted (each family).
- redirect: allowed hop followed; disallowed hop → disallowed_redirect;
  >5 hops; binding cross-origin redirect refused + fixed headers stripped
  check on same-origin vs cross-origin.
- header policy: model header not in allowlist dropped; binding fixed headers
  applied.
- size: body > maxBytes → too_large (or spill when workspace mode); text
  truncation flag; json parse + bound.
- timeout via fake timers → timeout code; non-2xx code with status.
- events emitted for success and blocked calls.
