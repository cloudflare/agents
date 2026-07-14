# 27/W5 addendum — AI SDK ModelClient adapter + Workers AI in the demo

Goal: real language models with tool calling in the demos, via the Vercel AI
SDK (`ai` v6) as a provider-agnostic `ModelClient` adapter, and the Workers
AI binding (`workers-ai-provider`) wired into `demo/cloudflare`. The domain
still never sees the AI SDK — this is an adapter, exactly the seam
`ports/model.ts` reserved for it ("An AI SDK adapter can map this 1:1
later").

Scope: `src/adapters/ai-sdk/model.ts` (+ node tests), demo wiring. Deps
already installed: `ai` ^6.0.225 (dependency), `workers-ai-provider` ^3.3.0
(devDependency, demo-only).

## 1. `src/adapters/ai-sdk/model.ts`

```ts
import type { LanguageModel } from "ai";
export function createAiSdkModel(model: LanguageModel): ModelClient;
```

Lives in the BASE TypeScript project (node-testable; no workers types, no
`cloudflare:` imports). One `stream()` call = one generation: use
`streamText` with tools that have NO `execute` — the SDK then stops at the
first step with unexecuted tool calls, which is exactly the port's contract
(the rebuild's TurnEngine owns the loop).

### Request mapping (`ModelRequest` → `streamText` args)
The port's `ModelMessage` (ports/model.ts) was modeled on the AI SDK's, so
this is mostly re-tagging — but verify every field name against the
INSTALLED `ai` v6 types, not memory:

- `system` → `system`.
- messages: system→system; user text/file parts map 1:1 (`{ type: "file",
  mediaType, data }` — confirm the v6 file-part field names); assistant
  `text` / `tool-call { toolCallId, toolName, input }` parts; tool role
  `tool-result` parts — v6 wraps the result as a typed output
  (`{ type: "json" | "error-json" | "text" | ..., value }`): map the port's
  `output` + `isError` to `error-json`/`json` (fall back to `text` for plain
  strings if the type requires it).
- tools: `ToolDescriptor[]` → `Record<name, tool({ description, inputSchema:
  jsonSchema(descriptor.inputSchema) })>` with no execute (`jsonSchema` from
  `ai`). The domain already emits JSON-schema descriptors — no zod here.
- `toolChoice`: `"auto" | "none" | { toolName }` → `"auto" | "none" |
  { type: "tool", toolName }`.
- settings 1:1: temperature, maxOutputTokens, topP, topK, seed,
  stopSequences, maxRetries, headers, providerOptions.
- `signal` → `abortSignal`.

### Response mapping (`fullStream` parts → `ModelChunk`)
- `text-delta` → `{ type: "text-delta", text }` (confirm v6 field name:
  `text` vs `textDelta`).
- `reasoning-delta` → `{ type: "reasoning-delta", text }`.
- `tool-call` → `{ type: "tool-call", toolCallId, toolName, input }`.
- `finish` → `{ type: "finish", finishReason, usage: { inputTokens,
  outputTokens } }` from the finish part's total usage. Reason vocab: the
  port allows `stop | tool-calls | length | error | content-filter`; map the
  SDK's `other`/`unknown` → `stop` (a completed generation without a
  specific reason reads as a normal stop; comment this).
- `error` part → THROW from the async iterable (port contract: provider
  failures throw; the turn loop classifies them). Preserve the underlying
  error (`AbortedError` from `src/kernel/errors.js` when the signal
  aborted — match what `src/adapters/anthropic/model.ts` does).
- Ignore part types the port has no vocabulary for (`start`, `start-step`,
  `finish-step`, `tool-input-*`, `source`, `raw`, ...) — the accumulator
  upstream only understands the four chunk kinds.

### Node tests (`src/adapters/ai-sdk/model.test.ts`, runs in the node suite)
Use the mock model from `ai/test` (v6 exports — check the actual export
names in `node_modules/ai/test` and use `simulateReadableStream` or the
MockLanguageModel it ships). Cover:
1. text streaming: deltas arrive as `text-delta` chunks, then a `finish/stop`
   with usage mapped.
2. reasoning deltas map.
3. tool-call turn: descriptor conversion is visible to the mock (assert the
   prompt/tools the mock received: names, description, JSON schema,
   toolChoice mapping), the tool-call chunk maps, finish is `tool-calls`.
4. message conversion round-trip: build a `ModelRequest` containing all four
   roles incl. a file part and an `isError` tool result; assert the exact
   prompt array the mock received.
5. settings + system + headers pass through (assert on mock-received
   options where the mock exposes them).
6. mid-stream provider error → the async iterable throws.
7. abort: signal aborts → iterable stops/throws `AbortedError`-compatibly
   (match the anthropic adapter's tests as the reference behavior).

## 2. Demo wiring (`demo/cloudflare/`)

- `wrangler.jsonc`: add the Workers AI binding `"ai": { "binding": "AI" }`.
- `worker.ts` model selection, in priority order (extract a small
  `selectModel(env)` helper with a comment):
  1. `env.ANTHROPIC_API_KEY` set → existing `createAnthropicModel` path
     (unchanged).
  2. `env.AI` binding present → `createAiSdkModel(createWorkersAI({ binding:
     env.AI })(env.WORKERS_AI_MODEL ?? DEFAULT))` with `workers-ai-provider`;
     pick a tool-calling-capable default model id from the
     workers-ai-provider README/types and name it in a constant.
  3. otherwise → the offline scripted model.
- `README.md`: add ~4 lines — Workers AI path needs `wrangler login`
  (the binding proxies to the real service in dev), `WORKERS_AI_MODEL` to
  override, Anthropic key still wins if both are present.
- No workerd test for the Workers AI path (it needs a real account at call
  time); the adapter itself is fully covered by the node tests, and the
  demo smoke test only asserts boot + WS handshake as before.

## 3. Constraints

Frozen: everything except `src/adapters/ai-sdk/**` (new), `demo/cloudflare/**`,
`package.json`/lockfile (already updated), `tsconfig`s only if strictly
needed (base project already includes `src/`). The banned-token test and all
existing suites stay green: `npx vitest run` (>= 1050 + new), `npm run
test:workers` (42), `npm run typecheck`.
