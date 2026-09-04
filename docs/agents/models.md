# Models (Experimental)

`agents/models/ai-sdk` is Cloudflare's AI SDK provider. One rule decides
everything in it:

> **Workers AI is the one catalog we keep up with. Every other vendor brings
> its own provider, and we route it.**

So there are two call forms, and no third:

```ts
ai("@cf/zai-org/glm-4.7-flash"); // Workers AI — our model, our compat layer
ai(anthropic("claude-opus-4-8")); // the vendor's model, our transport
```

No vendor ids, wire formats, thinking rules or model metadata live in this
package, and `agents` takes no vendor package as a dependency — not even an
optional one. You build the model with the vendor's own `@ai-sdk/*` provider;
we hand its request to AI Gateway and hand the answer straight back to it.

## The canon, in five lines

1. **`ai(string)` is a Workers AI id.** `@cf/<author>/<model>`, autocompleted
   from `@cloudflare/workers-types`. Any other string is a `TypeError` that
   tells you which provider package to install.
2. **`ai(model)` is any AI SDK v4 model**, routed through AI Gateway. Its
   provider builds the request, parses the response, and handles its own
   errors; only the transport is ours.
3. **The gateway is an option, not a product.** Caching, logging, metadata,
   timeouts and retries are options on the call; the `default` gateway is
   created for you on first use.
4. **Unified billing means no vendor key.** Anthropic and OpenAI answer with a
   placeholder key today; anything else needs a key stored on the gateway
   (BYOK).
5. One factory: `createAI` — text, embeddings, images, speech, transcription
   and reranking all come off it, and it is a full `ProviderV4`.

## Quick start

Requirements: `ai@^7` and `@ai-sdk/provider@^4` must both be resolvable — they
are optional peers of `agents`, so install them alongside it. Add a vendor
provider only if you want that vendor:

```sh
pnpm add ai @ai-sdk/provider
pnpm add @ai-sdk/anthropic   # only if you call Anthropic
```

```ts
import { createAI } from "agents/models/ai-sdk";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

export default {
  async fetch(request: Request, env: Env) {
    // Inside a Worker: keyless, using the AI binding.
    const ai = createAI({ binding: env.AI, id: "default", cacheTtl: 60 });

    // The gateway holds the real key, so this one is a placeholder.
    const anthropic = createAnthropic({ apiKey: "cloudflare" });

    const workersAI = await generateText({
      model: ai("@cf/zai-org/glm-4.7-flash"),
      prompt: "Say hello in three words"
    });

    const vendor = await generateText({
      model: ai(anthropic("claude-opus-4-8")),
      prompt: "Say hello in three words"
    });

    return Response.json({ workersAI: workersAI.text, vendor: vendor.text });
  }
};
```

Your `wrangler.jsonc` needs the binding:

```jsonc
{
  "ai": { "binding": "AI" }
}
```

Streaming, tools, and structured output are ordinary AI SDK calls, on either
form:

```ts
const result = streamText({
  model: ai(anthropic("claude-opus-4-8")),
  prompt: "Write a haiku about durable objects"
});
return result.toTextStreamResponse();
```

Embeddings come from the same provider:

```ts
import { embedMany } from "ai";

const { embeddings } = await embedMany({
  model: ai.embedding("@cf/baai/bge-base-en-v1.5"),
  values: ["hello", "world"]
});
```

## Registry and default provider

`createAI` returns a full `ProviderV4`, so it drops into both places the AI SDK
resolves a model from a string alone:

```ts
import { createProviderRegistry, generateText } from "ai";

// A registry: `cloudflare:` names this provider.
const registry = createProviderRegistry({ cloudflare: ai });
await generateText({
  model: registry.languageModel("cloudflare:@cf/zai-org/glm-4.7-flash"),
  prompt: "Hi"
});

// Or install it globally: bare strings then resolve through this provider.
globalThis.AI_SDK_DEFAULT_PROVIDER = createAI({ binding: env.AI });
await generateText({ model: "@cf/zai-org/glm-4.7-flash", prompt: "Hi" });
```

The string rule does not change in either place: a specifier is a `@cf/` id, so
a vendor model is still a model object (`ai(anthropic("claude-opus-4-8"))`) and
cannot be reached by a bare string.

Every modality is on the registry too (`registry.imageModel`,
`registry.textEmbeddingModel`, and so on), because each `ProviderV4` method is
implemented. The default provider is process-wide: set it once, where you build
the Worker's `env`-dependent state.

## Why a model object and not an id

An id is only useful if someone keeps its catalog current. We keep exactly one:
Workers AI. Every other vendor already ships a maintained catalog inside its
own `@ai-sdk/*` package — ids, wire format, thinking levels, tool shapes, error
types — and that package is updated the day the vendor ships something. Copying
any of it here would mean a second, slower copy that is wrong every time a
vendor moves.

So `ai(model)` takes what the vendor built, clones it per call, swaps the
`fetch` its provider would have used, and sends the very same bytes to AI
Gateway. What comes back is the vendor's own response, parsed by the vendor's
own code. Your model object is never mutated — two concurrent calls never see
each other's transport.

```ts
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({ apiKey: "cloudflare" });

ai(openai.responses("gpt-5-mini")); // OpenAI Responses API, routed
ai(anthropic("claude-opus-4-8")); // Anthropic Messages API, routed
```

Passing a third-party id as a string is an error, on purpose:

```ts
ai("anthropic/claude-opus-4-8");
// TypeError: "anthropic/claude-opus-4-8" is not a Workers AI model id.
// Workers AI ids start with "@cf/" … install @ai-sdk/anthropic and pass the
// model object: ai(anthropic("claude-opus-4-8")).
```

A model whose provider hides its settings — one already wrapped in middleware,
or hand-written — is an error too. Wrap first, then apply middleware:

```ts
wrapLanguageModel({ model: ai(anthropic("claude-opus-4-8")), middleware });
```

## The universal gateway request

A routed vendor model does not go down the Workers AI run path. It goes through
AI Gateway's **universal request**, which carries the vendor's own body
untouched:

```ts
env.AI.gateway(gatewayId).run(
  { provider: "anthropic", endpoint: "v1/messages", headers, query },
  { gateway: { cacheTtl, skipCache, metadata, … }, extraHeaders, signal }
);
```

- `provider` comes from the request URL's host (`api.anthropic.com` →
  `anthropic`, `api.openai.com` → `openai`, and so on for every gateway
  provider). A host the gateway has no provider for is a `TypeError` naming it.
- `endpoint` is the path after the host (`v1/messages`, `v1/responses`).
- `query` is the vendor's JSON body, verbatim — including its own model id, in
  the vendor's own spelling. `claude-opus-4.8` gets a 404 from Anthropic
  ("Did you mean claude-opus-4-8?"), because we do not rewrite ids.
- The vendor's credential header (`authorization`, `x-api-key`,
  `x-goog-api-key`, `api-key`) is stripped; its protocol headers
  (`anthropic-version`, `anthropic-beta`, …) travel.
- `stream: true` comes back as the vendor's own SSE. The gateway adds a small
  `"p"` padding field to each data event, which every vendor parser ignores.

The universal request carries **JSON only**. A multipart body (a file upload,
an audio transcription posted as `FormData`) cannot be expressed in it and
raises a `TypeError` rather than being silently mangled.

## Unified billing and BYOK

Whether a vendor answers without a key of yours is the gateway's business, not
this package's:

- **Unified billing** covers Anthropic and OpenAI today: a placeholder
  `apiKey` is enough, and Cloudflare bills you.
- **Everything else needs BYOK** — a provider key stored on the gateway. Google
  AI Studio without one answers `403 "Method doesn't allow unregistered callers"`,
  and that error is surfaced to you exactly as Google wrote it, because Google's
  provider is the one that knows how to read it.

Only the gateway's _own_ failures — no such gateway, an unpaid account — become
a `CloudflareAIError`. A vendor error stays the vendor's.

## Other modalities

Images, speech, transcription and reranking come off the same provider, the
same Workers AI catalog, and the same options. Each has a short name and the
`ProviderV4` alias (`ai.image` / `ai.imageModel`, and so on).

```ts
import { generateImage, generateSpeech, rerank, transcribe } from "ai";

const { image } = await generateImage({
  model: ai.image("@cf/black-forest-labs/flux-1-schnell"),
  prompt: "A cyberpunk lizard"
});

const { audio } = await generateSpeech({
  model: ai.speech("@cf/deepgram/aura-1"),
  text: "Hello from Cloudflare."
});

const { text } = await transcribe({
  model: ai.transcription("@cf/openai/whisper-large-v3-turbo"),
  audio: audio.uint8Array
});

const { rerankedDocuments } = await rerank({
  model: ai.reranking("@cf/baai/bge-reranker-base"),
  documents: ["a cyberpunk lizard", "a rainy Tuesday"],
  query: "Which one is cooler?"
});
```

A vendor's own embedding, image, speech or transcription model can be routed
too, with `ai.routed(model)`: the same `fetch` swap, the same gateway options,
and `providerMetadata.cloudflare` on the result.

`ai.routed` takes the gateway options, `headers` and `sessionAffinity` — and
those only. `fallback` is not among them (a leg for one of those modalities
would have to be another vendor's model, which this provider cannot build), and
neither are `reasoningEffort` and `chatTemplateKwargs`, which are Workers AI
settings; passing one is a compile error rather than a silent drop. Sent per
call under `providerOptions.cloudflare` instead, the two Workers AI knobs come
back in the result's `warnings`.

Bytes stay bytes and base64 stays base64: some models answer with a raw body
(`image/png`, `audio/mpeg`, `audio/wav`) and some with JSON (`{ image }`,
`{ audio }`), the content type decides, and nothing is converted on the way
through. The media type comes off the bytes rather than the model name —
`flux-1-schnell` answers with JPEG and MeloTTS with WAV.

Per-call knobs go under `providerOptions.cloudflare`, next to the gateway
options:

| Modality      | Call options used                                                                       | `providerOptions.cloudflare`                               |
| ------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Image         | `prompt`, `n`, `size`, `seed`, `files`, `mask`                                          | `steps`, `guidance`, `negativePrompt`, `strength`          |
| Speech        | `text`, `voice` → `speaker`, `outputFormat` → `encoding`, `language` → `lang` (MeloTTS) | —                                                          |
| Transcription | `audio`, `mediaType`                                                                    | `language`, `task`, `initialPrompt`, `prefix`, `vadFilter` |
| Reranking     | `query`, `documents`, `topN` → `top_k`                                                  | —                                                          |

Anything a model cannot take comes back in `warnings` rather than being sent:
`aspectRatio` everywhere, `size`/`seed`/`guidance` on `flux-1-schnell` (which
takes only a prompt and steps), `speed` and `instructions` on every speech
model, `voice` on MeloTTS. Object documents are stringified for reranking, with
a `compatibility` warning.

The run path generates one image per call, so `maxImagesPerCall` is 1 and
`generateImage` fans a larger `n` out into parallel calls.

`@cf/deepgram/nova-3` and `@cf/deepgram/flux` are not supported: they want the
audio as an object body (`audio: { body, contentType }`) that the JSON run path
cannot carry, and every documented encoding of it answers `400` live. They
throw a `CloudflareAIError` before any request is made, pointing at
`@cf/openai/whisper-large-v3-turbo`.

## Options

Options can be set in three places, on both call forms. Precedence is
per-call > per-model > provider.

```ts
// Provider-wide
const ai = createAI({ binding: env.AI, id: "prod", metadata: { app: "demo" } });

// Per model
const model = ai(anthropic("claude-opus-4-8"), { cacheTtl: 3600 });

// Per call
await generateText({
  model,
  prompt: "hi",
  providerOptions: {
    cloudflare: { skipCache: true, metadata: { userId: "u1" } }
  }
});
```

| Option               | Type                                                  | What it does                                                            |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `id`                 | `string`                                              | Gateway id. Defaults to `"default"`, created on first use.              |
| `gateway`            | `string \| GatewayOptions`                            | The same options nested, if you prefer that spelling.                   |
| `skipCache`          | `boolean`                                             | Bypass the gateway cache for this request.                              |
| `cacheTtl`           | `number`                                              | Cache lifetime in seconds.                                              |
| `cacheKey`           | `string`                                              | Explicit cache key instead of the request-derived one.                  |
| `collectLog`         | `boolean`                                             | Whether the gateway stores the request/response in its log.             |
| `metadata`           | `Record<string, string \| number \| boolean \| null>` | Key/values attached to the gateway log entry.                           |
| `eventId`            | `string`                                              | Correlates several requests into one gateway event.                     |
| `requestTimeoutMs`   | `number`                                              | Upstream request timeout.                                               |
| `retries`            | `{ maxAttempts, retryDelayMs, backoff }`              | Server-side retry policy for the upstream provider call.                |
| `fallback`           | `(WorkersAIModelId \| LanguageModelV4)[]`             | Models to try, in order, if the primary fails before producing output.  |
| `headers`            | `Record<string, string>`                              | Extra request headers, merged last.                                     |
| `sessionAffinity`    | `string`                                              | Pin same-key requests to one replica for prefix-cache hits.             |
| `reasoningEffort`    | `"low" \| "medium" \| "high" \| null`                 | Workers AI only: explicit effort; `null` turns reasoning off.           |
| `chatTemplateKwargs` | `Record<string, unknown>`                             | Workers AI only: forwarded verbatim, e.g. `{ enable_thinking: false }`. |

The flat gateway keys are sugar: `{ cacheTtl: 60 }` and
`{ gateway: { cacheTtl: 60 } }` mean the same thing, and both merge with the
layers above and below them (`metadata`, `retries` and `headers` merge field by
field).

`fallback` takes model objects only on the language forms. On the modality
methods (`ai.embedding`, `ai.image`, `ai.speech`, `ai.transcription`,
`ai.reranking`) a leg is a Workers AI id, because those run on the Workers AI
run path, which resolves a leg by id and nothing else.

`reasoningEffort` and `chatTemplateKwargs` are Workers AI settings. On a routed
vendor model, reasoning is the vendor's own call option — use the AI SDK's
unified `reasoning`, or that provider's `providerOptions`, and the vendor's
rules apply because the vendor's code is what runs.

### `providerOptions.cloudflare`

Anything in the table above can be passed per call under the `cloudflare` key.
It is read for gateway options and then **removed** before the call reaches a
routed vendor model, so the vendor never sees a key it does not understand:

```ts
await generateText({
  model: ai(anthropic("claude-opus-4-8")),
  prompt: "hi",
  providerOptions: {
    anthropic: { sendReasoning: true },
    cloudflare: { metadata: { userId: "u1" }, skipCache: true, cacheTtl: 300 }
  }
});
```

## Fallback

`fallback` tries each leg in order when the primary fails _before_ producing
any output. Mid-stream failures are not retried — by then the caller already
has part of an answer. Legs may be Workers AI ids or model objects, in any mix:

```ts
const model = ai(anthropic("claude-opus-4-8"), {
  fallback: [ai("@cf/zai-org/glm-4.7-flash")]
});
```

A leg travels with the chain's gateway options: the chain's `id`, `cacheTtl`
and the rest win over a leg's own, `metadata` merges field by field, and
everything else a leg was built with — its `headers`, its Workers AI knobs —
stays the leg's. Legs written as strings are Workers AI ids, in a chain exactly
as in `ai("…")`: a vendor id there is the same `TypeError`, whether it was
written on the model or per call under `providerOptions.cloudflare`.

`providerMetadata.cloudflare.model` reports the model that actually answered.
When every leg fails, the thrown `CloudflareAIError` carries an `attempts`
array of `{ model, error }` and the last error as its `cause`.

This is a client-side loop today. AI Gateway also accepts an **array** of
universal requests as a server-side fallback chain; when we adopt it, the
option shape will not change.

## How Workers AI stays OpenAI-shaped

Every `@cf/...` model answers in the OpenAI chat-completions shape, but the run
path adds a few things of its own: a per-chunk usage on every streamed delta, a
`choices: []` heartbeat, a native `{ response: "", usage }` tail with the
cumulative usage, reasoning under either `reasoning` or `reasoning_content`, and
a handful of per-family limits (one family cannot turn reasoning off, another
rejects `response_format`, one older id rejects `tool_choice: "required"`, one
wants nine-character tool-call ids, one streams its answer labelled as reasoning
once thinking is off).

None of that reaches this provider's parsers. A framework-neutral compat layer
in the package core rewrites a strict OpenAI request into what the model accepts
and normalizes responses and streams back into strict OpenAI chunks, keyed by
model family from live conformance captures. The same layer serves the
[pi-ai provider](./models-pi-ai.md), so both frameworks see one behaviour. Where
a feature had to be dropped or changed, the call's `warnings` say so (for
example `reasoning-off` or `tool-choice-required`). A new Workers AI model that
is conformant needs no entry at all.

## Observability: `providerMetadata.cloudflare`

Every result and every stream `finish` part carries typed gateway metadata, so
you never have to walk response objects looking for a log id. On a routed
vendor model it is merged alongside the vendor's own metadata block rather than
replacing it:

```ts
const { providerMetadata } = await generateText({
  model: ai(anthropic("claude-opus-4-8")),
  prompt: "hi"
});

providerMetadata?.cloudflare;
// {
//   model: "claude-opus-4-8",
//   provider: "anthropic",
//   gateway: "prod",
//   logId: "01M1KZWN069WWNPC18V05NKHSS",
//   eventId: "7bfd3660-9d0f-4bf7-bf9b-fa90b860456f",
//   requestId: "7bfd3660-9d0f-4bf7-bf9b-fa90b860456f",
//   traceId: "2babd9bbb1984dfc90417e513c60a714",
//   cacheStatus: "MISS",
//   step: 0
// }
providerMetadata?.anthropic; // still Anthropic's own
```

| Field         | Source header         | Notes                                          |
| ------------- | --------------------- | ---------------------------------------------- |
| `model`       | —                     | The leg that answered, after any fallback.     |
| `gateway`     | —                     | The gateway id the request went through.       |
| `provider`    | —                     | The gateway provider slug, for a routed model. |
| `logId`       | `cf-aig-log-id`       | Falls back to the binding's last log id.       |
| `eventId`     | `cf-aig-event-id`     | Correlates the requests of one gateway event.  |
| `requestId`   | `cf-aig-request-id`   | The gateway's id for this request.             |
| `traceId`     | `cf-aig-trace-id`     | The trace this request belongs to.             |
| `runId`       | `cf-aig-run-id`       | Present only when the gateway sends one.       |
| `cacheStatus` | `cf-aig-cache-status` | `HIT` / `MISS`.                                |
| `step`        | `cf-aig-step`         | Which step of a gateway route answered.        |

Every field except `model` and `gateway` is optional, and which ones arrive
depends on the path and the call. Read the fields you find rather than assuming
any particular one is there. `response.headers` and `response.modelId` are
populated too.

## Errors

Failures throw `CloudflareAIError`, which extends the AI SDK's `APICallError`,
so `ai`'s built-in retry loop honours `isRetryable` without extra wiring.

```ts
import { CloudflareAIError } from "agents/models/ai-sdk";

try {
  await generateText({ model: ai("@cf/zai-org/glm-4.7-flash"), prompt: "hi" });
} catch (error) {
  if (error instanceof CloudflareAIError) {
    error.status; // 402
    error.code; // "gateway-error"
    error.logId; // for the gateway log
    error.model; // which model failed
    error.attempts; // every fallback leg, when there was a chain
  }
}
```

`code` is one of `"auth"`, `"rate-limit"`, `"not-found"`, `"bad-request"`,
`"provider-error"`, `"gateway-error"`, `"unknown"`.

On a routed vendor model this covers the gateway's own failures. A vendor's own
error — a bad model id, a rejected parameter, a rate limit — is raised by that
vendor's provider in its own error type, because it is the code that knows how
to read it.

## Experimental

This module is experimental. The surface may change in a minor release, and
every exported symbol is tagged `@experimental`. It ships from `agents` first;
the plan is for `cloudflare/ai` to re-export it and deprecate the older
`workers-ai-provider` / `ai-gateway-provider` packages.

## See also

- [Models for pi-ai](./models-pi-ai.md) — the same factory for pi-ai, pi-agent-core and Flue
- [Cloudflare model catalog](https://developers.cloudflare.com/ai/models/)
- [Worker binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
