# Codex harness

A Worker-native coding harness that runs a Codex-derived Rust/Wasm turn loop as
a Lifecycle capability inside a plain Durable Object.

The example composes:

- `CodexHarness extends LifecycleCapability` for the durable agent loop;
- `Tasks` for wake delivery and replay;
- `Streams` for ordered operation events;
- `WebSockets` to serve those events to the browser;
- `@cloudflare/shell` Workspace for durable files;
- AI SDK `LanguageModelV4` for model calls;
- `workers-ai-provider` for Kimi K2.7 Code through Workers AI and AI Gateway.

The Wasm kernel owns pure Codex turn transitions. TypeScript owns model I/O,
Workspace authority, durable effects, and the UI. Model-authored code does not
run inside the kernel.

## Model composition

The harness accepts a `LanguageModelV4` directly. It does not parse Workers AI
or OpenAI response envelopes.

```ts
const model = createWorkersAI({
  binding: this.env.AI,
  gateway: { id: "default" }
})("@cf/moonshotai/kimi-k2.7-code");

readonly codex = new CodexHarness({
  model,
  tasks: this.tasks,
  streams: this.streams,
  workspace: this.workspace
});
```

The Codex codec maps its Responses records to a V4 prompt and maps V4 stream
parts back to Codex records. It preserves every tool call in a model response,
executes the batch sequentially with one durable effect per call, and starts
the next model round only after the complete batch settles.

## Run locally

Install Node 24+, pnpm, and the pinned Rust toolchain with the Wasm target:

```sh
rustup toolchain install 1.95.0 --target wasm32-unknown-unknown
pnpm install
```

Start the Vite app. It builds the Wasm kernel first. The Workers AI binding is
remote, so Wrangler needs a Cloudflare account. If your login has access to
more than one account, set it explicitly:

```sh
CLOUDFLARE_ACCOUNT_ID=<account id> pnpm run start
```

Open the printed local URL. The chat UI shows reasoning, tool calls, the
persisted Workspace file, kernel timing, and a "Restart and verify" action that
aborts the Durable Object and reloads the operation from durable state.

The browser connects with `useAgent` from `agents/react`. `src/use-codex-session.ts`
layers the harness protocol on that socket: a session snapshot on connect,
`subscribe` to replay-then-tail an operation's `Streams` log, and `submit` and
`restart` to drive it. `harness.webSockets()` returns the options for the
`WebSockets` capability that serves it.

## Limits

The kernel keeps a turn's whole transcript in one checkpoint, and every
transition writes that checkpoint back to SQLite as a single value. The
harness therefore bounds what enters it:

| Limit                              | Value       |
| ---------------------------------- | ----------- |
| Prompt, tool argument, tool output | 256 KB each |
| Model rounds per turn              | 24          |
| Kernel transitions per turn        | 256         |

Oversized tool arguments are replaced with an error the model sees, so it can
split the work. Session listings omit checkpoints; the UI loads one on demand.

## Stress test

`src/stress` hosts the same composition with a synthetic model, so the kernel,
Tasks, Streams, and SQLite paths run without Workers AI.

```sh
pnpm run stress:dev            # wrangler dev on :8790, inspector on :9250
pnpm run stress                # or: pnpm run stress deep big-tools concurrent
pnpm run heap snapshot         # V8 heap usage and top holders over CDP
```

## Deploy

```sh
pnpm run deploy
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
