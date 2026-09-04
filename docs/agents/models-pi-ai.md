# Models for pi-ai (Experimental)

`agents/models/pi-ai` is the [pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai)
twin of [`agents/models/ai-sdk`](./models.md): the same `createAI` factory, the same options,
the same gateway, returning pi-ai `Model` objects instead of AI SDK ones. Use it with pi-ai's
`stream`/`complete`, with [pi-agent-core](https://github.com/badlogic/pi-mono/tree/main/packages/agent)'s
`Agent`, or with any framework built on a pi-ai `Models` registry.

## The rule

**Workers AI is the catalog Cloudflare keeps up with. Every other vendor is pi-ai's.**

`agents` ships no vendor ids, wire formats, thinking rules or effort tables for any model
that is not `@cf/…`. A third-party model comes from pi-ai's own registry — the package that
tracks that vendor — and `agents` only routes it through AI Gateway. So there are two call
forms:

```ts
import { createAI } from "agents/models/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

const ai = createAI({ binding: env.AI, id: "prod", cacheTtl: 60 });

ai("@cf/zai-org/glm-4.7-flash"); // Workers AI: our catalog, our compat layer
ai(getBuiltinModel("anthropic", "claude-opus-4-8")); // their model, our transport
```

For convenience, pi-ai also ships a generated catalog of the models Cloudflare's gateway
serves, so a `<provider>/<id>` string resolves without importing anything:

```ts
ai("anthropic/claude-opus-4-8"); // same model, resolved through pi-ai's catalog
ai("openai/gpt-5.2");
```

Any other string is a `TypeError` that names the way in. There is no prefix guessing here by
design: a model this package cannot name exactly is yours to construct.

1. **Workers AI ids start with `@cf/`.** Everything else is a vendor's, and comes from a
   vendor registry pi-ai maintains.
2. **The gateway is an option, not a product.** Caching, logging, metadata, timeouts and
   retries are options on `createAI`, on the model, or on the call; the `default` gateway is
   created on first use.
3. **No provider keys.** AI Gateway holds the credential — unified billing, or a key you
   store on the gateway (BYOK) — so nothing vendor-shaped needs a secret in your Worker.
4. **The binding is the only way in.** Workers AI goes through `env.AI.run`, vendor models
   through `env.AI.gateway(id).run`; there is no HTTP transport and no API token to hold.
5. Everything here is experimental and may change in a minor release.

## Quick start

```jsonc
// wrangler.jsonc
{ "ai": { "binding": "AI" } }
```

```sh
npm install agents @earendil-works/pi-ai
```

```ts
import { createAI } from "agents/models/pi-ai";

export default {
  async fetch(_request: Request, env: { AI: Ai }) {
    const ai = createAI({ binding: env.AI });
    const reply = await ai.complete(ai("@cf/zai-org/glm-4.7-flash"), {
      messages: [{ role: "user", content: "Hello", timestamp: Date.now() }]
    });
    // `content` is an array of parts — text, thinking, tool calls.
    const text = reply.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    return Response.json({ text });
  }
};
```

## Where a model comes from

```ts
// 1. Workers AI — ours.
ai("@cf/zai-org/glm-4.7-flash");

// 2. pi-ai's Cloudflare AI Gateway catalog — a string, resolved by pi, not us.
ai("anthropic/claude-opus-4-8");

// 3. Any pi-ai model object, from any registry you imported.
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
const claude = anthropicProvider()
  .getModels()
  .find((m) => m.id === "claude-opus-4-8")!;
ai(claude);
```

Forms 2 and 3 keep the model's own metadata verbatim — `api`, `compat`, `thinkingLevelMap`,
cost, context window, max tokens. That metadata is why `claude-opus-4-8` gets
`thinking: { type: "adaptive" }` and `gpt-5.2` gets `reasoning.effort`: the model's author
said so, and this package does not second-guess it. Form 3 never mutates the object you
passed; the options ride on a copy.

## Running a model

The instance carries pi-ai's four entry points, so nothing global is registered:

```ts
const model = ai("anthropic/claude-opus-4-8");
const context = {
  messages: [{ role: "user", content: "Hi", timestamp: Date.now() }]
};

const message = await ai.complete(model, context); // AssistantMessage
for await (const event of ai.stream(model, context)) {
  // AssistantMessageEvent: text_delta, thinking_delta, toolcall_*, done, error
}
await ai.completeSimple(model, context, { reasoning: "low" }); // SimpleStreamOptions
ai.streamSimple(model, context, { reasoning: "high", maxTokens: 2048 });
```

### With pi-agent-core

```ts
import { Agent } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  streamFn: ai.streamFn,
  initialState: {
    model: ai("anthropic/claude-opus-4-8"),
    systemPrompt: "You are helpful.",
    tools: [getWeather]
  }
});
await agent.prompt("What is the weather in Lisbon?");
```

### With a pi-ai `Models` registry

```ts
import { createModels } from "@earendil-works/pi-ai";

const models = createModels();
models.setProvider(ai.provider); // provider id: "cloudflare"
models.getModel("cloudflare", "anthropic/claude-opus-4-8");
models.streamSimple(ai("@cf/zai-org/glm-4.7-flash"), context);
```

The provider's static list is every Workers AI id pi-ai knows plus every `<provider>/<id>` in
its Cloudflare AI Gateway catalog, so `cloudflare/<id>` specifiers resolve. A model object
you pass to `ai(model)` streams whether or not it is on that list.

## Options

Gateway options may be given flat or nested, on any of the three layers:

```ts
const ai = createAI({ binding: env.AI, id: "prod", cacheTtl: 60 });

ai("anthropic/claude-opus-4-8", {
  gateway: { id: "my-gateway" }, // or a string id
  cacheTtl: 3600, // the same keys, flat
  skipCache: false,
  cacheKey: "greeting-v1",
  collectLog: true,
  metadata: { team: "growth" },
  eventId: "turn-17",
  requestTimeoutMs: 30_000,
  retries: { maxAttempts: 3, backoff: "exponential", retryDelayMs: 500 },
  fallback: ["@cf/zai-org/glm-4.7-flash"], // ids or models, in any mix
  headers: { "x-request-source": "docs" },
  sessionAffinity: "chat-42", // Workers AI prefix-cache routing
  reasoningEffort: "low", // "low" | "medium" | "high" | null
  chatTemplateKwargs: { enable_thinking: false } // Workers AI only
});
```

`reasoningEffort` and `chatTemplateKwargs` are Workers AI settings. On a model object or a
`<slug>/<id>` model they are not sent; the drop is recorded on the message as a
`cloudflare-compat` diagnostic, and the pi `reasoning` level (mapped by the model's own
metadata) is the way to ask a vendor model to think. A string in `fallback` follows the same
rule as `ai(string)`: a `@cf/` id or a registry-known `<slug>/<id>`, never a raw vendor id.

The `@cf/` form also takes pi-ai metadata overrides — `name`, `contextWindow`, `maxTokens`,
`reasoning`, `input`, `cost`, `streamIdleTimeoutMs` — because the Workers AI catalog moves
faster than any generated registry. A model object brings its own; nothing here overrides it.

A pi-ai model is plain data, and these per-model options ride on it under symbol keys, which
`JSON.stringify` and `structuredClone` drop. Routing survives that — a model stored in `Agent`
state and read back still reaches its vendor under the vendor's own id — but the options do
not, so re-apply them with `ai(model, options)` after loading if the model carried any.

Per call, pi-ai's own options map onto the same layers: `headers` are merged last, `metadata`
(scalars) joins the gateway metadata, `sessionId` sets session affinity, and `reasoning` (a pi
thinking level) is remapped through the model's own `thinkingLevelMap` — as far as the wire
can carry it; see [thinking shapes](#thinking-shapes) for the one limit. Precedence is call,
then model, then `createAI` settings.

## How a request travels

| Model                    | `api`                | Transport                                 |
| ------------------------ | -------------------- | ----------------------------------------- |
| `@cf/…`                  | `cloudflare-ai`      | `env.AI.run` + Cloudflare's compat layer  |
| Anthropic (any registry) | `anthropic-messages` | gateway universal → `v1/messages`         |
| OpenAI (any registry)    | `openai-responses`   | gateway universal → `v1/responses`        |
| Groq, DeepSeek, xAI, …   | `openai-completions` | gateway universal → `v1/chat/completions` |

Everything that is not `@cf/` goes through **AI Gateway's universal request**: the vendor's
own body, built by pi-ai's own converter, posted to the gateway with the provider slug taken
from the model's `baseUrl` host. The gateway forwards it to the vendor with the credential it
holds, and streams the vendor's own SSE back untouched — pi-ai's stream processors parse it,
as they would if you had called the vendor directly, the thinking knobs aside (below). No
credential header leaves your Worker, and the model's `api`, `provider` and `id` are never
rewritten, so thinking signatures and encrypted reasoning items replay on the next turn.

The `api` markers in that table are the only ones this package routes, and the table is the
whole list: `cloudflare-ai`, `anthropic-messages`, `openai-responses`, `openai-completions`.
Check your model's `api` before you pass it — several pi registries declare something else and
are not routable today, among them `mistral` (`mistral-conversations`), `google`
(`google-generative-ai`), `google-vertex`, `amazon-bedrock`, `azure-openai-responses` and
`openai-codex`.

Workers AI stays on `env.AI.run`. Its departures from strict OpenAI chat completions (native
events, heartbeats, per-delta usage, per-family request quirks) are absorbed by the same
compat layer the [AI SDK provider](./models.md) uses, so the parser only ever sees strict
OpenAI chunks. Anything the layer had to drop is recorded on the message as a
`cloudflare-compat` diagnostic.

An `api` this package cannot route, or a `baseUrl` whose host AI Gateway does not serve, ends
the stream with an `error` event naming it.

### Thinking shapes

On the `openai-completions` wire this package builds one thinking shape: OpenAI's
`reasoning_effort`, with the level remapped through the model's own `thinkingLevelMap`, and
only when the model reasons and its `compat` does not say `supportsReasoningEffort: false`.

A model whose `compat.thinkingFormat` is anything else — `deepseek`, `zai`, `openrouter`,
`together`, `ant-ling`, `qwen`, `qwen-chat-template`, `chat-template`, `string-thinking` — has
its reasoning level **dropped**, and the drop recorded on the message as a `cloudflare-compat`
diagnostic. Those shapes are the vendor's, and building them here would mean keeping vendor
wire formats in `agents`, which is the one thing this package does not do: reach such a model
through pi-ai's own provider if you need its thinking shape. The `anthropic-messages` and
`openai-responses` wires build the thinking shape their own model metadata declares.

## Unified billing and BYOK

Most vendors work with no key at all: the gateway bills them to your Cloudflare account. A
vendor that is not on unified billing answers with its own error until you store a key on the
gateway — Google AI Studio, reached through a routable model, returns `403 unregistered
callers`. That error is the vendor's, surfaced as-is; the gateway's own failures (no such
gateway, an unpaid account) become a `CloudflareAIError`, so fallback and retry treat them the
way they treat Workers AI failures. A model whose `api` is not one of the four routed markers
never gets that far: the stream ends with an `error` event naming the `api`.

## Observability

Every assistant message carries a `cloudflare` diagnostic with the gateway correlation for its
response:

```ts
const message = await ai.complete(model, context);
const cloudflare = message.diagnostics?.find(
  (d) => d.type === "cloudflare"
)?.details;
// { model, gateway, provider?, specifier?, logId?, eventId?, cacheStatus?,
//   step?, traceId?, runId? }
```

A failed dispatch ends the stream with an `error` event whose message carries a
`cloudflare-error` diagnostic (`status`, `code`, `logId`), and `onResponse` fires with the raw
status and headers for every request.

## Fallback

```ts
ai(claude, { fallback: ["@cf/zai-org/glm-4.7-flash"] });
```

Legs may be Workers AI ids or models, in any mix. They are tried in order: a leg is abandoned
when its stream ends with an `error` before it produced any output, and once a leg has
produced output it is committed to. The message that answers carries a `cloudflare-fallback`
diagnostic listing the abandoned attempts, and `message.model` names the model that actually
answered.

A leg travels with the chain's gateway options — the chain's `id`, `cacheTtl` and the rest win
over a leg's own, and `metadata` merges — as they do in the [AI SDK provider](./models.md). A
leg built as `ai(model, options)` keeps everything else it was built with. A leg named by a
`@cf/` id has no options of its own, so it also inherits the chain's `headers`, session
affinity and Workers AI knobs; it never inherits the chain's model metadata (`name`, `cost`,
`contextWindow`, `maxTokens`, `reasoning`, `input`), which describes the model it was written
on — the leg's usage and cost are its own registry entry's.

## Images

```ts
const images = ai.images("@cf/black-forest-labs/flux-1-schnell", { steps: 8 });
const result = await ai.generateImages(images, {
  input: [{ type: "text", text: "A red bicycle" }]
});
```

Image generation is Workers AI only. The knobs a model takes are the model's:
`flux-1-schnell` takes a prompt and `steps` and nothing else, so `width`,
`height`, `seed`, `guidance` and `negativePrompt` are dropped for it and listed
in a `cloudflare-compat` diagnostic on the result rather than sent and ignored.
Every other model in the catalog takes the full set.

## Experimental

This subpath needs `@earendil-works/pi-ai@>=0.80`, an optional peer of `agents`. `agents`
takes no vendor package as a dependency, optional or otherwise. The surface is experimental
and may change in a minor release. An unlisted `@cf/` id resolves with default metadata (a
128k context window, 8192 output tokens, zero cost); pass overrides when you know better.

## See also

- [Models for the AI SDK](./models.md) — the same factory for the Vercel AI SDK
- [pi-ai](https://github.com/badlogic/pi-mono/tree/main/packages/ai) and
  [pi-agent-core](https://github.com/badlogic/pi-mono/tree/main/packages/agent)
