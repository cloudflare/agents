# Gateway Resume Harness

Verifies **AI Gateway native resumable streaming** — the production feature that
the `experimental/inference-buffer` prototype (RFC #1257) was a proof-of-concept
for.

AI Gateway durably buffers streaming inference responses and stamps each run
with a `cf-aig-run-id` header. A dropped consumer reconnects and replays from an
offset:

```
GET https://workers-binding.ai/ai-gateway/gateways/{gateway}/run/{runId}/resume?from={n}
```

This harness exercises that contract across models — including OpenAI/Anthropic
models routed **through Workers AI** on unified billing
([AI Platform blog](https://blog.cloudflare.com/ai-platform/)) — and reports:

- whether a `cf-aig-run-id` is issued per model,
- whether `resume(from=0)` reproduces the full stream byte-for-byte,
- whether `resume(from=mid)` equals the tail of the full stream (the core
  invariant — same run id, so the buffer is deterministic),
- whether `from` is a **byte offset** or an **SSE event index** (detected
  empirically by trying both).

## Run it

Requires a Cloudflare account with Workers AI / AI Gateway access. The `AI`
binding is configured with `remote: true`, so `wrangler dev --remote` hits the
real gateway.

```bash
cd experimental/gateway-resume
pnpm start           # wrangler dev --remote, http://localhost:8787
```

Then open `http://localhost:8787/` for the HTML matrix, or:

| Endpoint | Purpose |
| --- | --- |
| `GET /` | HTML report over the default model matrix |
| `GET /probe?model=<slug>` | Single-model JSON report (the core test) |
| `GET /matrix?models=a,b,c` | JSON report across comma-separated models |
| `GET /run?model=<slug>` | Raw single run metadata (run id, headers, preview) |
| `GET /resume?runId=<id>&from=<n>` | Passthrough to the gateway resume endpoint |
| `GET /gw?model=<slug>` | Same probe but via the **gateway-binding** transport (`env.AI.gateway(id).run([…])`) |
| `GET /gw-matrix?models=a,b,c` | Gateway-binding probe across models |
| `GET /passthrough?model=<slug>` | **Risk #1**: feed a real `@ai-sdk/*` body through `env.AI.run` and re-parse with the same provider (`&tools=1`, `&keepModel=1`) |
| `GET /passthrough-matrix?models=a,b,c` | Passthrough probe across openai/anthropic models |

Query params: `?gateway=` (default `default`), `?prompt=`.

## Transport comparison (2026-06-14) — resume vs gateway features

The two ways to reach catalog models have **disjoint** capabilities:

| Header (response) | Run path `env.AI.run(slug, inputs)` | Gateway path `env.AI.gateway(id).run([…])` |
| --- | --- | --- |
| `cf-aig-run-id` (resume) | **present** | **absent** |
| `cf-aig-step` (server-side fallback) | absent | **present** (`0`) |
| `cf-aig-cache-status` | absent | **present** (`MISS`) |
| `cf-aig-log-id` | absent | **present** |

**Conclusion: resume and server-side fallback/caching live on different
transports.** You cannot get both in one call today. Resume (the motivation) is
run-path only. This is a Cloudflare product gap — the gateway path has
`cf-aig-log-id` (so a buffer exists), it just doesn't surface `cf-aig-run-id`.

## Verified findings (2026-06-14, gateway `default`)

Run via `wrangler dev --remote` against a live account with unified billing.
Every catalog model below was re-verified end-to-end (run + resume-from-0 +
resume-from-event-index + resume-from-byte-offset + byte comparison).

| Model | run-id? | `resume(0)` == full | `resume(mid)` == tail | `from` | replay SSE format |
| --- | --- | --- | --- | --- | --- |
| `openai/gpt-5.4` | yes | byte-exact | match | **event index** | OpenAI `chat.completion.chunk` |
| `openai/gpt-4o-mini` | yes | byte-exact | match | **event index** | OpenAI `chat.completion.chunk` |
| `anthropic/claude-sonnet-4.5` | yes | byte-exact | match | **event index** | **Anthropic native** (`event: message_start`…) |
| `anthropic/claude-haiku-4.5` | yes | byte-exact | match | **event index** | **Anthropic native** |
| `google/gemini-2.5-pro` | yes | byte-exact | match | **event index** | OpenAI-ish `choices[].delta` |
| `google/gemini-3-flash` | yes | byte-exact | match | **event index** | OpenAI-ish `choices[].delta` |
| `@cf/*` (Workers AI) | **no** | — | — | — | — (not on run API yet) |

Conclusions:

- **Resumable streaming works for dash-catalog (third-party) models on the new
  run API**, and is a no-op for Workers AI (`@cf/*`) models for now — they get
  no `cf-aig-run-id`. (Cloudflare will add `@cf/*` to the run API later.)
- **`from` is an SSE *event index*, not a byte offset.** Resuming with a byte
  offset returns 0 bytes; resuming with the event index returns exactly the tail
  of the original stream from that event. Consumers must count `\n\n`-separated
  events.
- **`resume(from=0)` reproduces the live stream byte-for-byte.**
- **The universal `/ai/run` path passes through each provider's NATIVE format,
  not a normalized one.** OpenAI replays as `chat.completion.chunk`, Anthropic
  replays as native Anthropic SSE (`event: message_start` / `content_block_delta`).
  So replay must use a provider-matched parser (the `forever-chat` "compose the
  real provider model with a custom fetch" pattern is the right design) — a
  single parser does NOT fit all. (The separate `/compat/chat/completions`
  endpoint would normalize, but the binding's `env.AI.run` uses the universal
  run path.)
- **Request params are also provider-native, not normalized.** Anthropic
  *requires* `max_tokens`; OpenAI gpt-5* *rejects* `max_tokens` and wants
  `max_completion_tokens`. The harness shapes this per provider.
- **Unified billing**: OpenAI, Google, and Anthropic all resolve with no
  provider keys configured.

Raw matrix output is saved in [`findings.json`](./findings.json).

## Request-side passthrough (2026-06-14) — the run-path delegate gate

The resume findings above prove the **response** side (native SSE, byte-exact
replay). The `/passthrough` probe (`src/passthrough.ts`) closes the **request**
side: it builds a real `@ai-sdk/*` model whose `fetch` forwards the provider's
own outgoing body to `env.AI.run(slug, body, { returnRawResponse })`, then lets
that same provider parse the response via `streamText`. This is the architecture
the `workers-ai-provider` run-path delegate will use — so if it parses cleanly,
no hand-rolled per-provider parsing or param translation is needed.

| Provider / model | text | tools | usage normalized | `cf-aig-run-id` (fetch == `result.response`) |
| --- | --- | --- | --- | --- |
| `@ai-sdk/openai` `.chat` → `openai/gpt-5.4` | ✅ 164 deltas | ✅ `tool-call`→`tool-result`→step 2 | ✅ incl. `raw` | ✅ identical |
| `@ai-sdk/anthropic` → `anthropic/claude-opus-4.7` | ✅ | — | ✅ `cache_creation`/`service_tier` | ✅ identical |

Conclusions:

- **The run-path delegate is viable.** The exact body an `@ai-sdk/*` provider
  emits is accepted as-is, and the response is consumed cleanly by the same
  provider's parser — text, tool calls, usage, finish reason.
- **`max_tokens` vs `max_completion_tokens` stops being our problem** — each
  provider emits its own correct params (the per-provider shaping the resume
  probe needs is only because it hand-builds bodies).
- **`cf-aig-run-id` is on `result.response.headers`**, so the delegate captures
  it from the parsed result — no separate channel needed.
- **Use `openai.chat()`, not bare `openai()`** — AI SDK v6 defaults the bare
  factory to the **Responses API**, which the run catalog does not serve.
- **`anthropic-version` survives** the run path (the Anthropic call 200s and
  parses — it couldn't otherwise).
- Dropping the redundant `model` field works (slug supplies it); keeping it is
  also tolerated, so the delegate's body rewrite is optional.

## Remaining risks — fallback, caching, expiry (2026-06-14)

| Risk | Probe | Verdict |
| --- | --- | --- |
| #6 server-side fallback | `/fallback?models=openai/nonexistent-model-xyz,openai/gpt-5.4` | ✅ bad model first → `cf-aig-step: 1`, `200`, real chunks streamed |
| #6 caching | `/cache?model=openai/gpt-5.4` | ⚠️ MISS/MISS — no HIT on the `default` gateway (caching not enabled, or `cf-aig-cache-ttl` must be a gateway control directive, not a per-entry header). Config-dependent, not an architecture risk. |
| #4 resume out-of-range | `/resume-info?runId=<live>&from=999999` | ✅ graceful `200` + **0 bytes** (nothing past the end), `from=0` still replays full |
| #4 invalid runId | `/resume-info?runId=000…0&from=0` | `500` `AiGatewayError` code `2002` — but an all-zeros id is *malformed*, not *expired* (see TTL sweep for the real expiry contract) |
| #4 buffer TTL | `ttl-sweep.sh` / `ttl-sweep-fine.sh` | ✅ alive at t+330s, **expired by t+360s** (TTL ≈ 330–360s, ~5.5 min); expiry contract is **`404` `{"error":"Request not found"}`** |

### Resume expiry contract (the signal §7 tiered recovery keys off)

Three distinct outcomes, each cheap to detect:

| Situation | Response |
| --- | --- |
| Live run, `from` in range | `200`, SSE tail bytes |
| Live run, `from` past end | `200`, **0 bytes** (nothing left to replay) |
| Buffer **expired** (TTL elapsed) | **`404`** `{"error":"Request not found"}` |
| **Malformed** runId | `500` `AiGatewayError` code `2002` |

So the recovery ladder branches on a clean `404`: buffer gone → fall to tier-2
(user-message continuation, §10c) or tier-3 (cold regenerate). The buffer TTL is
**≈330–360s (~5.5 min)** — coarse sweep: alive at t+180s, gone by t+420s; fine
sweep (`ttl-sweep-fine.sh`): alive at t+330s, gone by t+360s. That is the window a
Durable Object has to re-attach after eviction before a byte-exact resume is lost.

## Delegate engine validation (2026-06-14)

`src/delegate.ts` is the reference implementation of the `workers-ai-provider`
catalog-model delegate (RFC §1–§4): slug parsing, the capability matrix, transport
selection (run vs gateway), a provider-agnostic forwarding fetch, and the error
taxonomy. `/delegate` runs a real `streamText` through it and reports the chosen
transport, warnings, dispatch headers, and parsed output. All scenarios verified
live:

| Scenario | `/delegate` query | Transport | Result |
| --- | --- | --- | --- |
| Default (resume) | `model=openai/gpt-5.4` | run | `runId` present, resume on, clean parse |
| Server fallback | `…&fallback=server:openai/gpt-5.4-mini` | gateway | warns (resume off), `cf-aig-step:0`, no runId |
| **Conflict** | `…&resume=true&fallback=server:…` | — | **`400` config error** (actionable message) |
| Caching | `…&cacheTtl=3600` | gateway | warns (resume off), no runId |
| Escape hatch | `…&transport=gateway` | gateway | no warning (explicit), no runId |
| Anthropic default | `model=anthropic/claude-opus-4.7` | run | `runId` present, clean parse |
| **Real fallback step** | `model=openai/nonexistent-xyz&fallback=server:openai/gpt-5.4` | gateway | **`cf-aig-step:1`** — fallback served, parsed cleanly |

Conclusions:

- **Capability-driven transport selection works.** Resume-only options stay on the
  run path; gateway-only options (server fallback, caching) move to the gateway
  path and disable resume with a loud warning; explicit conflicts throw `400`.
- **Cross-model server fallback works end-to-end**: a bad primary falls through to
  `cf-aig-step:1` and the `@ai-sdk/*` parser consumes the fallback's response.
- **One parser, both paths.** The same `@ai-sdk/*` provider parses run-path and
  gateway-path responses — no per-path or per-provider parsing.
- The engine is **package-agnostic**: run-path provider factories are injected
  (here openai + anthropic are registered directly; in the package they come from
  `workers-ai-provider/openai` etc. as optional peer deps).

Notes:

- **Fallback is gateway-path only and carries no `cf-aig-run-id`** — exactly the
  transport split the capability matrix encodes. So `fallback: "server"` and
  `resume` are mutually exclusive in one call (RFC §2/§4).
- **Risk #5 (transport selection) premises are now empirically validated**: the
  three contended features land on disjoint transports — `cf-aig-run-id` (resume)
  on the run path only; `cf-aig-step` (server fallback) and `cf-aig-cache-status`
  (caching) on the gateway path only. The selection *logic* itself is delegate
  code, covered by construction-time + unit tests, not a live gate.
- **Risk #7 (REST/credentials-mode parity)** needs a scoped `CLOUDFLARE_API_TOKEN`
  (this account is OAuth-logged-in). Low risk: credentials mode hits the *same*
  gateway backend, differing only in the auth front door and base URL.

## Notes

- `env.AI.fetch()` is used to reach the resume endpoint. It exists at runtime
  (workerd `ai-api.ts`) but is not in the generated `Ai` type, so it's cast.
- `returnRawResponse: true` **is** in the public `AiOptions` type, but
  `workers-ai-provider` never sets it — so the provider currently can't capture
  `cf-aig-run-id`. That's the gap this harness motivates fixing.
- **Footgun:** call `env.AI.run(...)` as a *method*. Extracting it
  (`const run = env.AI.run; run(...)`) detaches `this`; the binding touches a
  private `#options` field internally and throws
  `Cannot set properties of undefined (setting '#options')`. Cast `env.AI`, not
  the bare method.
