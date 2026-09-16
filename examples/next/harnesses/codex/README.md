# Codex harness

A Worker-native coding harness: a Codex-derived Rust/Wasm turn loop plugged
into the shared `Harness` capability as a `HarnessRuntime`, inside a plain
Durable Object.

The example composes:

- `Harness` from [`@cloudflare/agents-next-harness`](../shared) for admission,
  operations, event logs, the Tasks driver and the browser link;
- `CodexRuntime implements HarnessRuntime<CodexProtocol>` for the agent loop:
  the Wasm kernel, the model rounds and the Workspace tools;
- `Tasks` for wake delivery and the effect journal;
- `Sessions` for the transcript: every prompt, assistant message, and tool
  output, with compaction;
- `Streams` for the operation and session logs the harness writes;
- `WebSockets` to serve the harness link to the browser;
- `@cloudflare/shell` Workspace for durable files;
- AI SDK `LanguageModelV4` for model calls;
- `workers-ai-provider` for Kimi K2.7 Code through Workers AI and AI Gateway.

```ts
export class Coder extends DurableObject<Env> {
  readonly codex = new CodexRuntime({
    sessions: this.sessions,
    workspace: this.workspace,
    model: createWorkersAI({ binding: this.env.AI })(MODEL)
  });
  readonly harness = new Harness<CodexProtocol>({
    tasks: this.tasks,
    streams: this.streams,
    runtime: this.codex
  });
  readonly webSockets = new WebSockets(this.harness.webSockets());
}
```

The developer API is the shared one. Nothing in this example is a Codex-shaped
call:

```ts
const session = this.harness.session();
const { operationId } = await session.prompt("Write /codex/result.txt");
const result = await session.wait(operationId); // result.raw: { output, transitions, kernelMs }
```

The browser uses `useHarnessSession<CodexProtocol>({ agent: "coder", name })`
from `@cloudflare/agents-next-harness/react`, the same hook every harness
example uses.

## What the runtime owns

The Wasm kernel is a pure cursor over one turn: which effect comes next and
which tool calls are pending. `drive()` asks the inbox for a prompt, calls
`ctx.begin()`, then loops: one kernel transition, one journaled effect, repeat
until the kernel says the turn is done, and `ctx.settle()`.

| Frame                                      | Where it comes from                          |
| ------------------------------------------ | -------------------------------------------- |
| `message_start` / `message_end`            | one model round, parts as stored in Sessions |
| `tool_start` / `tool_end`                  | one Workspace tool call                      |
| `text_delta` / `reasoning_delta` previews  | the provider's stream, never persisted       |
| `extension: { type: "kernel_event" }`      | the kernel's own events, verbatim            |
| `extension: { type: "kernel_checkpoint" }` | phase, model round, transitions, kernel ms   |

`capabilities` is `["workspace", "usage"]`: one conversation per object, no
steering, no compaction operation (Sessions compacts the branch on its own),
and the runtime never raises a request.

## Durability

Everything with size lives in the SDK's durable primitives, so nothing here
truncates.

| Data                                      | Where                                        | Bound                                               |
| ----------------------------------------- | -------------------------------------------- | --------------------------------------------------- |
| Prompts, assistant messages, tool outputs | Sessions                                     | Durable Object storage; large messages are chunked  |
| Operation and session frames              | the harness's Streams logs                   | batched appends, one row write per batch            |
| Kernel checkpoint                         | `cf_codex_operations`, one row per operation | a few hundred bytes, independent of transcript size |
| Model and tool effects                    | Tasks step journal                           | message ids only                                    |
| Files                                     | Workspace, spilling to R2 past 1.5 MB        | read in ranges with `offset` and `max_bytes`        |

A turn that loses its Durable Object mid-flight resumes: the base re-enters
`drive()`, `ctx.active()` names the operation that was running, its checkpoint
is on the row, and the effect it was waiting on replays from the Tasks
journal instead of running twice.

The model's context window is the one real limit, and it is handled in the
prompt rather than in storage. Each round hydrates a byte-budgeted window of
recent history, a tool input or output over 64 KB is replaced in the prompt by
a marker the model can page back with a ranged read, and Sessions compacts the
branch once its estimated tokens pass a threshold, using the same model to
summarise. The budget and the compaction policy are `CodexRuntime` options.

## The demo's own routes

Host-specific demo features are the host's, not the harness's. `Coder`
implements `onRequest`, which Lifecycle dispatches once the capabilities
decline a request, and `routeAgentRequest` forwards the whole path:

| Route                                   | Answer                             |
| --------------------------------------- | ---------------------------------- |
| `GET /agents/coder/:name/file`          | the demo file `/codex/result.txt`  |
| `GET /agents/coder/:name/operation/:id` | that operation's kernel checkpoint |
| `POST /agents/coder/:name/restart`      | aborts the object after replying   |

"Restart and verify" in the UI is that last route: the object dies, the client
reconnects, and the turn carries on from durable state.

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

The example binds an R2 bucket named `codex-harness-workspace` for the
Workspace. Create it before deploying:

```sh
wrangler r2 bucket create codex-harness-workspace
```

## Tests

```sh
pnpm run build:kernel
npx vitest run --config src/tests/vitest.config.ts
```

The suite drives a real Durable Object with the scripted model from
`src/stress/model.ts` in place of Workers AI, so the real kernel, the real
Workspace tools and the real durable paths all run: one prompt to settlement,
the frames it wrote, the file it left behind, a turn resumed after its
incarnation is evicted mid-flight, and a transcript that survives eviction
between turns.

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
The harness design is
[`design/rfc-harness-capability.md`](../../../../design/rfc-harness-capability.md);
the Codex-specific design it grew out of is
[`design/rfc-codex-harness-capability.md`](../../../../design/rfc-codex-harness-capability.md).
