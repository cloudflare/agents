# Models (Experimental)

`agents/models/ai-sdk` is Cloudflare's AI SDK provider. It takes two call
forms, both through the `AI` binding:

```ts
// A string runs on env.AI.run.
ai("@cf/zai-org/glm-4.7-flash"); // Workers AI
ai("anthropic/claude-opus-4.8"); // the AI Gateway catalog
ai("dynamic/support"); // a dynamic route on your gateway

// A vendor's own model goes to AI Gateway's provider-native path.
ai(anthropic("claude-opus-4-8"));
```

A string needs no vendor package and no vendor key: AI Gateway's catalog names
the model, picks the provider, converts the request, and bills through Unified
Billing or a key stored on the gateway. A model object keeps the vendor's own
request and parser, so every vendor feature its package supports works.

## The canon, in five lines

1. **A string is Cloudflare's.** `@cf/<author>/<model>` is Workers AI,
   autocompleted from `@cloudflare/workers-types`; `<author>/<model>` is the
   AI Gateway catalog, in the gateway's spelling; `dynamic/<route>` is a
   [dynamic route](#dynamic-routes). All three run on `env.AI.run`, and any
   other string is a `TypeError` naming the three forms.
2. **`ai(model)` is any AI SDK v4 model**, sent to AI Gateway's
   [provider-native path](#model-objects). Its provider builds the request,
   parses the response, and handles its own errors; only the transport is
   ours.
3. **The gateway is an option, not a product.** Caching, logging, metadata,
   timeouts and retries are options on the call; the `default` gateway is
   created for you on first use.
4. **Unified billing means no vendor key.** The gateway holds the credential:
   Cloudflare's, or a key you store on the gateway (BYOK).
5. One factory: `createAI` — text, embeddings, images, speech, transcription
   and reranking all come off it, and it is a full `ProviderV4`.

## Quick start

Requirements: `ai@^7` and `@ai-sdk/provider@^4` must both be resolvable — they
are optional peers of `agents`, so install them alongside it. Add a vendor
provider only if you want to pass that vendor's model objects:

```sh
pnpm add ai @ai-sdk/provider
pnpm add @ai-sdk/anthropic   # only for ai(anthropic("…"))
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
`reasoning_effort`, the output cap as `max_completion_tokens`, and
`chatTemplateKwargs`, which only Workers AI takes, is dropped with a warning.

A streamed answer from a model whose native format is Anthropic Messages (the
Claude models) comes back from `/run` in Anthropic events rather than chat
completions. This provider reads those events as chat completions (text,
reasoning, tool calls, finish reason and usage), so the stream looks the same
whatever model served it. `byokAlias` picks a stored key by alias; it is sent
as `cf-aig-byok-alias`, which `/run` reads.

## Model objects

A vendor's own AI SDK model goes to AI Gateway's **provider-native path**,
unchanged. `ai(model)` clones the model per call and swaps the `fetch` its
provider would have used for one that sends the same request (method,
headers, body) through the binding:

```ts
env.AI.fetch(
  `https://workers-binding.ai/ai-gateway/gateways/${gateway}/anthropic/v1/messages`,
  { method, headers, body } // the vendor's own, plus cf-aig-* gateway headers
);
```

The provider slug and path come from the request URL's host (`api.anthropic.com`
is `anthropic`, `api.openai.com` is `openai`, and so on for every gateway
provider). A host the gateway has no provider for is a `TypeError` naming it.
What comes back is the vendor's own response, parsed by the vendor's own code,
streams included. Your model object is never mutated.

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

const anthropic = createAnthropic({ apiKey: "cloudflare" }); // placeholder
const openai = createOpenAI({ apiKey: "cloudflare" });

ai(anthropic("claude-opus-4-8")); // Anthropic Messages, the vendor's own id
ai(openai("gpt-5-mini")); // OpenAI Responses
ai.routed(openai.transcription("whisper-1")); // multipart bodies travel too
```

The vendor's id is the vendor's spelling (`claude-opus-4-8`), because its
package picks capabilities from it. Gateway options travel as `cf-aig-*`
headers. A model whose provider hides its settings (one already wrapped in
middleware, or hand-written) is a `TypeError`; wrap first, then apply
middleware:

```ts
wrapLanguageModel({ model: ai(anthropic("claude-opus-4-8")), middleware });
```

### Unified billing and BYOK

The vendor's credential header (`authorization`, `x-api-key`,
`x-goog-api-key`, `api-key`) is stripped by default, so the gateway supplies
the key: Unified Billing, or a key stored on the gateway. Unified Billing needs
authentication turned on for the gateway.

To use a key you hold yourself, give it to the vendor's provider and set
`vendorKey: "request"`, which forwards the credential instead of stripping it:

```ts
const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
const model = ai(anthropic("claude-opus-4-8"), { vendorKey: "request" });
```

`vendorKey` belongs to the model it is set on. A fallback leg does not inherit
it, so a chain can mix a model on your key with one on Unified Billing.

`byokAlias` picks a stored key by alias when the gateway holds several for one
provider, and `zdr` turns Zero Data Retention on (`true`) or off (`false`) for
a Unified Billing request, whatever the gateway's own setting. On a model
object both travel as headers (`cf-aig-byok-alias`, `cf-aig-zdr`). `zdr`
applies to model objects only: `/run` does not read it.

A vendor's own error, such as a bad model id or a rejected parameter, stays the
vendor's, raised by its provider in its own error type. Only the gateway's own
failures, such as no such gateway or an unpaid account, become a
`CloudflareAIError`.

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
| `byokAlias`          | `string`                                              | A stored BYOK key, by alias. Catalog models and model objects.          |
| `zdr`                | `boolean`                                             | Zero Data Retention on or off (Unified Billing). Model objects only.    |
| `vendorKey`          | `"gateway" \| "request"`                              | Model objects only: forward the vendor key on the request. Per model.   |
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
const model = ai(anthropic("claude-opus-4-8"), {
  fallback: ["openai/gpt-5.5", "@cf/zai-org/glm-4.7-flash"]
});
```

A model object in a chain is routed like `ai(model)`, through the
provider-native path, so a chain can mix catalog ids, Workers AI and a vendor's
own models.

A leg travels with the chain's gateway options: the chain's `id`, `cacheTtl`
and the rest win over a leg's own, `metadata` merges field by field, and
everything else a leg was built with — its `headers`, its Workers AI knobs —
stays the leg's, and so does its `vendorKey`. A leg written as a string follows the same rule as `ai("…")`:
anything that is not one of the three id forms is the same `TypeError`,
whether it was written on the model or per call under
`providerOptions.cloudflare`.

`providerMetadata.cloudflare.model` reports the model that actually answered.
When every leg fails, the thrown `CloudflareAIError` carries an `attempts`
array of `{ model, error }` and the last error as its `cause`.

This loop runs across models. Within one catalog model, `/run` already retries
across that model's providers, and a [dynamic route](#dynamic-routes) runs its
own fallback on the gateway.

## Stream resume

A streamed answer from AI Gateway's `/run` (a catalog model or a dynamic
route) carries `cf-aig-run-id`, and the gateway keeps every event of the run.
If the connection drops mid-stream, the provider reconnects through the
binding and replays the run from the last complete event, so the stream you
read continues with nothing lost or repeated. There is nothing to configure:

```ts
const result = streamText({ model: ai("anthropic/claude-opus-4.8"), prompt });
// A dropped connection is resumed; result.textStream just keeps going.
```

The run keeps going on the gateway after the connection is gone, so a resume
continues the same answer rather than starting a new one. It gives up, with a
`CloudflareAIError`, after five drops in one stream or once the gateway no
longer holds the run (a few minutes after it ends). Aborting the call never
resumes. The run id is in `providerMetadata.cloudflare.runId`.

Workers AI `@cf/` streams and model objects on the provider-native path have
no run id, so they are not resumed.

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

| Field         | Source header         | Notes                                          |
| ------------- | --------------------- | ---------------------------------------------- |
| `model`       | —                     | The leg that answered, after any fallback.     |
| `gateway`     | —                     | The gateway id the request went through.       |
| `provider`    | —                     | The gateway provider slug, for a model object. |
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

On a model object this covers the gateway's own failures; a vendor's own error
is raised by that vendor's provider in its own error type.

## Experimental

This module is experimental. The surface may change in a minor release, and
every exported symbol is tagged `@experimental`. It ships from `agents` first;
the plan is for `cloudflare/ai` to re-export it and deprecate the older
`workers-ai-provider` / `ai-gateway-provider` packages.

## See also

- [Models for pi-ai](./models-pi-ai.md) — the same factory for pi-ai and pi-durable
- [Cloudflare model catalog](https://developers.cloudflare.com/ai/models/)
- [Worker binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
