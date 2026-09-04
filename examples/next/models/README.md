# Next: models

The experimental `createAI` factories, `agents/models/ai-sdk` and
`agents/models/pi-ai`, driven from a plain Worker. Same rule, same routes, one
per framework.

## The rule in five lines

1. Workers AI is the one catalog this package keeps up with, so a string is a
   `@cf/<author>/<model>` id and nothing else.
2. Every other vendor brings its own code — an `@ai-sdk/*` provider you install,
   or a pi-ai registry you import — and `ai(model)` only routes it.
3. AI Gateway holds the vendor credential (unified billing, or a BYOK key you
   store on the gateway), so no vendor key lives in the Worker.
4. The gateway is an option, not a product: `{ id, cacheTtl, ... }` flat or
   nested under `gateway`, and `default` auto-creates on first use.
5. `createAI({ binding: env.AI })` is the whole configuration: Workers AI goes
   through `env.AI.run`, vendor models through `env.AI.gateway(id).run`.

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAI } from "agents/models/ai-sdk";

const ai = createAI({ binding: env.AI });
const anthropic = createAnthropic({ apiKey: "cloudflare" }); // placeholder

ai("@cf/zai-org/glm-4.7-flash");
ai(anthropic("claude-opus-4-8"), {
  fallback: [ai("@cf/zai-org/glm-4.7-flash")]
});
ai.embedding("@cf/baai/bge-base-en-v1.5");
ai.image("@cf/black-forest-labs/flux-1-schnell");
ai.speech("@cf/deepgram/aura-1");
ai.transcription("@cf/openai/whisper-large-v3-turbo");
ai.reranking("@cf/baai/bge-reranker-base");
```

## Routes

Every text route takes a model two ways: `?model=@cf/<author>/<model>` for
Workers AI, or `?vendor=anthropic:claude-opus-4-8` / `?vendor=openai:gpt-5-mini`,
which the Worker builds with that vendor's own provider and hands to `ai()`.

| Route         | Query                         | Does                                                                   |
| ------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `/`           | `model` or `vendor`, `prompt` | `generateText` — returns text, usage and `providerMetadata.cloudflare` |
| `/stream`     | `model` or `vendor`, `prompt` | `streamText` as a plain text stream                                    |
| `/tools`      | `model` or `vendor`, `prompt` | `generateText` with a `getWeather` tool and `stopWhen: isStepCount(3)` |
| `/json`       | `model` or `vendor`, `prompt` | `generateText` with `Output.object` over a zod schema                  |
| `/embed`      | `text` (repeatable)           | `embedMany` with `@cf/baai/bge-base-en-v1.5`                           |
| `/image`      | `model`, `prompt`             | `generateImage` — answers with the image itself (JPEG or PNG)          |
| `/speech`     | `model`, `text`, `voice`      | `generateSpeech` — answers with the MP3                                |
| `/transcribe` | `model`, `text`               | `transcribe`; POST audio, or GET and the Worker speaks a line first    |
| `/rerank`     | `query`, `doc` (repeatable)   | `rerank` with `@cf/baai/bge-reranker-base`                             |
| `/fallback`   | `prompt`                      | `ai(anthropic(...), { fallback: [ai("@cf/...")] })`                    |

`model` defaults to `@cf/zai-org/glm-4.7-flash`. The modality routes are Workers
AI only — that is where the catalog is.

The pi-ai twin of each text route lives under `/pi/*`, built with `createAI`
from `agents/models/pi-ai`. A vendor there is a pi `Model` object taken from
pi-ai's own registry import:

| Route          | Query                         | Does                                                                      |
| -------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `/pi`          | `model` or `vendor`, `prompt` | `ai.completeSimple` — returns text, usage and the `cloudflare` diagnostic |
| `/pi/stream`   | `model` or `vendor`, `prompt` | `ai.streamSimple` as a plain text stream of `text_delta` events           |
| `/pi/tools`    | `model` or `vendor`, `prompt` | pi-agent-core `Agent` with `getWeather`, driven by `ai.streamFn`          |
| `/pi/fallback` | `prompt`                      | a vendor model with a Workers AI fallback leg                             |

```ts
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createAI } from "agents/models/pi-ai";

const ai = createAI({ binding: env.AI });
const claude = anthropicProvider()
  .getModels()
  .find((model) => model.id === "claude-opus-4-8")!;

await ai.complete(ai(claude), { messages });
new Agent({
  streamFn: ai.streamFn,
  initialState: { model: ai("@cf/zai-org/glm-4.7-flash") }
});
```

pi ships a generated Cloudflare AI Gateway registry, so that module also takes
`ai("anthropic/claude-opus-4-8")` as a string — pi's catalog knowledge, not
ours. The AI SDK module has no such registry and takes `@cf/` strings only.

## Run it

```sh
pnpm install
pnpm dev
```

## curl

Workers AI:

```sh
curl 'http://localhost:8787/?model=@cf/zai-org/glm-4.7-flash&prompt=hello'
curl 'http://localhost:8787/stream?model=@cf/zai-org/glm-4.7-flash&prompt=explain+durable+objects'
curl 'http://localhost:8787/tools?model=@cf/zai-org/glm-4.7-flash&prompt=weather+in+Lisbon'
curl 'http://localhost:8787/json?model=@cf/zai-org/glm-4.7-flash&prompt=a+fact+about+octopuses'
curl 'http://localhost:8787/embed?text=hello&text=world'
curl 'http://localhost:8787/image?prompt=a+cyberpunk+lizard' -o image.jpg
curl 'http://localhost:8787/speech?text=hello+from+Cloudflare' -o speech.mp3
curl 'http://localhost:8787/transcribe'
curl --data-binary @speech.mp3 'http://localhost:8787/transcribe'
curl 'http://localhost:8787/rerank?query=which+is+cooler&doc=a+lizard&doc=a+cat'
```

`@cf/deepgram/nova-3` and `@cf/deepgram/flux` want the audio as an object body
that the JSON run path cannot carry, so `/transcribe` answers a clear error for
them; use a whisper id.

Anthropic and OpenAI, the same routes with `vendor` instead of `model`:

```sh
curl 'http://localhost:8787/?vendor=anthropic:claude-opus-4-8&prompt=hello'
curl 'http://localhost:8787/tools?vendor=anthropic:claude-opus-4-8&prompt=weather+in+Lisbon'
curl 'http://localhost:8787/?vendor=openai:gpt-5-mini&prompt=hello'
curl 'http://localhost:8787/fallback'
```

pi-ai, the same two forms under `/pi`:

```sh
curl 'http://localhost:8787/pi?model=@cf/zai-org/glm-4.7-flash&prompt=hello'
curl 'http://localhost:8787/pi?vendor=anthropic:claude-opus-4-8&prompt=hello'
curl 'http://localhost:8787/pi/stream?vendor=anthropic:claude-opus-4-8&prompt=explain+durable+objects'
curl 'http://localhost:8787/pi/tools?vendor=openai:gpt-5-mini&prompt=weather+in+Lisbon'
curl 'http://localhost:8787/pi/fallback'
```

Vendor models bill through the account's unified billing, or through a key you
store on the gateway. An account with neither answers with a gateway error
rather than a completion — `/fallback` is the route that shows what to do about
it. On `/stream` the response status is already 200 by the time the model is
reached, so a failure before the first token shows up as an empty body with the
error in the `wrangler dev` log.

`agents/models/ai-sdk` and `agents/models/pi-ai` are experimental and their
surfaces may change.
