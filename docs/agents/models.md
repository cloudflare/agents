# Models (Experimental)

`agents/models/ai-sdk` is Cloudflare's AI SDK provider. Every model is a
string, and every string runs on one method — `env.AI.run`:

```ts
ai("@cf/zai-org/glm-4.7-flash"); // Workers AI
ai("anthropic/claude-opus-4.8"); // the AI Gateway catalog
ai("dynamic/support"); // a dynamic route on your gateway
```

There is no vendor package to install and no vendor key to hold. AI Gateway's
catalog names the model, picks the provider, converts the request, and bills
through Unified Billing or a key stored on the gateway. Every model speaks
chat completions, so one request builder and one parser serve them all.

## The canon, in five lines

1. **A model is a string.** `@cf/<author>/<model>` is Workers AI,
   autocompleted from `@cloudflare/workers-types`; `<author>/<model>` is the
   AI Gateway catalog, in the gateway's spelling; `dynamic/<route>` is a
   [dynamic route](#dynamic-routes). Any other string is a `TypeError` naming
   the three forms.
2. **One method.** Every string runs on `env.AI.run`. A Workers AI id goes to
   Workers AI; a catalog id or a route goes to AI Gateway's `/run`.
3. **The gateway is an option, not a product.** Caching, logging, metadata,
   timeouts and retries are options on the call; the `default` gateway is
   created for you on first use.
4. **Unified billing means no vendor key.** The gateway holds the credential —
   Cloudflare's, or a key you store on the gateway (BYOK).
5. One factory: `createAI` — text, embeddings, images, speech, transcription
   and reranking all come off it, and it is a full `ProviderV4`.

## Quick start

Requirements: `ai@^7` and `@ai-sdk/provider@^4` must both be resolvable — they
are optional peers of `agents`, so install them alongside it:

```sh
pnpm add ai @ai-sdk/provider
```

```ts
import { createAI } from "agents/models/ai-sdk";
import { generateText } from "ai";

export default {
  async fetch(request: Request, env: Env) {
    // Inside a Worker: keyless, using the AI binding.
    const ai = createAI({ binding: env.AI, id: "default", cacheTtl: 60 });

    const workersAI = await generateText({
      model: ai("@cf/zai-org/glm-4.7-flash"),
      prompt: "Say hello in three words"
    });

    const claude = await generateText({
      model: ai("anthropic/claude-opus-4.8"),
      prompt: "Say hello in three words"
    });

    return Response.json({ workersAI: workersAI.text, claude: claude.text });
  }
};
```

Your `wrangler.jsonc` needs the binding:

```jsonc
{
  "ai": { "binding": "AI" }
}
```

Streaming, tools, and structured output are ordinary AI SDK calls, on every
form:

```ts
const result = streamText({
  model: ai("openai/gpt-5.5"),
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
  model: registry.languageModel("cloudflare:anthropic/claude-opus-4.8"),
  prompt: "Hi"
});

// Or install it globally: bare strings then resolve through this provider.
globalThis.AI_SDK_DEFAULT_PROVIDER = createAI({ binding: env.AI });
await generateText({ model: "@cf/zai-org/glm-4.7-flash", prompt: "Hi" });
```

Every modality is on the registry too (`registry.imageModel`,
`registry.textEmbeddingModel`, and so on), because each `ProviderV4` method is
implemented. The default provider is process-wide: set it once, where you build
the Worker's `env`-dependent state.

## Catalog models

A catalog id is `<author>/<model>` in the
[AI Gateway catalog](https://developers.cloudflare.com/ai/models/)'s own
spelling — `anthropic/claude-opus-4.8`, `openai/gpt-5.5`, `cloudflare/auto`. The spelling is the gateway's, not the vendor's:
`anthropic/claude-opus-4.8`, not `claude-opus-4-8`.

The request goes through `env.AI.run(id, body, { gateway, openaiEndpoint })`
to AI Gateway's `/run`. The body is chat completions and the answer comes back
as chat completions, whichever provider served it: `/run` converts to and from
the provider's format. The gateway owns the rest:

- **Credentials.** Unified Billing bills the model to your Cloudflare account,
  so there is no vendor key. A provider key stored on the gateway (BYOK) is
  used instead when one is configured.
- **Providers.** A catalog model can have several providers behind it; `/run`
  picks one and retries across them.
- **Errors.** A failure — an unknown model, an unpaid account, an upstream
  error — comes back as a `CloudflareAIError`, the same type as a Workers AI
  failure.

The request is built as strict OpenAI. `reasoningEffort` travels as
`reasoning_effort`; `chatTemplateKwargs`, which only Workers AI takes, is
dropped with a warning.

## Dynamic routes

An [AI Gateway dynamic route](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)
is called by name, as `dynamic/<route>`. The route configured on the gateway
picks the model (conditions, percentages, rate and budget limits, its own
fallbacks), and the call goes through `env.AI.run` like a Workers AI model:

```ts
const ai = createAI({ binding: env.AI, id: "prod" });

await generateText({ model: ai("dynamic/support"), prompt: "Hi" });
ai("@cf/zai-org/glm-4.7-flash", { fallback: ["dynamic/support"] });
```

The route belongs to a gateway, so set the gateway `id` it was created on. It
answers in the OpenAI chat-completions shape whatever model served it, so the
request is built as strict OpenAI: `chatTemplateKwargs` is dropped with a
warning, because the route may not land on Workers AI. A dynamic route is a
language model only, and the modality methods refuse it, including as a
fallback leg.

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

Options can be set in three places. Precedence is per-call > per-model >
provider.

```ts
// Provider-wide
const ai = createAI({ binding: env.AI, id: "prod", metadata: { app: "demo" } });

// Per model
const model = ai("anthropic/claude-opus-4.8", { cacheTtl: 3600 });

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
| `fallback`           | `(CloudflareLanguageModelId \| LanguageModelV4)[]`    | Models to try, in order, if the primary fails before producing output.  |
| `headers`            | `Record<string, string>`                              | Extra request headers, merged last.                                     |
| `sessionAffinity`    | `string`                                              | Pin same-key requests to one replica for prefix-cache hits.             |
| `reasoningEffort`    | `"low" \| "medium" \| "high" \| null`                 | Workers AI only: explicit effort; `null` turns reasoning off.           |
| `chatTemplateKwargs` | `Record<string, unknown>`                             | Workers AI only: forwarded verbatim, e.g. `{ enable_thinking: false }`. |

The flat gateway keys are sugar: `{ cacheTtl: 60 }` and
`{ gateway: { cacheTtl: 60 } }` mean the same thing, and both merge with the
layers above and below them (`metadata`, `retries` and `headers` merge field by
field).

`fallback` takes model objects only on language models. On the modality
methods (`ai.embedding`, `ai.image`, `ai.speech`, `ai.transcription`,
`ai.reranking`) a leg is a Workers AI id, because those run on the Workers AI
run path, which resolves a leg by id and nothing else.

`reasoningEffort` maps onto `reasoning_effort` for every model, and the AI
SDK's unified `reasoning` call option maps onto it when it is not set.
`chatTemplateKwargs` is a Workers AI setting: a catalog model or a dynamic
route drops it with a warning.

### `providerOptions.cloudflare`

Anything in the table above can be passed per call under the `cloudflare` key:

```ts
await generateText({
  model: ai("anthropic/claude-opus-4.8"),
  prompt: "hi",
  providerOptions: {
    cloudflare: { metadata: { userId: "u1" }, skipCache: true, cacheTtl: 300 }
  }
});
```

## Fallback

`fallback` tries each leg in order when the primary fails _before_ producing
any output. That covers a rejected request and also a stream that opens and
then fails before its first output part — an `error` part, an error finish, or
a broken body — in which case the failed leg's preamble is dropped and the
answering leg's stream is delivered in its place. Once a leg has produced
output it is the answer, failures and all: by then the caller already has part
of it. A leg is any model id, or any AI SDK language model:

```ts
const model = ai("anthropic/claude-opus-4.8", {
  fallback: ["openai/gpt-5.5", "@cf/zai-org/glm-4.7-flash"]
});
```

A model object from another provider is called as it is — it reaches its own
API, not AI Gateway — so a chain can end on a model you host elsewhere.

A leg travels with the chain's gateway options: the chain's `id`, `cacheTtl`
and the rest win over a leg's own, `metadata` merges field by field, and
everything else a leg was built with — its `headers`, its Workers AI knobs —
stays the leg's. A leg written as a string follows the same rule as `ai("…")`:
anything that is not one of the three id forms is the same `TypeError`,
whether it was written on the model or per call under
`providerOptions.cloudflare`.

`providerMetadata.cloudflare.model` reports the model that actually answered.
When every leg fails, the thrown `CloudflareAIError` carries an `attempts`
array of `{ model, error }` and the last error as its `cause`.

This loop runs across models. Within one catalog model, `/run` already retries
across that model's providers, and a [dynamic route](#dynamic-routes) runs its
own fallback on the gateway.

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
you never have to walk response objects looking for a log id:

```ts
const { providerMetadata } = await generateText({
  model: ai("anthropic/claude-opus-4.8"),
  prompt: "hi"
});

providerMetadata?.cloudflare;
// {
//   model: "anthropic/claude-opus-4.8",
//   gateway: "prod",
//   logId: "01M1KZWN069WWNPC18V05NKHSS",
//   eventId: "7bfd3660-9d0f-4bf7-bf9b-fa90b860456f",
//   requestId: "7bfd3660-9d0f-4bf7-bf9b-fa90b860456f",
//   traceId: "2babd9bbb1984dfc90417e513c60a714",
//   cacheStatus: "MISS",
//   step: 0
// }
```

| Field         | Source header         | Notes                                         |
| ------------- | --------------------- | --------------------------------------------- |
| `model`       | —                     | The leg that answered, after any fallback.    |
| `gateway`     | —                     | The gateway id the request went through.      |
| `logId`       | `cf-aig-log-id`       | Falls back to the binding's last log id.      |
| `eventId`     | `cf-aig-event-id`     | Correlates the requests of one gateway event. |
| `requestId`   | `cf-aig-request-id`   | The gateway's id for this request.            |
| `traceId`     | `cf-aig-trace-id`     | The trace this request belongs to.            |
| `runId`       | `cf-aig-run-id`       | Present only when the gateway sends one.      |
| `cacheStatus` | `cf-aig-cache-status` | `HIT` / `MISS`.                               |
| `step`        | `cf-aig-step`         | Which step of a gateway route answered.       |

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

## Experimental

This module is experimental. The surface may change in a minor release, and
every exported symbol is tagged `@experimental`. It ships from `agents` first;
the plan is for `cloudflare/ai` to re-export it and deprecate the older
`workers-ai-provider` / `ai-gateway-provider` packages.

## See also

- [Models for pi-ai](./models-pi-ai.md) — the same factory for pi-ai and pi-durable
- [Cloudflare model catalog](https://developers.cloudflare.com/ai/models/)
- [Worker binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
