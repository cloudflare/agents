# Inference Buffer

Prototype for [RFC #1257](https://github.com/cloudflare/agents/issues/1257): AI Gateway as a durable response buffer for long-running inference calls.

This is a standalone Cloudflare Worker + Durable Object that validates the concept. The `forever-chat` example in this repo demonstrates the full integration with the Agents SDK's fiber recovery system.

## The Problem

When a Durable Object running an AI agent is evicted mid-inference-stream (e.g., during a code deploy), the in-flight HTTP request to the inference provider is killed. The Agents SDK's fiber system (`runFiber`, `ResumableStream`, `onChatRecovery`) recovers the client-side state, but recovery requires a **new inference call**. The tokens the provider already generated and billed are wasted — the customer pays for output tokens twice.

For agentic loops with multiple sequential tool calls, each interruption wastes all output tokens generated so far in that turn. The cost compounds with model capability (a `gpt-4.1` retry is ~4x more expensive than `gpt-4.1-mini`).

## The Solution

Decouple the provider connection from the agent's lifetime by putting a buffer in between:

```
┌──────────────┐           ┌──────────────────┐           ┌──────────────┐
│   Agent DO   │──proxy───▶│  Inference Buffer │──fetch───▶│   Provider   │
│              │◀─stream───│  (separate DO)    │◀─stream──│  (OpenAI,    │
│              │           │                   │           │  Anthropic,  │
│  [evicted]   │           │  [keeps reading]  │           │  Workers AI) │
│              │           │  [stores chunks   │           │              │
│  [restarts]  │           │   in SQLite]      │           │              │
│              │──resume──▶│                   │           │              │
│              │◀─replay───│                   │           │              │
└──────────────┘           └──────────────────┘           └──────────────┘
```

The buffer Worker is a **separate deployment** — it is not evicted when the agent's code is deployed. The provider connection lives in the buffer's execution context, so it survives the agent's eviction.

## How This Maps to AI Gateway

This prototype is a proof-of-concept for what AI Gateway could do natively. The mapping:

| This prototype                               | AI Gateway equivalent                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| Separate Worker + DO                         | AI Gateway infrastructure (already in the request path)                    |
| `POST /proxy` with `X-Provider-URL`          | Existing proxy flow, with a new `X-AI-Gateway-Durable-Id` header to opt in |
| SQLite chunk storage                         | Purpose-built stream store (in-memory + durable spillover)                 |
| `GET /resume?from=N`                         | New endpoint: `GET /gateway/buffer/{id}?offset={n}`                        |
| `GET /drain` (snapshot read)                 | Same, with a `?snapshot=true` flag                                         |
| `POST /ack`                                  | Explicit acknowledgment, or implicit via TTL expiry                        |
| 5-minute TTL alarm                           | Configurable TTL (default 5 min, override per-request)                     |
| Service binding from agent → buffer          | AI Gateway is already a Cloudflare service — no binding needed, just a URL |
| `X-Provider-Type: workers-ai` for AI binding | AI Gateway already routes to Workers AI — this is a no-op                  |

The key property that makes AI Gateway the right place: it's **managed infrastructure** that is never redeployed on user code changes. This prototype validates that the buffer concept works, and that the fiber system's `onChatRecovery` hook provides a clean integration point.

## What the SDK Needs from AI Gateway

Concrete API requirements from the Agents SDK's perspective:

1. **Opt-in buffering via header**: `X-AI-Gateway-Durable-Id: <id>` on any proxied request. When present, AI Gateway buffers the response durably. When absent, existing pass-through behavior.

2. **Resume/replay endpoint**: `GET /gateway/buffer/{id}?from={chunk-index}` — tails a live stream (blocks until complete) or replays a completed buffer. Returns raw provider SSE bytes, exactly as received.

3. **Status endpoint**: `GET /gateway/buffer/{id}/status` → `{ "status": "streaming"|"completed"|"interrupted"|"error", "chunkCount": N }`.

4. **Format-agnostic storage**: Store raw bytes. The SDK handles format conversion (raw provider SSE → AI SDK UIMessage format) via client-side streaming transformers. This keeps AI Gateway free of library/framework dependencies.

5. **TTL**: Default 5 minutes, overridable per-request via `X-AI-Gateway-Buffer-TTL` header. Cleanup is automatic — no explicit ack required (though an ack endpoint for eager cleanup is nice to have).

6. **Workers AI pass-through**: For Workers AI models, AI Gateway already handles routing. Buffering should work identically — the Durable-Id header opts in regardless of the upstream provider.

## Architecture

### Key architectural trick

When the agent calls `/proxy`, the buffer DO:

1. Opens the provider connection itself (via `fetch` for HTTP providers, or `AI.run()` for Workers AI)
2. Starts a background task (`ctx.waitUntil`) that reads every SSE chunk and stores it in SQLite
3. Returns a `ReadableStream` to the agent that **tails** SQLite as chunks arrive

If the agent disconnects (evicted), the background task keeps consuming the provider stream. When the agent restarts and calls `/resume?from=N`, it gets a new tail stream starting from chunk N.

### Two provider modes

**HTTP providers** (OpenAI, Anthropic): The buffer receives the full HTTP request (URL, headers, body), forwards it via `fetch()`, and buffers the streaming response. Headers like `Authorization` and `Content-Type` are forwarded transparently; buffer-specific headers (`X-Provider-URL`, `X-Buffer-*`) are stripped.

**Workers AI**: The buffer has its own `AI` binding. The caller sends `X-Provider-Type: workers-ai` + `X-AI-Model: @cf/model-name`, and the buffer calls `this.env.AI.run(model, body)` directly. This avoids needing an API token for Workers AI and keeps the binding advantage (automatic routing, no egress).

### Notification signal (no polling)

Resume tailers don't poll SQLite. The `_consumeProvider` background task resolves a signal promise after each chunk insert. The tail stream's `pull()` awaits this signal, then drains all available chunks from SQLite. This is safe because Durable Objects are single-threaded — the SQL insert and signal resolution happen in the same synchronous block, so a waking tailer always sees the new chunk.

### Buffer lifecycle

```
idle ──[/proxy]──▶ streaming ──[provider done]──▶ completed ──[/ack or TTL]──▶ idle
                       │                              │
                       │ [DO evicted]                  │ [DO evicted + restart]
                       ▼                               ▼
                  interrupted                     completed (restored)
                       │
                       └──[TTL alarm]──▶ idle
```

- **idle**: No active buffer. `/resume` returns 404.
- **streaming**: Provider connection is live, chunks are being stored. `/proxy` returns 409 (already active).
- **completed**: Provider finished, all chunks in SQLite. Resume replays everything.
- **interrupted**: Buffer DO was evicted while the provider stream was active. Provider connection is lost. Whatever chunks were stored are available; callers get partial data.
- **error**: Provider returned an error during streaming.

## Recovery Data Flow

The buffer stores raw provider bytes. On recovery, the SDK has two paths depending on buffer status:

**Streaming or completed** — replay via provider composition:

```
Buffer (/resume) ──▶ Replay Model (real provider with replayFetch) ──▶ streamText() ──▶ client
```

The replay model creates the real provider model (`@ai-sdk/openai`, `@ai-sdk/anthropic`, or `workers-ai-provider`) with a custom `fetch` that returns the buffer's `/resume` response instead of calling the real API. The provider's own maintained SSE parser handles format conversion to `LanguageModelV3StreamPart`. `streamText()` then handles tool execution, reasoning, and `toUIMessageStreamResponse()` natively. Zero custom SSE parsing — if a provider updates their format, the replay picks it up automatically.

```typescript
// All three providers use the same pattern:
createModel: (fetch) => createOpenAI({ apiKey: "replay", fetch })("gpt-5.4");
createModel: (fetch) =>
  createAnthropic({ apiKey: "replay", fetch })("claude-sonnet-4-6");
createModel: (fetch) =>
  createWorkersAI({ accountId: "replay", apiKey: "replay", fetch })(
    "@cf/moonshotai/kimi-k2.5"
  );
```

**Interrupted or errored** — accumulating parse + persist:

```
Buffer (/drain) ──▶ SSE Parsers ──▶ { text, reasoning, toolCalls } ──▶ execute tools ──▶ persist ──▶ continueLastTurn
```

When the buffer's provider connection is dead (buffer DO evicted), there's no live stream to replay. The accumulating parsers extract text, reasoning, and tool calls from whatever chunks are stored. Server-side tools are executed during recovery (with approval checks). The partial response is persisted, and `continueLastTurn` generates the remainder.

## API

All endpoints require a buffer ID via `?id=<buffer-id>` query param or `X-Buffer-Id` header.

### `POST /proxy`

Forward a request to an inference provider and buffer the response.

**HTTP provider:**

```
POST /proxy?id=fiber-abc123
X-Provider-URL: https://api.openai.com/v1/chat/completions
Authorization: Bearer sk-...
Content-Type: application/json

{"model": "gpt-4.1", "messages": [...], "stream": true}
```

**Workers AI:**

```
POST /proxy?id=fiber-abc123
X-Provider-Type: workers-ai
X-AI-Model: @cf/moonshotai/kimi-k2.5
Content-Type: application/json

{"messages": [...], "stream": true}
```

Returns: SSE stream with `X-Buffer-Status: streaming` header.

### `GET /resume`

Replay buffered chunks from a given offset. **Blocks** until the stream completes if the provider is still active.

```
GET /resume?id=fiber-abc123&from=0
```

Response header `X-Buffer-Status`: `streaming`, `completed`, `interrupted`, `error`.

### `GET /drain`

Snapshot read — returns whatever chunks are currently stored, then closes immediately. **Does not block**. Used for partial recovery when the buffer is interrupted or errored.

```
GET /drain?id=fiber-abc123&from=0
```

### `GET /status`

```json
{ "status": "completed", "chunkCount": 142 }
```

### `POST /ack`

Acknowledge receipt and trigger early cleanup. Rejected with 409 if still streaming.

## Packaging Path

### Now: RFC deliverable

The prototype (`experimental/inference-buffer/` + `experimental/forever-chat/`) demonstrates the full end-to-end flow. The `forever-chat` example shows buffer integration with OpenAI, Anthropic, and Workers AI, including streaming replay on recovery.

### If AI Gateway implements this

The buffer worker becomes unnecessary. The replay model pattern (compose real providers with a custom `fetch` that reads from the buffer) moves into `@cloudflare/ai-chat` as an internal utility. Users opt in with a single flag:

```typescript
export class MyAgent extends AIChatAgent<Env> {
  override unstable_chatRecovery = true;
  override durableBuffer = true; // routes inference through AI Gateway buffer
}
```

The SDK handles: model wrapping (custom fetch for all providers — including Workers AI via the `fetch` option added in [workers-ai-provider#480](https://github.com/cloudflare/ai/pull/480)), recovery orchestration via replay model composition, tool call handling via `streamText`'s native step loop. AI Gateway handles: buffering, storage, TTL, cleanup. No custom SSE parsing needed anywhere — the real provider parsers do all format conversion.

### If AI Gateway says "not yet"

Publish the buffer worker as a deploy template. Users deploy it alongside their agent worker and add a service binding. The SDK integration points at the binding:

```typescript
override durableBuffer = { binding: this.env.INFERENCE_BUFFER };
```

When Gateway catches up, they swap the binding for a Gateway config — zero code change in the agent.

## Running Locally

```bash
cd experimental/inference-buffer
pnpm start              # starts at http://localhost:8787
```

Test scripts:

- `test-e2e.sh` — full happy path (proxy, verify buffering, resume from midpoint)
- `test-eviction.sh` — eviction simulation (abort mid-stream, verify buffer keeps consuming, resume)

Both require the buffer worker running at `localhost:8686`:

```bash
pnpm start -- --port 8686
```

## Production Considerations

Things this prototype handles well enough for validation but that AI Gateway would need to address:

- **Storage backend**: This uses DO SQLite. AI Gateway would want a purpose-built stream store (in-memory with durable spillover) for lower latency.
- **Buffer size limits**: No cap currently. Long agentic turns with code generation can produce large responses.
- **Multi-tenant isolation**: Buffer IDs are global UUIDs. AI Gateway would scope to account/gateway.
- **Observability**: Track buffer hit/miss/partial rates and tokens saved per recovery.
- **Cost model**: Is buffering included in existing AI Gateway pricing, or a separate tier?
- **Provider-specific optimizations**: OpenAI's Responses API (`previous_response_id`) and Anthropic's potential future resume support could be leveraged alongside raw buffering.
