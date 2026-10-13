# Next: models

The experimental `createAI` factories, `agents/models/ai-sdk` and
`agents/models/pi-ai`, driven from a plain Worker. Same rule, same routes, one
per framework.

## How `agents/models/ai-sdk` names a model

1. A model is a string, and every string runs on one method, `env.AI.run`.
2. `@cf/<author>/<model>` is a Workers AI model.
3. `<author>/<model>` is a model from the AI Gateway catalog, in the gateway's
   own spelling (`anthropic/claude-opus-4.8`, `openai/gpt-5.5`). Unified
   billing means no vendor key lives in the Worker.
4. `dynamic/<route>` is a dynamic route on your gateway.
5. The gateway is an option, not a product: `{ id, cacheTtl, ... }` flat or
   nested under `gateway`, and `default` auto-creates on first use.

```ts
import { createAI } from "agents/models/ai-sdk";

const ai = createAI({ binding: env.AI });

ai("@cf/zai-org/glm-4.7-flash");
ai("anthropic/claude-opus-4.8", {
  fallback: ["@cf/zai-org/glm-4.7-flash"]
});
ai.embedding("@cf/baai/bge-base-en-v1.5");
ai.image("@cf/black-forest-labs/flux-1-schnell");
ai.speech("@cf/deepgram/aura-1");
ai.transcription("@cf/openai/whisper-large-v3-turbo");
ai.reranking("@cf/baai/bge-reranker-base");
```

## Routes

Every text route takes `?model=` in any of the three forms.

| Route         | Query                       | Does                                                                   |
| ------------- | --------------------------- | ---------------------------------------------------------------------- |
| `/`           | `model`, `prompt`           | `generateText` — returns text, usage and `providerMetadata.cloudflare` |
| `/stream`     | `model`, `prompt`           | `streamText` as a plain text stream                                    |
| `/tools`      | `model`, `prompt`           | `generateText` with a `getWeather` tool and `stopWhen: isStepCount(3)` |
| `/json`       | `model`, `prompt`           | `generateText` with `Output.object` over a zod schema                  |
| `/embed`      | `text` (repeatable)         | `embedMany` with `@cf/baai/bge-base-en-v1.5`                           |
| `/image`      | `model`, `prompt`           | `generateImage` — answers with the image itself (JPEG or PNG)          |
| `/speech`     | `model`, `text`, `voice`    | `generateSpeech` — answers with the MP3                                |
| `/transcribe` | `model`, `text`             | `transcribe`; POST audio, or GET and the Worker speaks a line first    |
| `/rerank`     | `query`, `doc` (repeatable) | `rerank` with `@cf/baai/bge-reranker-base`                             |
| `/fallback`   | `prompt`                    | `ai("anthropic/claude-opus-4.8", { fallback: ["@cf/..."] })`           |

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
`ai("anthropic/claude-opus-4.8")` as a string — pi's catalog knowledge, not
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

Catalog models, the same routes with a catalog id:

```sh
curl 'http://localhost:8787/?model=anthropic/claude-opus-4.8&prompt=hello'
curl 'http://localhost:8787/tools?model=anthropic/claude-opus-4.8&prompt=weather+in+Lisbon'
curl 'http://localhost:8787/?model=openai/gpt-5.5&prompt=hello'
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
