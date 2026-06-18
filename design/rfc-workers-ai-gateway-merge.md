# RFC: Merge `ai-gateway-provider` into `workers-ai-provider`

Status: accepted — implemented in [cloudflare/ai#573](https://github.com/cloudflare/ai/pull/573) (single `createWorkersAI` entry; run + gateway transports; resume; client/server fallback; BYOK; metadata; full provider registry; live e2e). Remaining open questions are follow-ups, not blockers.

> Scope note: the code changes live in the [`cloudflare/ai`](https://github.com/cloudflare/ai)
> repo (`packages/workers-ai-provider`, `packages/ai-gateway-provider`). This RFC
> lives here because the motivation — resumable LLM streams in Think — is an
> agents-repo concern, and the empirical groundwork is the
> [`experimental/gateway-resume`](../experimental/gateway-resume/README.md) harness.

## The problem

We want one Cloudflare AI SDK provider that:

1. Serves Workers AI's own models (`@cf/*`) natively, as today.
2. Serves the **dash-catalog third-party models** (`openai/*`, `anthropic/*`,
   `google/*`, …) that Workers AI now fronts under **unified billing**
   ([AI Platform blog](https://blog.cloudflare.com/ai-platform/)), with **correct
   normalization** — tool calls, reasoning, finish reasons, usage.
3. Captures `cf-aig-run-id` so we can build **resumable streaming** (replay a
   dropped stream from an SSE event offset) into Think via `onChatRecovery` /
   `runFiber`.

Three findings from the `gateway-resume` harness force the design:

- **The universal run path returns each provider's _native_ SSE.**
  `env.AI.run("openai/gpt-5.4")` streams OpenAI `chat.completion.chunk`;
  `anthropic/*` streams native Anthropic SSE (`event: message_start` …). There is
  no single normalized wire format on this path, so a hand-rolled parser per
  provider is the wrong investment.
- **Resumable streaming is live for catalog models on the run API** (every
  catalog model tested returned `cf-aig-run-id`; `resume(from=N)` replays the
  exact tail, where `from` is an **SSE event index**, not a byte offset). It is
  **not yet** available for `@cf/*` models.
- **The two transports have _disjoint_ capabilities (verified 2026-06-14).**
  The run path (`env.AI.run(slug, inputs)`) returns `cf-aig-run-id` (resume) but
  **no** `cf-aig-step`/cache-status/log-id. The gateway-binding path
  (`env.AI.gateway(id).run([…])`) returns `cf-aig-step` (server-side fallback),
  `cf-aig-cache-status`, and `cf-aig-log-id` but **no** `cf-aig-run-id`. **You
  cannot get resume _and_ server-side fallback/caching in one call today.** This
  is a Cloudflare product gap (the gateway path already has `cf-aig-log-id`, so
  the buffer exists — run-id just isn't surfaced there). File it.

Meanwhile the two providers are architecturally opposite:

|                        | `workers-ai-provider`                          | `ai-gateway-provider` (PR #409)                              |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Shape                  | Native `LanguageModelV3`                       | Decorator over another provider                              |
| Wire protocol          | `binding.run(model, inputs)` (Workers AI)      | Captures inner provider's `fetch`, re-routes through gateway |
| Parsing                | Its own (`streaming.ts`, finish/usage mappers) | **Delegates to the wrapped `@ai-sdk/*` provider**            |
| `cf-aig-run-id`        | Never captured (no `returnRawResponse`)        | Response is raw; capturable                                  |
| Unified billing / BYOK | n/a                                            | Strips provider auth headers                                 |

The decorator approach (PR #409) is exactly right for catalog models: by feeding
the gateway response back into the real provider's own `fetch`
(`feedResponseToModel`), it **inherits every provider's normalization for free**.
This is the same "compose the real provider with a custom fetch" pattern as
`experimental/forever-chat/replay-model.ts` and `tanstack-ai`'s
`utils/create-fetcher.ts`.

## The proposal

**One `createWorkersAI` that routes `@cf/*` natively and catalog models through a
`@ai-sdk/*`-delegating engine built inside `workers-ai-provider`. The engine
supports _both_ transports — the run path (resume) and the gateway path
(server-side fallback, caching, full `cf-aig-*` surface) — and picks between them
from a capability matrix based on the options requested, erroring loudly on
impossible combinations and warning when a gateway feature disables resume.** As
Cloudflare adds feature parity to the run path, rows move in the matrix and
conflicts shrink — no code-path change. Providers are supplied through thin
first-party wrapper sub-paths.

### 1. Delegate engine: both dispatch modes (don't wait on #409)

[PR #409](https://github.com/cloudflare/ai/pull/409) is **not expected to land
soon**, so it is a **reference, not a dependency**. We build the delegate inside
`workers-ai-provider`, shipped as the sub-path
`workers-ai-provider/gateway-delegate`. Dependency direction is deliberately
inverted: `workers-ai-provider` owns it; `ai-gateway-provider` can import the
sub-path later (gateway-provider → workers-ai-provider is the acceptable
direction). Self-contained (no `ai-gateway-provider` import).

The engine has two dispatch modes; transport selection (§2) picks one. Both end
the same way — feed the raw `Response` back into the `@ai-sdk/*` model so the
provider parses it, and lift `cf-aig-*` headers off the response:

- **Run-path dispatch (construction-time fetch).** Build the model **with** our
  `fetch` (`createOpenAI({ fetch, apiKey: "unused" })`); the fetch calls
  `env.AI.run(slug, body, { returnRawResponse: true })`. One pass, no capture —
  the slug is known, so no URL→provider mapping is needed. Resume-bearing.
- **Gateway-path dispatch (capture/redispatch, #409's mechanism).** Hijack
  `config.fetch`, let `doStream` build the request, capture `{url, headers,
body}` (sentinel-throw to stop before the network), reshape into
  `{ provider, endpoint, headers, query }`, dispatch **one**
  `env.AI.gateway(id).run([…])` (array of N for server-side fallback), then feed
  back. Carries the full `cf-aig-*` surface + `cf-aig-step`, but **no resume**.

### 2. Transport selection: capability-driven

A capability matrix is the single source of truth for which transport supports
each option. The provider computes the set of transports that satisfy **all**
requested options (intersection); selection rules:

- **Empty intersection → throw** a clear error naming the conflicting options and
  the transport each needs (e.g. "`fallback: 'server'` needs the gateway path,
  which can't provide `resume`; set `resume: false` or use `fallback: 'client'`").
- **Resume is on by default.** Requesting a gateway-only option **without**
  explicitly setting `resume: false` → pick the gateway path and **warn loudly**
  that resume is disabled for this model.
- **Otherwise** prefer the run path (so resume stays available).
- A `transport: "auto" | "run" | "gateway"` escape hatch forces a choice (and
  still errors if the forced transport can't satisfy a requested option).

Capability matrix (verified 2026-06-14; **update as parity lands**):

| Option / feature                      | Run path    | Gateway path |
| ------------------------------------- | ----------- | ------------ |
| `resume` (default on)                 | ✅          | ❌           |
| `fallback: "server"` (`cf-aig-step`)  | ❌          | ✅           |
| `cacheTtl` / `skipCache` / `cacheKey` | ❌          | ✅           |
| `collectLog` (`cf-aig-log-id`)        | ❌          | ✅           |
| `retries` / `requestTimeoutMs`        | ❌ (verify) | ✅           |
| `zdr` / `byokAlias`                   | ❌ (verify) | ✅           |
| `metadata` / `eventId`                | ✅ (header) | ✅           |
| `byok` / unified billing              | ✅          | ✅           |
| `fallback: "client"`                  | ✅          | n/a (§4)     |

**Primary risk — request-side passthrough (run path): RESOLVED ✅.** The harness
now feeds the _exact_ body a real `@ai-sdk/*` provider emits through
`env.AI.run(slug, body, { returnRawResponse })` and lets the same provider parse
the response (`experimental/gateway-resume/src/passthrough.ts`, `/passthrough`).
Verified live on this account:

- **`@ai-sdk/openai` (`.chat`) → `openai/gpt-5.4`** — text streams cleanly (164
  deltas, clean `start`/`text`/`finish` lifecycle), usage normalized including
  `raw`. **Tools** parse end-to-end (`tool-input-delta` → `tool-call` →
  `tool-result` → second step text), multi-step via `stopWhen`.
- **`@ai-sdk/anthropic` → `anthropic/claude-opus-4.7`** — parses cleanly,
  anthropic-native usage (`cache_creation`, `service_tier`, `inference_geo`)
  normalized. A 200 here also settles **Risk #2** (`anthropic-version` survives
  the run path) — the API would reject the request otherwise.
- **`cf-aig-run-id` (Risk #3)** — surfaced identically via our fetch _and_
  `result.response.headers["cf-aig-run-id"]` on every call, so the delegate can
  capture it from the parsed result without a side channel.
- Dropping the redundant `model` field works (slug supplies it), and keeping it
  is also tolerated — so the delegate's body rewrite is optional, not required.

This means the harness's `max_tokens`/`max_completion_tokens` headaches vanish:
each `@ai-sdk/*` provider emits its own correct params. The gateway-path
round-trip is already proven by #409's 124 tests. **Use `openai.chat()`, not the
bare `openai()` factory** — AI SDK v6 defaults the latter to the Responses API
(§10a), which the run catalog does not serve.

**Footguns** (harness + #409): call `binding.run`/`gateway().run` as _methods_
(don't detach `this` — this bit us); forward `init.signal`; restore `config.fetch`
in `finally` (gateway mode); confirm `returnRawResponse` parity in
REST/credentials mode; non-auth headers (Anthropic `anthropic-version`) must
survive auth-stripping.

### 3. Provider supply: first-party wrapper sub-paths

Rather than asking users to import and wire raw `@ai-sdk/*` factories (#409's
API), we ship **thin wrapper sub-paths** so users import from us and we own the
fetch injection, slug mapping, and provider quirks:

```ts
import { createWorkersAI } from "workers-ai-provider";
import { openai } from "workers-ai-provider/openai";     // peer-deps @ai-sdk/openai
import { anthropic } from "workers-ai-provider/anthropic"; // peer-deps @ai-sdk/anthropic

const wai = createWorkersAI({
  binding: env.AI,
  providers: [openai, anthropic],          // opt-in, each pulls its own peer dep
  // gateway optional — defaults to the account's "default" gateway
});

wai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"); // native
wai("openai/gpt-5.4");                            // run catalog → run path, resumable
wai("openai/gpt-5.4", { cacheTtl: 3600 });        // gateway path → warns resume disabled
wai("openai/gpt-5.4", { fallback: { mode: "client", models: [...] } }); // resumable per leg
```

> **As built ([cloudflare/ai#573](https://github.com/cloudflare/ai/pull/573)) — deltas from this section's original sketch:**
>
> - **Single public entry.** `createWorkersAI` is the only surface; the delegate
>   engine is **internal** (no public `workers-ai-provider/gateway-delegate`
>   sub-path). The transport types, error classes, registry helpers,
>   `DelegateCallOptions`, and `createResumableStream` are re-exported from root.
> - **Plugins keyed by wire format, not vendor.** One `openai` plugin serves the
>   whole OpenAI-compatible long tail (deepseek, xai/grok, groq, mistral,
>   perplexity, cerebras, openrouter, fireworks) **plus** the run-catalog chat
>   providers `alibaba`/Qwen and `minimax` — so §3a's separate
>   `openai-compatible` wrapper was folded in rather than shipped.
> - **`gateway` is optional**, defaulting to the account's `"default"` gateway for
>   catalog routing; an explicit `gateway` (config- or call-level) wins, and
>   plain `@cf/*` models are never forced through a gateway.
> - **Fallback is a per-call option** (`DelegateCallOptions.fallback`, see §4),
>   not a `wai.fallback(...)` method.
> - **Per-slug autocomplete shipped** (resolves the typing open question): the
>   settings argument is typed from the model-id literal —
>   `wai("openai/gpt-5", { … })` autocompletes `DelegateCallOptions`, while
>   `wai("@cf/…", { … })` autocompletes `WorkersAIChatSettings`.
> - **Run-path wire format is per-provider** (`runWireFormat` in the registry):
>   the unified catalog normalizes most providers to OpenAI wire on the run path
>   (so `google/…` parses with the `openai` plugin there), but Anthropic stays
>   native — `anthropic/…` uses the `anthropic` plugin on both paths.
> - **Metadata & logging** (`metadata`, `collectLog`) are first-class call
>   options on both transports.

Each wrapper is a small **descriptor**: `{ vendor, createModel(modelId), quirks }`
where `createModel` builds the `@ai-sdk/*` model (with a dummy key) and `quirks`
carries provider-specific needs (required headers, slug aliasing). The
`createWorkersAI` core holds transport config and combines the two — so the
**core never imports `@ai-sdk/*`**; only the sub-path the user opts into does
(declared as that sub-path's `peerDependencies`). This is `tanstack-ai`'s
`adapters/*` pattern promoted to the primary API.

**Slug shape — the first segment is a _resolver key_, not just a vendor.** We
keep the prefix (`wai("openai/gpt-5.4")`, **not** bare `wai("gpt-5.4")`) because:

- It is the **literal run-catalog wire slug** — `env.AI.run("openai/gpt-5.4")` —
  so there's no model→vendor mapping table to maintain as the catalog drifts.
- It is the **routing key**: `wai(...)` is one entry point spanning `@cf/*`, the
  run catalog, and routing-layer providers (§3b); the prefix tells the router
  which transport/catalog/parser to use. Bare would force a clunkier
  `wai("gpt-5.4", { provider: "openai" })`.
- It **disambiguates** genuine collisions (`llama-3.3` via `@cf/meta`, Groq,
  Together, OpenRouter; `gpt-5.4` on both first-party catalog and OpenRouter).

Bare slugs are allowed only on a **provider-bound** wrapper where the vendor is
already fixed (`const oai = openai(env); oai("gpt-5.4")`, mirroring
`@ai-sdk/openai`). On the unified router the prefix is canonical.

Routing by resolver key (first segment):

- **`@cf/…`** → native `WorkersAIChatLanguageModel`. Includes Workers-AI-hosted
  third parties (`@cf/openai/gpt-oss-120b`); the `@cf/` prefix disambiguates them
  from catalog `openai/…`.
- **run-catalog vendor** (`openai/…`, `anthropic/…`, `google/…` — unified
  billing) with a registered wrapper → delegate (§1/§2), run path by default.
- **routing-layer resolver** (`openrouter/…`, §3b) → delegate via the gateway
  path / BYOK; the remainder of the slug is passed through verbatim.
- Unregistered → error naming the missing wrapper, optionally pointing at the
  `openai-compatible` wrapper (§3a).

#### 3a. Generic OpenAI-compatible wrapper

_Resolved (as built): folded into the `openai` plugin._ Because plugins are keyed
by **wire format**, the single `openai` plugin already serves every
OpenAI-shaped vendor in the registry (deepseek, xai/grok, groq, mistral,
perplexity, cerebras, openrouter, fireworks, alibaba/Qwen, minimax). No separate
`workers-ai-provider/openai-compatible` sub-path was needed.

#### 3b. Routing-layer providers (OpenRouter, et al.)

OpenRouter is itself a routing/aggregation layer, which makes it a useful stress
test — but it turns out to need **no new machinery**. It is **not on Cloudflare's
unified-billing run catalog** (verified 2026-06-14: the run API + unified billing
covers only OpenAI, Anthropic, Google AI Studio, Google Vertex AI, xAI, Groq), so
it cannot ride the resume-bearing run path. It is, however, a **provider-native
gateway endpoint** (`/{account}/{gateway}/openrouter`), reached via the _same_
`env.AI.gateway(id).run([{ provider: "openrouter", … }])` binding as every catalog
model. A `workers-ai-provider/openrouter` wrapper (peer-deps
`@openrouter/ai-sdk-provider`) is therefore just another gateway-path wrapper:

- **The "gateway OpenRouter provider" and "wrap the `@ai-sdk` provider" are the
  same thing, not a choice.** The gateway's OpenRouter integration is a
  _passthrough endpoint_ that preserves OpenRouter's (OpenAI-compatible) schema
  and adds `cf-aig-*`; you still need the SDK provider to build/parse. So we wrap
  `@openrouter/ai-sdk-provider` **and** route its fetch through the gateway —
  exactly what `tanstack-ai`'s `adapters/openrouter.ts` and #409's
  `providers/openrouter.ts` already do.
- **Injection mechanism: construction-time fetch** (§1's run-path mode, reused).
  `@openrouter/ai-sdk-provider` exposes an `httpClient`/`fetcher` seam, so we build
  it with a gateway-routed fetch (`createGatewayFetch("openrouter", …)`) rather
  than hijacking `config.fetch` (#409's capture path). Cleaner, no sentinel.
- **BYOK, not unified billing** — the user supplies an OpenRouter token
  (`Authorization: Bearer …`) or stores it on the gateway and we send
  `cf-aig-authorization`. Cloudflare doesn't bill the tokens.
- **Gateway-only column, automatically** (§2): `cf-aig-run-id` is unavailable, so
  **resume is off** (warned) — no special-casing, the matrix handles it.
- **Nested routing.** OpenRouter does its own provider fallback internally; our
  `wai.fallback([...])` composes _on top_. Guidance: let OpenRouter handle
  within-model provider selection, use our fallback for cross-_model_ fallback,
  and surface both layers' attempts in the error taxonomy (§8) so "which layer
  retried" stays debuggable.
- **Three-segment slugs** — `openrouter/anthropic/claude-sonnet-4.5`: resolver =
  `openrouter`, the rest is OpenRouter's own slug forwarded untouched as `model`.

This generalizes to other meta-routers (Vercel AI Gateway, Requesty, …) and to
every other provider-native-only gateway provider (Bedrock, Azure, Cohere,
Perplexity, Replicate, Mistral, DeepSeek, …, per the gateway provider list): each
is a resolver-keyed, gateway-path wrapper that pins to BYOK until/unless it joins
the run catalog. **Net: OpenRouter is not a new transport — it's a wrapper +
matrix row.**

### 4. Fallback: client (resumable) or server (gateway)

`wai.fallback([...])` supports two modes, surfaced through transport selection
(§2):

- **`"client"` (default).** Try each model in order on the **run path**; on an
  `unrecoverable` error advance to the next (a mid-stream drop is resumed in place
  first — see §8a). Each attempt is a normal run-path call, so **each attempt is
  independently resumable**. Trade-off: N sequential calls, no shared
  gateway-level retry/cache across the chain. Failures aggregate into the attempt
  tree (§8a).
- **`"server"`.** One `env.AI.gateway(id).run([…])` with all N models; the gateway
  picks via `cf-aig-step`. Single request + gateway retry/cache, but **no resume**
  (gateway path) — selecting it warns/errors per §2.

#### 4a. Gateway-only features are supported, but resume-exclusive (today)

Caching, `collectLog`, `retries`, `zdr`, `byokAlias`, and server-side fallback
work **now** via the gateway-path dispatch (§1) — they're not deferred. They are
simply mutually exclusive with `resume` until Cloudflare surfaces `cf-aig-run-id`
on the gateway path (the product ask). When that lands, those matrix rows gain a
run-path/both ✅ and the conflicts disappear with **no API change**.

### 5. Independent quick win (ship regardless)

Make the **native `@cf/*` path** set `returnRawResponse: true` and surface
`cf-aig-run-id` on the result/stream metadata. Small, self-contained PR; makes
`@cf/*` resume-ready the moment Cloudflare adds it to the run buffer.

### 6. Surfacing `cf-aig-run-id`

The delegate returns the `Response` with `cf-aig-run-id` intact, so AI SDK should
surface it via `result.response.headers["cf-aig-run-id"]` on both `doGenerate`
and `doStream` — **no side channel** (verify v3 propagates raw response headers).
Native `@cf/*` (§5) attaches it to stream/result metadata directly.

### 7. Resume mechanics + expiry recovery

> **Status: BUILT + VALIDATED.** Tier-1 (gateway resume) ships in
> `workers-ai-provider` as `createResumableStream`, in two modes:
>
> - **In-stream wrap** (default, run-path `fetch`): a transient mid-stream drop
>   reconnects transparently. Harness `/resume-stream`: clean run → 0 reconnects;
>   injected drop (early/late, openai + anthropic native SSE) → 1 reconnect,
>   complete coherent parse, `finishReason: stop`, no stream error.
> - **Cross-invocation re-attach** (no `initial` body + `fromEvent` offset): a new
>   invocation resumes directly from a persisted event index. Harness `/reattach`:
>   `from=0` reproduces the **full** response through the `@ai-sdk` parser (`stop`,
>   772 chars); `from=mid` is **byte-exact** against the known tail AND parses
>   cleanly through the provider parser (`stop`), yielding exactly the **tail
>   text** (e.g. 392 chars from event 83 of 167 — the prefix is intentionally
>   absent, not corrupted). This is the primitive Layer B (§9) uses.
>
> **The run is server-driven / detached — generation continues to completion after
> the originating request disconnects.** Harness `/detach` (read 3 events, then
> `reader.cancel()` to simulate disconnect): the first `resume?from=0` **blocks
> while tailing the live run** (openai 6.7s → 513 events; anthropic claude-opus-4.7
> 8.6s → 24 events) and replays the complete stream **including the terminal event**
> (`[DONE]` / `message_stop`), despite only 3 events being consumed before the
> disconnect. Implication: re-attach is genuinely **zero-loss** — the upstream run
> is not tied to the originating socket, so a re-attaching invocation recovers the
> whole answer (full via `from=0`, or prefix-from-Layer-A + tail-via-`from=N`),
> never just the bytes buffered at disconnect.
>
> An `onProgress(eventOffset)` callback (on `createResumableStream` and surfaced as
> a delegate call option) reports the live SSE event offset so callers can persist
> `{ runId, eventOffset }` for re-attach. The package reconnects on **real** read
> errors and honors `onResumeExpired` (`"error" | "accept-partial"`); tier-2
> continue/regenerate stays a Think-layer concern.

Capturing the run-id is step one. Replay needs two format-agnostic pieces:

1. **Event counting + boundary buffering (the correctness core).** `from` is an
   **SSE event index** (`\n\n` count), per the harness — counted at the _byte
   layer_, not the parsed-part layer (one provider part may span several SSE
   events). The wrapper emits only **complete** events downstream and buffers any
   trailing partial event. On a drop the buffered partial is **discarded** and
   resume starts from the count of complete events already emitted — landing
   exactly on the next event boundary, so no bytes are duplicated or truncated.
   (A naive byte-offset or part counter would misalign here; verified by the
   "discards a partial event and realigns" unit test.)
2. **Replay re-parse.** On reconnect, the same wrapped stream continues feeding the
   _same_ `@ai-sdk/*` parser bytes from the resume-endpoint Response
   (`/run/{runId}/resume?from={n}`) — the consumer never sees the break, so no
   model rebuild is needed for in-stream recovery. (Cross-invocation re-attach
   after DO eviction seeds `createResumableStream` with a persisted run-id +
   event offset instead of an initial body.)

**Expiry is a real regression vs the old design and must be handled.** The
DO-based `inference-buffer` _owned_ the buffer, so it never expired mid-recovery.
The **native gateway buffer TTL is ≈330–360s (~5.5 min)** (harness sweep: alive at
t+330s, gone by t+360s) — that is the window a DO has to re-attach after eviction
before a byte-exact resume is impossible. The expiry signal is **unambiguous**: `resume`
returns **`404` `{"error":"Request not found"}`** once the buffer is gone (vs `200`

- 0 bytes for an in-range-but-past-end `from`, vs `500` `AiGatewayError` 2002 for a
  malformed id). The delegate branches the recovery ladder on that `404`. Tiered
  recovery:

1. **Gateway resume** from the event index (fast, byte-exact) — the happy path,
   valid for ≈5 min after the run.
2. **On expiry/miss → continue/regenerate** from persisted messages. Think already
   stores the conversation, so we re-run the original request. The delegate must
   also **accumulate the partial output as it streams** and persist it, so recovery
   has a backstop independent of the gateway TTL. Two sub-strategies:
   - **2a. Continuation** (model-agnostic prompt pattern, §10c): append a
     **user-turn** instruction embedding the persisted partial ("…was interrupted
     and ended with `[partial]`. Continue from where you left off."). Works on all
     providers; semantic (not byte-exact). **Not** assistant prefill — Anthropic
     deprecated last-turn prefill (Claude 4.6+, 400), so we use the user-message
     migration path (§10c).
   - **2b. Stored-response retrieve** (stateful providers, §10a): for OpenAI
     Responses-style `store: true`, retrieve the completed response (30-day) — the
     most durable backstop. Future, gated on §10a delegation.
   - Otherwise a **cold regenerate** (retry).
3. **Policy hook `onResumeExpired`** → `"continue" | "regenerate" | "accept-partial"
| "error"` so apps choose cost/consistency trade-offs (cold regeneration spends
   tokens and may diverge from the lost tail; user-message continuation (§10c) is
   cheaper and works on all providers, but is semantic, not byte-exact).

### 8. Error taxonomy + recoverability

A single typed error hierarchy classified by recoverability, surfaced uniformly
across native, delegated, fallback, and resume paths:

| Surface                                                                                                          | Shape                                                                                      | Class                                             |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Run dispatch (`{ success:false, errors:[{code}] }`): gateway missing, unauthorized, model-not-found, 402 billing | Cloudflare envelope → typed `WorkersAIGatewayError` **before** the provider parser sees it | **unrecoverable**                                 |
| 429 capacity / 5xx                                                                                               | Cloudflare envelope                                                                        | **retryable** (bounded client-side, then surface) |
| Provider request error (e.g. OpenAI 400)                                                                         | provider-native → `@ai-sdk` throws `APICallError`                                          | **unrecoverable**                                 |
| Mid-stream connection drop, valid run-id + live buffer                                                           | —                                                                                          | **recoverable** → resume (§7.1)                   |
| Resume expired / buffer miss                                                                                     | resume endpoint error                                                                      | **degraded-recoverable** → §7 tiered recovery     |
| Fallback exhausted (all models/steps failed)                                                                     | `WorkersAIFallbackError` carrying the **attempt tree** (§8a)                               | **unrecoverable**                                 |
| Abort (`AbortSignal`)                                                                                            | —                                                                                          | **never auto-recover**; propagate                 |

Errors carry `recoverability`, the Cloudflare `code` (when present), and the
underlying provider error. The Cloudflare-envelope-vs-provider-shape distinction
is critical: the envelope must be detected and translated _before_ the response
is fed to the `@ai-sdk` parser, or it mis-parses as a malformed completion.

#### 8a. Nested fallback: the attempt tree

There can be **up to three independent fallback layers** stacked on one logical
call, and the #1 debugging question is _"which layer retried?"_. We answer it with
a single **attempt tree** carried on the error, not a flat list:

1. **Client-side fallback** (ours, §4 `mode:"client"`) — we loop over models; full
   visibility, we drive it.
2. **Gateway server-side step** (§4 `mode:"server"`, `cf-aig-step`) — the gateway
   picks among an array in one request; only the _winning_ step index is on the
   response header, per-step failures live in the gateway log (`cf-aig-log-id`).
3. **Routing-layer internal** (OpenRouter, §3b) — the provider re-routes among its
   own upstreams; only the _serving_ upstream (`provider` field) is reliably
   surfaced, discarded sub-attempts only if it includes them in error metadata.

Typed shape (sketch):

```ts
type Recoverability =
  | "recoverable" // mid-stream drop, valid run-id + live buffer → resume
  | "degraded-recoverable" // resume expired → regenerate / accept-partial (§7)
  | "retryable" // 429 / 5xx, bounded retry then surface
  | "unrecoverable"
  | "aborted";

type AttemptLayer = "client-fallback" | "gateway-step" | "provider-internal";

interface Attempt {
  model: string; // slug as requested, e.g. "openrouter/anthropic/claude-…"
  layer: AttemptLayer;
  transport: "run" | "gateway";
  index: number; // position within its layer
  startedAt: number;
  runId?: string; // cf-aig-run-id (run path only)
  resumable: boolean; // had a live run-id when it failed
  cfStep?: number; // cf-aig-step (gateway-step layer)
  cfLogId?: string; // cf-aig-log-id → where to find per-step detail
  servedBy?: string; // routing-layer's chosen upstream (OpenRouter `provider`)
  error?: WorkersAIError; // why it failed; absent if this attempt succeeded
  children?: Attempt[]; // nested attempts from a deeper layer (best-effort)
}

class WorkersAIError extends Error {
  recoverability: Recoverability;
  source: "cloudflare" | "provider" | "transport" | "client";
  cfCode?: number; // Cloudflare envelope error code
  status?: number; // HTTP status
  cause?: unknown; // underlying @ai-sdk APICallError, etc.
}

class WorkersAIFallbackError extends WorkersAIError {
  attempts: Attempt[]; // the full tree, in attempt order
  summary(): string; // flattened, human-readable post-mortem
}
```

**Layer interaction — resume is tried _before_ fallback advances.** Within a
single attempt, a mid-stream drop with a valid run-id is `recoverable` and is
**resumed in place** (§7.1) — it does **not** advance the fallback cursor. The
client-fallback layer only advances on an `unrecoverable` error (or after resume
is exhausted via §7). This keeps "we resumed" and "we fell back" distinct in the
tree: a resumed attempt stays one `Attempt` (its `resumable: true`), a fallback is
a new sibling `Attempt`.

**Honesty about observability.** We populate only what each layer actually
exposes: client-fallback = complete; gateway-step = winning `cfStep` + `cfLogId`
pointer (children best-effort from the log); provider-internal = `servedBy` +
whatever error metadata the router returns. Where a layer can't enumerate its
discarded attempts, we record the `cfLogId` / routing metadata rather than
fabricate `children`.

**Guidance + a warn.** Prefer **one** active fallback layer for clean
attribution. Stacking all three (our `fallback` + `mode:"server"` + a routing-layer
provider) is legal but makes attribution fuzzy — emit a **warn** (per the §2
loud-warning philosophy) naming the stacked layers, and lean on `cfLogId` to
reconstruct the gateway's internal decisions. `summary()` renders the tree, e.g.:

```txt
client-fallback[0] openai/gpt-5.4 (run) → APICallError 429 retryable, resumable=false
client-fallback[1] openrouter/anthropic/claude-sonnet-4.5 (gateway) servedBy=anthropic
  └ provider-internal[0] → 503, then served by anthropic (cfLogId=…)
result: succeeded on client-fallback[1]
```

### 9. Think / Agents SDK integration

The Agents SDK already has **two recovery layers**; gateway resume adds a missing
capability to the second rather than replacing anything.

- **Layer A — DO ↔ client** (`packages/agents/.../resumable-stream.ts`,
  `ResumableStream`): buffers serialized `UIMessageChunk`s in SQLite and replays
  them over WebSocket when a client reconnects. Always on. Fully handles "client
  refreshed / dropped, DO still alive" — **gateway resume is not needed here**.
- **Layer B — DO ↔ upstream LLM** (_does not exist today_): on **DO eviction
  mid-turn**, the `chatRecovery` fiber survives and `onChatRecovery` defaults to
  `continueLastTurn()` — a **fresh model call** that re-spends tokens and
  regenerates. This is exactly where gateway `cf-aig-run-id` resume belongs:
  re-attach to the _same_ upstream run and replay the exact tail.

Plug-in path (every hook already exists in `packages/ai-chat` /
`packages/think`; the resume primitive is now **built** — see §7.1 status):

1. **Capture.** The delegate already surfaces both halves: `onDispatch(info)`
   gives `info.runId` (the `cf-aig-run-id`), and `onProgress(eventOffset)` fires
   the live SSE event index as the stream advances. No framework header-reading
   gap to close — the delegate owns it. (The old "framework reads only
   `content-type`" concern is moot when the model is the delegate.)
2. **Stash** `{ aigRunId, eventOffset }` via `this.stash()` while inside the chat
   fiber (`__cf_internal_chat_turn:${requestId}`, persisted to `cf_agents_runs`,
   survives eviction). Throttle: `onProgress` can fire per chunk, so debounce the
   stash like the existing `_bumpChatRecoveryProgress` flush.
3. **On recovery** (`_handleInternalFiberRecovery` → `onChatRecovery`,
   `ctx.recoveryData` carries the stashed `{ aigRunId, eventOffset }`): build the
   re-attach stream with `createResumableStream({ binding, gateway, runId,
fromEvent: 0 })` (**no `initial` body**), feed it through the same `@ai-sdk`
   model → `UIMessageChunk`s → the existing `_reply` / Think stream loop. Because
   the run is detached (§7.1), `fromEvent: 0` replays the **complete** run; the
   framework's `continueLastTurn` **replaces** the partial leaf with that replay,
   so the recovered message is **byte-identical to the full run, zero regenerated
   tokens** — validated live (`experimental/gateway-resume-think`: recovered
   `=== full`, e.g. 17303 chars, via a `/gw/verify` ground-truth check against
   `resume?from=0`). Fall back to `continueLastTurn()` on expiry/miss (via
   `onResumeExpired` or a `404` from the re-attach).

   **`from=0` over a tail re-attach (`from=eventOffset`).** A tail re-attach would
   save re-streaming the prefix bytes, but it is _not_ zero-loss in practice: with
   `continueLastTurn`'s replace semantics it drops the already-streamed prefix
   (the partial leaf is overwritten by just the tail), and even with append
   semantics the Layer-A↔SSE offset-space mismatch (point 4) misaligns the seam.
   `from=0` needs only the run-id, costs zero tokens (it replays the gateway
   buffer, not the model), and is provably whole — so it is the recommended Layer
   B strategy. The event offset is still worth stashing (observability + the
   opt-in tail path); stash it with a **delta-based** throttle, not `eventOffset %
N` — SSE offsets jump (one chunk can carry several events), so a modulo check
   often never lands on a boundary and the offset is never re-stashed (observed:
   only the initial offset-0 stash survived until this was fixed).

4. **Offset-space mismatch (handled).** Layer A counts post-parse
   `UIMessageChunk`s; gateway `from=N` counts **provider-native SSE events**
   (§7.1). These are different cursors — stash the **SSE event index** from
   `onProgress` (the §7.1 byte-layer counter), _not_ the chunk count.
5. **`recoveryKind` mapping.** `ChatRecoveryContext` already carries
   `recoveryKind: "retry" | "continue"` plus `partialText` / `partialParts`.
   Gateway resume is the preferred **"continue"** strategy (byte-exact, free);
   when it's unavailable, `partialText`/`partialParts` feed a **model-agnostic
   user-message continuation** (§10c; not assistant prefill — deprecated on
   Anthropic 4.6+), else cold **"retry"**.

Net: gateway resume turns DO-eviction recovery from a regenerate into a
**zero-token, full re-attach** — proven end-to-end (`experimental/gateway-resume-think`:
real `ctx.abort()` eviction mid-turn → recovered message byte-identical to the
completed run, zero regenerated tokens). The attempt tree (§8a) gives Think one
structured object to log/display for "which model/provider/layer served or
failed" without bespoke parsing.

### 10. Provider-specific interactions

Three provider features overlap with resume and need explicit handling.

#### 10a. OpenAI Responses API (stateful) — out of scope for v1

The Responses API (`/v1/responses`) is a **separate endpoint and schema** from
Chat Completions (`input` not `messages`; semantic events like
`response.output_text.delta`). It carries its **own** resume mechanism that
parallels ours: background mode (`background+stream+store`) + reconnect via
`GET /v1/responses/{id}?stream=true&starting_after={sequence_number}`, where
`sequence_number` is OpenAI's event cursor (≈ our gateway `from=N`), with a
**~5-minute stream TTL** and higher TTFT. `store: true` (default) also makes the
completed response **retrievable for 30 days**.

Decisions:

- **Scope v1 to `openai.chat()`** (Chat Completions) — the run catalog returns
  Chat Completions SSE (harness-verified), so `openai.responses()` delegation is
  almost certainly not accepted by `env.AI.run` today. Mark Responses API as a
  **future matrix row**, gated on a Risk #1-style passthrough check for its body.
- **Standardize on gateway resume** on the run path (provider-agnostic, no
  background-mode latency tax). The Responses-native `sequence_number` resume only
  matters when bypassing the gateway — we don't rely on it.
- **Don't depend on server-side conversation state.** `previous_response_id` /
  Conversations conflict with Think owning message history; the DO stays the
  source of truth. Use stateless-style requests.
- `store`/retrieve is noted as a durable recovery backstop in §7 (tier 2b).

#### 10b. OpenAI Predicted Outputs (`prediction`)

A **latency** optimization (speculative decoding): provide a draft via the
`prediction` body field; accepted tokens speed generation, **rejected tokens are
still billed**. It does **not** steer output, is Chat-Completions-only, limited to
specific models, and is **incompatible with tools** and `max_completion_tokens`.
For us it is just another **passthrough body field** the `@ai-sdk/openai` emits
(subject to Risk #1) — no special resume handling. One caveat: on
regenerate-after-expiry the prediction's acceptance can differ, contributing to
the usual regeneration divergence (§7) — not a new problem.

#### 10c. Continuation after expiry: prompt-based, not assistant prefill

Initial assumption (now corrected): "use Anthropic assistant prefill to continue."
**Anthropic deprecated last-turn assistant prefill starting with Claude 4.6** —
requests with a trailing `{ role: "assistant" }` prefill to those models **return a
400 error** ([prompting best practices: migrating away from prefilled
responses](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#migrating-away-from-prefilled-responses)).
Only **older** Anthropic models still accept it; OpenAI never did. So prefill is
**not** a viable recovery primitive going forward.

The same doc gives the official migration for exactly our case ("resume an
interrupted response"), and it's **better** than prefill because it's
**model-agnostic** — a plain **user-message continuation**, not a trailing
assistant turn:

> Move the continuation to the **user message**, including the final text from the
> interrupted response: _"Your previous response was interrupted and ended with
> `[partial]`. Continue from where you left off."_

So tier-2 continuation (§7 tier 2a) becomes: on resume-expiry, append a
**user-turn continuation instruction** that embeds the persisted partial
(`partialText`/`partialParts` from `ChatRecoveryContext`) and re-run. This is the
`recoveryKind: "continue"` path (§9, step 5). Properties:

- **Works on every provider** (OpenAI, Anthropic 4.6+, catalog, OpenRouter) — it's
  a prompt pattern, not an API capability. **No `supportsAssistantPrefill` flag,
  no provider asymmetry, nothing to gate.**
- **Semantic, not byte-exact** (the model rephrases the boundary) — same boundary-
  reconciliation concern as before (open question), and still strictly a tier-2
  fallback. **Gateway resume (§7, replay) remains the primary, byte-exact path;**
  the design never depends on continuation.
- Cold **"retry"** (regenerate from scratch) remains the final fallback if even
  continuation is undesirable.

## The alternatives

- **Single transport, run-path-only** (resume always; gateway features deferred
  until the product gap closes). _Rejected:_ strands users who want caching /
  server-side fallback **today** and accept no resume. The capability matrix
  serves both groups now and collapses to this automatically as parity lands.
- **Single transport, gateway-path-only** (the #409 design — server-side fallback
  - caching). _Rejected:_ that path has **no `cf-aig-run-id`** (verified), so it
    sacrifices resume — the motivating feature. Available as `transport: "gateway"`
    / gateway-only options, not the default.
- **Silently pick a transport without surfacing conflicts.** _Rejected:_ a user
  asking for `resume` + `cacheTtl` would get one silently dropped. The matrix
  **errors on impossible combinations and warns when resume is disabled** instead.
- **Raw `@ai-sdk/*` factory registry** (`providers: { openai: createOpenAI }`),
  users import from `@ai-sdk` directly (#409's API). _Rejected_ in favor of
  first-party wrapper sub-paths (§3) so we own fetch/quirks and users have one
  import source.
- **Bundled providers** — core takes all `@ai-sdk/*` as deps and auto-detects.
  Best UX, but heavy deps (an "ask first" per repo rules) + version coupling.
  _Rejected;_ per-sub-path peer deps give granular installs instead.
- **Block on landing PR #409 and import its engine.** _Rejected:_ #409 isn't
  landing soon; invert the dependency and let it reuse us later.
- **Hand-roll catalog SSE parsing** (`tanstack-ai` `transformWorkersAiStream`
  style). _Rejected:_ duplicates each `@ai-sdk/*` parser.

## Risks & de-risking order

The original Risk #1 (does the gateway path return `cf-aig-run-id`?) is
**answered: no** (2026-06-14) — which is exactly why the matrix splits resume
(run path) from fallback/caching (gateway path). Prototype order against the
harness, each gating the next:

1. **Request-side passthrough — RESOLVED ✅ (2026-06-14).** Real `@ai-sdk/openai`
   (`.chat`) and `@ai-sdk/anthropic` bodies dispatched through
   `env.AI.run(slug, …, { returnRawResponse })` and parsed cleanly by the same
   provider — text + tools + usage + finish, on `openai/gpt-5.4` and
   `anthropic/claude-opus-4.7`. Harness: `/passthrough` in
   `experimental/gateway-resume`. The fallback plans (compose-explicitly, or
   `/compat` normalization) are **not** needed.
2. **Non-auth header survival** for Anthropic (`anthropic-version`) — **RESOLVED ✅**
   implicitly: the run-path Anthropic call returned 200 and parsed, impossible if
   the version header were stripped.
3. **`cf-aig-run-id` surfaces** via `result.response.headers` (run path) —
   **RESOLVED ✅**: matches the fetch-captured id on every call.
4. **Resume round-trip + expiry — RESOLVED ✅.** Round-trip is byte-exact with an
   event-index `from`. Expiry has a clean, distinct contract: live + in-range →
   `200` tail; live + past-end → `200` + 0 bytes; **expired → `404`
   `{"error":"Request not found"}`**; malformed id → `500` `AiGatewayError` 2002.
   **Buffer TTL ≈ 330–360s (~5.5 min)** (fine sweep: alive at t+330s, gone by
   t+360s). That `404` is the signal §7 tiered recovery branches on; the ~5.5 min
   TTL is the DO re-attach window before byte-exact resume is lost.
5. **Transport selection — premises RESOLVED ✅.** The three contended features
   land on **disjoint transports**: `cf-aig-run-id` (resume) run-path only;
   `cf-aig-step` (server fallback) and `cf-aig-cache-status` (caching) gateway-path
   only. So the matrix's split is empirically grounded. The selection _logic_
   (conflict errors/warnings, §2) is delegate code → construction-time + unit tests.
6. **Gateway-path dispatch — RESOLVED ✅ (fallback).** `env.AI.gateway(id).run([…])`
   with a bad first entry served from `cf-aig-step: 1`, status `200`, real chunks.
   **Caching** did not produce a HIT on the `default` gateway (MISS/MISS) — caching
   is gateway-config-dependent (or `cf-aig-cache-ttl` is a gateway control directive,
   not a per-entry header); not an architecture risk, and #409's 124 tests cover the
   round-trip.
7. **REST/credentials-mode parity** — _deferred (needs a scoped
   `CLOUDFLARE_API_TOKEN`; account is OAuth-logged-in)._ Low risk: credentials mode
   hits the same gateway backend, differing only in auth front door + base URL.

With 1–3 green and 4–6 substantially settled, the run-path delegate is
**architecturally validated**: building the `@ai-sdk/*` model with a forwarding
fetch is sufficient; no per-provider parsing or param translation is required, and
the resume/fallback/caching transport split is confirmed. Implementation can begin;
the TTL sweep and REST parity are the only open empirical items, neither blocking.

## Testing strategy

Two tiers — fast hermetic unit tests for every PR, plus a **live e2e suite that
runs real queries and asserts on real responses for every feature**.

### Tier 1 — Unit (hermetic, runs on every PR)

Mock `env.AI.run` / `env.AI.gateway().run` and replay **real provider SSE
fixtures** captured once from the live harness (per provider: streaming,
non-streaming, tool call, reasoning, error envelope). Pins the parser contract
without network, mirroring `ai-gateway-provider`'s msw-based suite. Also unit-test
the pure logic directly: **transport selection** (every matrix cell + conflict
throw + resume-disable warn), the **SSE event counter**, **Cloudflare-envelope vs
provider-error** detection, and the **error taxonomy** classification.

### Tier 2 — E2E (live, every feature × representative models)

A `vitest`-driven suite (gated behind a `RUN_E2E=1` env flag + real
`CLOUDFLARE_*` creds, so it never runs in untrusted PR CI) that hits live models
through the built provider and asserts on actual output. The harness
(`experimental/gateway-resume`) graduates into the fixture-capture + smoke
backbone for this. Run **nightly** and **before release**, not on every PR.

Coverage is a **feature × model matrix** — each row asserts the real behavior, not
just a 200:

| Feature                          | What the live test asserts                                                                                                                                           | Models                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Native `@cf/*` text + stream     | text streams, finish reason, usage present                                                                                                                           | a `@cf/*` llama               |
| Catalog text (run path)          | non-empty completion, correct finish/usage                                                                                                                           | openai, anthropic, google     |
| Catalog **streaming** (run path) | chunks arrive in order, parser yields clean text                                                                                                                     | openai, anthropic, google     |
| **Tool calls**                   | model emits a tool call the `@ai-sdk` parser decodes; round-trip result                                                                                              | openai, anthropic             |
| **Reasoning**                    | reasoning parts surfaced where supported                                                                                                                             | a reasoning model             |
| **`cf-aig-run-id` capture**      | header present on `result.response.headers`                                                                                                                          | every catalog provider        |
| **Resume happy path**            | drop at event N, `resume(from=N)` replays exact tail; concatenation equals an uninterrupted run                                                                      | openai, anthropic             |
| **Resume expiry**                | force/await TTL miss → `onResumeExpired` policy fires (continue / regenerate / accept-partial / error)                                                               | one provider                  |
| **Continuation** (§10c)          | after expiry, a **user-turn** continuation instruction embedding the partial makes the model continue; works on all providers (no prefill); falls back to cold retry | openai, anthropic, openrouter |
| **Client-side fallback**         | first model forced to fail → second answers; **each step independently resumable**                                                                                   | openai→anthropic              |
| **Server-side fallback**         | `gateway().run([a,b])`, `cf-aig-step` reflects the winner; warns resume disabled                                                                                     | openai+anthropic              |
| **Caching**                      | 2nd identical call returns `cf-aig-cache-status: HIT` (gateway path)                                                                                                 | one provider                  |
| **`metadata` / `eventId`**       | echoed/observable in gateway logs                                                                                                                                    | one provider                  |
| **`byok` / unified billing**     | call succeeds with no provider key (binding)                                                                                                                         | one catalog model             |
| **Transport conflict**           | `resume:true` + `cacheTtl` **throws** the documented error                                                                                                           | n/a (no network)              |
| **Attempt tree** (§8a)           | exhausted fallback → `WorkersAIFallbackError` with ordered per-layer attempts; resumed drop stays one attempt, not a sibling                                         | openai→anthropic, openrouter  |
| **Error envelopes**              | model-not-found / 402 / unauthorized → typed `WorkersAIGatewayError`, right recoverability                                                                           | n/a + live 4xx                |
| **Abort**                        | `AbortSignal` cancels mid-stream, no auto-recover                                                                                                                    | one provider                  |
| **Routing-layer provider** (§3b) | `openrouter/…` resolves to gateway path, BYOK key works, no `cf-aig-run-id`, resume-disabled warning fires                                                           | openrouter                    |
| **REST/credentials parity**      | a representative subset re-run via credentials mode (not just the binding)                                                                                           | openai                        |

Properties the e2e suite must guarantee (beyond "it returned something"):
**resume correctness** (resumed concatenation byte-equals an uninterrupted
stream), **transport routing** (assert which path each option combo actually
took, via the observed `cf-aig-*` headers), and **graceful degradation** (expiry
and fallback land on the right recovery branch). Keep model slugs and any
flaky-prone assertions tolerant of provider drift (assert structure/shape, not
exact text), and pin a small set of stable slugs in one config so the matrix is
cheap to update as the catalog changes.

## Backward compatibility

`providers` is an additive optional field — non-breaking for `@cf/*` users.
However, anyone _already_ passing a `vendor/model` slug to `createWorkersAI` gets
**new routing behavior** (previously it hit the native Workers AI path, likely
mis-parsing). Ship with a changeset and a note; the prior behavior was not a
reliable supported path.

## Open questions

- ~~**Request-side passthrough** (Risk #1)~~ — **resolved ✅**: `env.AI.run` accepts
  the exact `@ai-sdk/*` body (openai `.chat` + anthropic) and returns parser-clean
  output (text, tools, usage, finish). See harness `/passthrough`.
- ~~**Buffer TTL** for run-path resume~~ — **resolved ✅ (≈330–360s, ~5.5 min)**;
  expiry signal is a clean `404 {"error":"Request not found"}` (§7). Open
  sub-question: is the TTL **configurable** per gateway? (Affects how aggressively
  we persist partials.)
- ~~Wrapper descriptor shape (§3)~~ — **resolved ✅ (as built)**: a plugin is
  `{ wireFormat, create({ modelId, … }) }`, keyed by wire format (one `openai`
  plugin serves the OpenAI-compatible long tail). Optional per-sub-path
  `peerDependencies` (`@ai-sdk/openai|anthropic|google`, marked optional) give a
  clean install story — you pull only the wire formats you use.
- **Routing-layer providers** (§3b): _resolved 2026-06-14._ OpenRouter is
  gateway-path-only/BYOK (not on the run catalog) and rides the same
  `gateway().run([{ provider: "openrouter" }])` binding; the gateway integration
  _is_ the wrapped `@openrouter/ai-sdk-provider` routed through a gateway fetch
  (construction-time injection). No new transport. Nested fallback attribution is
  specced as the **attempt tree** (§8a). Remaining: empirically confirm how much
  of OpenRouter's _internal_ routing (discarded sub-attempts, not just the
  serving `provider`) is recoverable from its response vs only via `cf-aig-log-id`
  — drives how much of `Attempt.children` we can populate for `provider-internal`.
- **Slug shape** (§3): confirmed prefix-canonical (`openai/gpt-5.4`) on the
  unified router, bare allowed on provider-bound wrappers — does that hold up
  against three-segment routing-layer slugs and future catalog renames?
- **OpenAI Responses API** (§10a): does the run catalog accept Responses-shaped
  bodies at all, or is it Chat-Completions-only? If/when supported, how do we
  reconcile its native `sequence_number` resume + `store` retrieval with gateway
  resume (prefer gateway, but expose stored-retrieve as tier 2b)?
- **Continuation boundary** (§10c): after a user-turn continuation, the resumed
  text is semantic (not byte-exact) — how do we reconcile the boundary in the
  persisted `UIMessageChunk` buffer (Layer A) so the client doesn't see a
  duplicated/rephrased fragment?
- **`cf-aig-run-id` capture in the framework** (§9): the cleanest seam to read the
  delegate's response headers and stash them — `onChatMessage` return, a Think
  `beforeTurn`/`afterTurn` hook, or a provider-level callback?
- Image / embedding / transcription / speech models: native-only for now, or do
  any catalog equivalents need delegation too?
- ~~Does typing survive `verbatimModuleSyntax` + `(string & {})` in
  `TextGenerationModels`, and can wrappers yield real per-slug autocomplete?~~ —
  **resolved ✅ (as built)**: yes. A `KnownTextGenerationModels` literal union
  (minus the `(string & {})` escape) plus a conditional `ModelSettings<M>` keyed
  off the captured model-id literal gives real per-slug autocomplete —
  `DelegateCallOptions` for `"<provider>/<model>"` slugs, `WorkersAIChatSettings`
  for `@cf/…` — with no breaking change to the return type.
- ~~Fallback ergonomics~~ — **resolved ✅ (as built)**: fallback is a **per-call
  option** (`DelegateCallOptions.fallback = { mode, models }`), not a
  `wai.fallback(...)` method. `"client"` keeps resume per leg; `"server"` uses
  the gateway path. (Open follow-up: retry/backoff policy between client legs.)
- ~~**Conflict granularity** (§2)~~ — **resolved ✅ (as built)**: default-on
  resume; **warn loudly** when a gateway-only opt-in silently disables it;
  **hard-error** only on impossible explicit combinations (e.g. `resume: true` +
  `fallback.mode: "server"`, or a gateway-only feature on a run-path-only
  provider). Run-path-only providers (`gatewayPath: false`, e.g. alibaba/minimax)
  reject gateway-path features at config time.
- ~~Should `openai-compatible` (§3a) ship in v1 or wait?~~ — **resolved ✅**: not
  shipped as a separate wrapper; folded into the wire-format-keyed `openai`
  plugin (§3a).

## The decision

**Accepted and implemented** in [cloudflare/ai#573](https://github.com/cloudflare/ai/pull/573)
(2026-06-16). As built, the surface deviated from the original sketch in a few
deliberate ways (all detailed in §3's "As built" callout):

- **Single public entry** — `createWorkersAI({ providers })`; the delegate engine
  is internal (no public `gateway-delegate` sub-path).
- **Plugins keyed by wire format** — one `openai` plugin serves the whole
  OpenAI-compatible long tail (so §3a's separate wrapper was folded in), plus
  per-provider `runWireFormat` (Anthropic stays native on the run path).
- **`gateway` optional**, defaulting to the `"default"` gateway for catalog
  routing; `@cf/*` models are never forced through a gateway.
- **Fallback is a per-call option**; **metadata/`collectLog`** are first-class on
  both transports.
- **Per-slug autocomplete** via literal-driven conditional settings types.
- Whole third-party/gateway surface marked **experimental**.

Original direction (agreed in discussion 2026-06-14), which this implements:

- **Capability-driven dual transport.** Support **both** the run path (resume) and
  the gateway path (server-side fallback, caching, full `cf-aig-*`). A capability
  matrix (§2) selects the transport from the requested options: prefer the run
  path so resume stays on; switch to the gateway path when a gateway-only option
  is requested; **error loudly** on impossible combinations (e.g. `resume: true` +
  `cacheTtl`) and **warn loudly** when a gateway opt-in disables resume. A
  `transport` escape hatch forces a path.
- Implement the delegate engine **inside `workers-ai-provider`** as the
  **`workers-ai-provider/gateway-delegate`** sub-path; invert the dependency so
  `ai-gateway-provider` reuses it later. Don't block on PR #409. The engine has
  **two dispatch modes**: construction-time fetch (run path) and capture/redispatch
  (gateway path, #409's mechanism).
- Supply providers via **first-party wrapper sub-paths**
  (`workers-ai-provider/openai`, …) that peer-dep `@ai-sdk/*`, so users import
  from us and we own fetch injection + quirks.
- **Slugs are prefix-canonical** (`openai/gpt-5.4`): the first segment is a
  **resolver key** (the real run-catalog wire slug + the routing signal), not
  decoration. Bare slugs only on provider-bound wrappers.
- **Routing-layer providers** (OpenRouter, §3b) need **no new machinery**: they
  ride the same `gateway().run([{ provider: "openrouter" }])` binding as catalog
  models. The gateway's OpenRouter integration _is_ the wrapped
  `@openrouter/ai-sdk-provider` routed through a gateway fetch (construction-time
  injection, reusing §1) — BYOK, gateway-path-only, no resume, all from the matrix.
- **Fallback** is `"client"` by default (each attempt resumable, run path) or
  `"server"` (gateway `cf-aig-step`, no resume).
- The split between resume and gateway features reflects a **product gap**: the
  gateway path lacks `cf-aig-run-id` (verified). We'll ask the team to add it; when
  it lands, matrix rows merge and the conflicts vanish **with no API change**.
- Handle **resume-after-expiry** with tiered recovery + persisted partials, and a
  **typed error taxonomy** classified by recoverability.
- **Provider-specific scoping** (§10): v1 targets **Chat Completions**; OpenAI
  **Responses API** is out of v1 (catalog is Chat Completions; it has its own
  resume). Tier-2 **continuation** uses a **model-agnostic user-message** pattern
  (Anthropic deprecated last-turn prefill on 4.6+), so there's no provider gating;
  it's always a fallback behind byte-exact gateway resume.
- Ship **two test tiers**: hermetic unit tests (every PR) **and** a live e2e
  suite that runs real queries and asserts real responses for **every feature**
  (the feature × model matrix), gated behind creds and run nightly / pre-release.

Gating experiment before code: **request-side passthrough** on the run path
(Risk #1) — feed a real `@ai-sdk/*` body through `env.AI.run` and parse it.
RFC-first otherwise.

## History

- Empirical basis: [`experimental/gateway-resume`](../experimental/gateway-resume/README.md)
  — verified native resume across OpenAI / Anthropic / Google catalog models.
- Reference (not a dependency): [cloudflare/ai#409](https://github.com/cloudflare/ai/pull/409)
  — `createAIGateway` decorator rewrite (open; not expected to land soon). We
  re-implement its mechanism inside `workers-ai-provider` and let
  `ai-gateway-provider` reuse it later.
- Design evolution (2026-06-14): registry → invert-dependency engine → full
  gateway-feature engine → run-path-primary (after verifying the gateway path has
  no `cf-aig-run-id`) → **capability-driven dual transport** (current): support
  both paths, select from an option→transport matrix, error/warn loudly on
  incompatible mixes, collapse conflicts as the run path gains parity.
- Provider-feature + Think-recovery investigation (2026-06-14): (a) OpenAI
  **Responses API** is stateful with its own background-mode resume
  (`starting_after=sequence_number`, ~5min TTL) + 30-day `store` retrieval — scoped
  **out of v1** (catalog is Chat Completions); (b) **prefill** attribution is
  reversed from initial assumption, then corrected against Anthropic docs:
  **Anthropic deprecated last-turn assistant prefill on Claude 4.6+** (400 error);
  OpenAI never supported it. The `recoveryKind:"continue"` primitive (§10c)
  therefore uses Anthropic's official **user-message continuation** migration path
  — model-agnostic, no prefill, always a tier-2 fallback behind gateway resume; (c) Agents SDK already has Layer A (DO↔client `ResumableStream`)
  and `chatRecovery`/`runFiber` (DO eviction) with `onChatRecovery` +
  `partialText`/`recoveryKind` hooks, but **no `cf-aig-run-id` capture** — gateway
  resume plugs in as the new Layer B (DO↔upstream) via `stash()` (§9). Subagent
  map: [chat recovery exploration](10866ae4-99d9-4ffe-a8d7-8ab0b183b494).
- OpenRouter investigation (2026-06-14): confirmed OpenRouter is **not** on the
  unified-billing run catalog (run API = OpenAI/Anthropic/Google AI Studio/Google
  Vertex/xAI/Groq only) and is a provider-native gateway endpoint reached via
  `gateway().run([{ provider: "openrouter" }])`. Existing art:
  `ai-gateway-provider/src/providers/openrouter.ts` (capture/redispatch) and
  `tanstack-ai/src/adapters/openrouter.ts` (construction-time fetch into the SDK's
  `httpClient`). Conclusion: gateway integration _is_ the wrapped SDK + gateway
  fetch — no new transport (§3b).
- Implementation (2026-06-14): delegate engine + provider plugins + sub-path
  exports landed in `cloudflare/ai` (branch `feat/workers-ai-provider-gateway-delegate`).
  Resume reconnect/replay layer (§7.1) built as `createResumableStream` and
  validated live via the harness `/resume-stream` endpoint (clean +
  injected-drop, openai + anthropic): transparent reconnect, complete parse,
  `finishReason: stop`. Buffer TTL pinned to ≈330–360s with a clean `404` expiry
  contract via `ttl-sweep*.sh`.
- Provider/feature layer (2026-06-14): mirroring [cloudflare/ai#409](https://github.com/cloudflare/ai/pull/409),
  added the full **provider registry** (`src/gateway-providers.ts` — every gateway
  provider → gateway id, wire format, run-catalog membership, billing, host
  detection) and reworked provider plugins to be keyed by **wire format**, so one
  `openai` plugin serves the whole OpenAI-compatible long tail (deepseek, xai/grok,
  groq, mistral, perplexity, openrouter, cohere, …). Added `@ai-sdk/google` as a
  third optional peer. New surfaces: **BYOK** header forwarding + per-provider
  strip, **client-side fallback** (`createClientFallbackModel`, resume preserved
  per leg, `WorkersAIFallbackError` attempt tree), **server-side fallback** entry
  shaping, gateway-options + abort passthrough, and a **bring-your-own-provider**
  wrapper (`workers-ai-provider/gateway` → `createGatewayFetch`/`createGatewayProvider`,
  URL-detected provider id) for provider-native/non-chat providers. Typed error
  taxonomy in `src/errors.ts` (`WorkersAIGatewayError` with `code`/`recoverable`/
  envelope parsing + `classifyStatus`/`extractErrorMessage`). Coverage: 64 new unit
  tests (registry, transport selection incl. non-run-catalog, gateway entry
  shaping, header strip, BYOK, fallback entries, abort, cache headers, error
  classification, attempt tree, BYOG) + a live e2e harness
  (`test/e2e/fixtures/gateway-worker` + `workers-ai-gateway.e2e.test.ts`, gated on
  `RUN_E2E`, `test:e2e:gateway`) covering the Tier-2 run/gateway/fallback/cache/BYOG
  matrix. Package README + changeset updated.
- API consolidation + ship (2026-06-16): opened
  [cloudflare/ai#573](https://github.com/cloudflare/ai/pull/573). Made
  `createWorkersAI` the **single public entry** (delegate engine internalized — no
  public `gateway-delegate` sub-path); a non-`@cf/` `"<provider>/<model>"` slug is
  routed automatically when `providers` is set. Added **literal-driven settings
  typing** (`KnownTextGenerationModels` + `ModelSettings<M>`) for real per-slug
  autocomplete (resolves the typing open question). Added **first-class
  metadata/`collectLog`** on both transports, the run-catalog chat providers
  **alibaba/Qwen** and **minimax** (run-path-only, `gatewayPath: false`), and
  **per-provider `runWireFormat`** so the run path parses each provider correctly
  (OpenAI-wire for most; native for Anthropic — addresses
  [cloudflare/ai#554](https://github.com/cloudflare/ai/issues/554)). Made
  **`gateway` optional**, defaulting to the account's `"default"` gateway for
  catalog routing. Hardened the live e2e (real `default` gateway; strict
  transport/runId/resume assertions; mid-stream-drop byte-identical
  reconstruction): 370 unit + 16/1-skip gateway e2e + 76 binding e2e passing.
  Whole gateway surface marked **experimental**.
