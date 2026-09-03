# Codex harness

A Worker-native coding harness that runs a Codex-derived Rust/Wasm turn loop as
a Lifecycle capability inside a plain Durable Object.

The example composes:

- `CodexHarness extends LifecycleCapability` for the durable agent loop;
- `Tasks` for wake delivery and replay;
- `Streams` for ordered operation events;
- `@cloudflare/shell` Workspace for durable files;
- AI SDK `LanguageModelV4` for model calls;
- `workers-ai-provider` for Kimi K2.7 Code through Workers AI and AI Gateway.

The static Wasm kernel owns pure Codex turn transitions. TypeScript owns model
I/O, Workspace authority, durable effects, and the UI. Model-authored code does
not run inside the kernel.

## Model composition

The harness accepts `LanguageModelV4` directly. It does not parse Workers AI or
OpenAI response envelopes.

```ts
const model = createWorkersAI({
  binding: this.env.AI,
  gateway: {
    id: "default",
    metadata: { codex_transport: "language-model-v4" }
  }
})("@cf/moonshotai/kimi-k2.7-code");

readonly codex = new CodexHarness({
  model,
  tasks: this.tasks,
  streams: this.streams,
  workspace: this.workspace
});
```

The Codex codec maps its Responses records to a V4 prompt and maps V4 stream
parts back to Codex records. It preserves every tool call in a model response.
The first implementation executes a returned batch sequentially, records one
durable effect per call, and starts the next model round only after the complete
batch settles.

## Run locally

Install Node 24+, pnpm, Rust 1.95, and the Wasm target:

```sh
rustup toolchain install 1.95.0 --target wasm32-unknown-unknown
pnpm install
```

Start the Vite app. The Workers AI binding is remote, so Wrangler may ask you to
select or authenticate a Cloudflare account.

```sh
pnpm run start
```

Open the printed local URL. The chat UI shows reasoning, tool calls, the
persisted Workspace file, kernel timing, and restart recovery.

## Verify

```sh
pnpm test
pnpm run typecheck
pnpm run build
```

With the dev server running, exercise the complete live turn:

```sh
pnpm run smoke
```

The smoke checks durable admission, duplicate-operation deduplication, model and
Workspace tool rounds, and state after an explicit Durable Object restart.

The current example deployment is available at:

```text
https://next-codex-harness.mattzcarey.workers.dev
```

## Codex source

The kernel follows `openai/codex` commit
`5e26f7621c1c470fe62350d61c9eb4d6c772a0da`, especially:

- `codex-rs/codex-api/src/common.rs`
- `codex-rs/codex-api/src/sse/responses.rs`
- `codex-rs/protocol/src/models.rs`
- `codex-rs/tools/src/responses_api.rs`
- `codex-rs/tools/src/tool_spec.rs`
- `codex-rs/core/src/session/turn.rs`
- `codex-rs/core/src/tools/parallel.rs`

Codex is Apache-2.0. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
The target design is documented in
[`design/rfc-codex-harness-capability.md`](../../../design/rfc-codex-harness-capability.md).
