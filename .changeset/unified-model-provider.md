---
"agents": minor
---

Add experimental `agents/models/ai-sdk` and `agents/models/pi-ai`: one `createAI`
factory per framework, over the Workers AI binding and AI Gateway.

One rule decides where a model comes from. Workers AI is the catalog this
package keeps up with, so a string is a `@cf/<author>/<model>` id and runs
through `env.AI.run` with a compat layer that maps Workers AI onto strict
OpenAI chat completions. Every other vendor brings its own code — an
`@ai-sdk/*` provider you install, or a pi-ai registry you import — and
`ai(model)` only routes it, through `env.AI.gateway(id).run` with the vendor's
own body and headers untouched. No vendor ids, wire formats, thinking rules or
model metadata live in `agents`, and no vendor package is a dependency or peer.

```ts
const ai = createAI({ binding: env.AI, id: "prod", cacheTtl: 60 });
const anthropic = createAnthropic({ apiKey: "cloudflare" });

generateText({ model: ai("@cf/zai-org/glm-4.7-flash") });
generateText({ model: ai(anthropic("claude-opus-4-8")) });
```

AI Gateway holds the vendor credential — unified billing, or a key you store on
the gateway — so nothing vendor-shaped needs a secret in your Worker. The
gateway is an option rather than a separate product: caching, logging,
metadata, timeouts, retries and client-side model fallback are options on
`createAI`, on the model, or on the call (`providerOptions.cloudflare`), flat
or nested under `gateway`. `createAI` takes `{ binding }` and nothing else:
both paths are the AI binding, so there is no HTTP transport and no API token.

Every modality the run path serves comes off the same provider: `ai(id)` for
text, plus `ai.embedding(id)`, `ai.image(id)`, `ai.transcription(id)`,
`ai.speech(id)` and `ai.reranking(id)`, each with its `ProviderV4` alias
(`imageModel`, `transcriptionModel`, `speechModel`, `rerankingModel`). Results
carry typed observability under `providerMetadata.cloudflare` (gateway id, log
id, event id, cache status, upstream provider), so consumers no longer walk
response objects for an AI Gateway log id, and Cloudflare's own failures throw
a `CloudflareAIError` that extends the AI SDK's `APICallError`. A vendor's own
error stays in that vendor's error type, raised by the code that knows how to
read it.

`agents/models/ai-sdk` needs `ai@^7` and `@ai-sdk/provider@^4` (both optional
peers): it returns `LanguageModelV4`/`EmbeddingModelV4`/`ImageModelV4`/
`TranscriptionModelV4`/`SpeechModelV4`/`RerankingModelV4`, which `ai@6` cannot
consume. The returned provider is a full `ProviderV4`, so it drops into
`createProviderRegistry` and into `globalThis.AI_SDK_DEFAULT_PROVIDER`.

`agents/models/pi-ai` is the pi-ai equivalent, not a layer over the AI SDK one:
both sit on a small framework-neutral core (binding transport, gateway options,
Workers AI ids) and each is tree-shaken on its own, so importing one never
pulls the other framework in. It needs `@earendil-works/pi-ai@>=0.80` (optional
peer). The instance carries `stream`/`complete`, a `streamFn` for
pi-agent-core's `Agent`, a `provider` for pi-ai `Models` registries, and
`images`. Because pi ships a generated Cloudflare AI Gateway registry, that
module also resolves `ai("anthropic/claude-opus-4-8")` from pi's own catalog —
pi's knowledge, not ours.

The surface is experimental and may change in a minor release.
