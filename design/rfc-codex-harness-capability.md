Status: proposed

# Codex as a Lifecycle capability

## Summary

We will run a Codex-derived Rust/Wasm turn engine directly inside a plain
Cloudflare Durable Object. The host will compose it as a Lifecycle capability,
the same way the Pi integration composes `PiHarness`:

```ts
import { Workspace } from "@cloudflare/shell";
import { DurableObject } from "cloudflare:workers";
import { CodexHarness } from "agents/harness/codex";
import { Lifecycle } from "agents/lifecycle";
import { Sessions } from "agents/sessions";
import { Streams } from "agents/streams";
import { Tasks } from "agents/tasks";
import { createWorkersAI } from "workers-ai-provider";

export class Coder extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly sessions = new Sessions();

  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "codex"
  });

  readonly codex = new CodexHarness({
    tasks: this.tasks,
    streams: this.streams,
    sessions: this.sessions,
    workspace: this.workspace,
    model: createWorkersAI({
      binding: this.env.AI,
      gateway: { id: "default" }
    })("@cf/moonshotai/kimi-k2.7-code")
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.sessions)
    .use(this.codex);

  prompt(text: string) {
    return this.codex.prompt(text);
  }
}
```

The Durable Object extends only Cloudflare's platform `DurableObject` class.
`CodexHarness` extends `LifecycleCapability` and receives the capabilities and
application resources it needs through its constructor.

The Codex engine will be static package code. Workerd will compile its Wasm
module with the Worker bundle, and each Durable Object isolate will instantiate
that module directly. The model loop, context assembly, tool protocol, retry
decisions, and response parsing will stay in the Codex-derived Rust engine.
JavaScript will own Workers APIs and durable resources.

Dynamic Workers will remain available for Code Mode. A model-authored JavaScript
program will run through `@cloudflare/codemode` in a disposable Dynamic Worker,
with `@cloudflare/shell` exposing the same durable Workspace through
`stateTools(workspace)`. The trusted Codex engine itself will stay static and
in-process.

The current runnable proof lives in
[`examples/next/harnesses/codex`](../examples/next/harnesses/codex/README.md).
It has already proved the direct static-Wasm path inside `wrangler dev`.

## Goal

The capability will let an application add Codex to an existing plain Durable
Object while the package owns its Rust/Wasm runtime and build integration.

A developer should make five intentional choices:

1. the Durable Object that owns the coding session;
2. the model transport;
3. the durable Workspace;
4. the Lifecycle capabilities used for wake, output, and conversation storage;
5. whether Code Mode is enabled.

The package will own the remaining details:

- the Rust toolchain and Wasm build;
- the pinned Codex source revision;
- Wasm module packaging and instantiation;
- the Codex Responses to LanguageModelV4 codec;
- Codex tool schemas and output encoding;
- operation, effect, and checkpoint schemas;
- retry and reconciliation rules;
- projection from Codex items into Sessions and Streams;
- Code Mode's generated Worker source and connector wiring.

The result is a Worker-native Codex runtime that starts with the Durable Object,
hibernates with it between turns, and uses the platform's normal per-object
placement and scale-out model.

## Vocabulary

The implementation will use these terms consistently.

### Harness

`CodexHarness` is the Lifecycle capability installed on a Durable Object. It
accepts operations, drives the Rust kernel, performs effects, records durable
state, and exposes reads to the host application.

### Thread

A thread is Codex's durable conversation. Each thread has stable context,
settings, and a sequence of turns. A `CodexHarness` owns a default thread and
may expose named threads later using the same storage namespace.

### Turn

A turn starts with user input and ends with a final assistant answer or a typed
failure. It can contain several model rounds and tool calls.

### Transition

A transition is one synchronous call into the Rust/Wasm kernel. It consumes a
checkpoint plus either new user input or one settled effect, then emits:

- a new checkpoint;
- ordered Codex events;
- one next action.

A transition is pure computation. Every I/O request leaves the kernel as an
action with a stable identity.

### Action

An action is the next external operation requested by the kernel. Initial
actions are model calls and tools. Approval and compaction actions will use the
same mechanism.

### Effect

An effect is the durable execution of an action. It has a stable ID, a recorded
intent, and one terminal result. The harness reconciles pending effects after a
Durable Object wake.

### Checkpoint

A checkpoint is the complete serialized kernel state needed for the next
transition. It includes the Codex input sequence, model round, pending tool,
response identity, output accumulated so far, and event sequence.

### Rollout

A rollout is the full-fidelity ordered Codex record. It contains model input,
provider events, tool intents, tool results, settings, usage, compactions, and
terminal outcomes. The rollout is the recovery and debugging record.

### Projection

A projection is the smaller representation used by an application. Sessions
holds display-ready messages and search metadata. Streams holds operation output
for replay and live clients. Both are derived from the rollout.

### Workspace

Workspace is the durable filesystem passed to Codex tools. The first
implementation uses `Workspace` from `@cloudflare/shell`, backed by the same
Durable Object's SQLite storage.

## Architecture

```text
Browser, Worker, queue, schedule, or another Agent
                      |
                      v
             plain Durable Object
  +------------------------------------------------+
  | Lifecycle                                      |
  |                                                |
  | Tasks       durable wake and attempt claim     |
  | Streams     replayable operation events        |
  | Sessions    visible conversation projection    |
  | CodexHarness                                   |
  |   +----------------------------------------+   |
  |   | static Codex Rust/Wasm kernel          |   |
  |   |                                        |   |
  |   | context -> Responses -> tools -> next  |   |
  |   +----------------------------------------+   |
  |          | action            ^ result          |
  |          v                   |                 |
  |   durable effect journal                       |
  |       | model       | filesystem | code        |
  |       v             v            v             |
  |   Responses WS   Shell Workspace  Code Mode    |
  |                                 Dynamic Worker |
  +------------------------------------------------+
```

The direct call between `CodexHarness` and the Wasm instance is the hot path.
Kernel transitions stay inside the owning isolate. Network and storage calls
cross a port when the kernel emits an action that needs an external effect.

## Why the kernel runs directly in the Durable Object

The kernel is trusted, versioned package code. Running it in the Durable Object
keeps the most frequent boundary, checkpoint to transition to next action, as a
synchronous in-isolate call. One imported Wasm module is compiled with the
Worker and instantiated once for each Durable Object isolate.

This placement aligns compute identity with durable identity. The named Durable
Object owns one Codex thread, its effect journal, its Workspace, its event
stream, and the process-local kernel that advances it. A new incarnation
reconstructs the same arrangement from SQLite. Separate threads continue to
scale across separate Durable Objects.

The boundary also concentrates authority in JavaScript. Rust receives the
serialized checkpoint and settled effect data. JavaScript receives the action,
records its intent, and calls the model, Workspace, approval handler, or Code
Mode adapter. The kernel stays portable because it depends on data rather than
Workers bindings.

Static packaging keeps setup short. The Codex entry point imports its own Wasm
artifact, constructs `DirectKernelRuntime`, and exposes `CodexHarness`.
Application code supplies the model, Workspace, and Lifecycle capabilities. The
package build owns Rust versioning, Wasm compilation, licenses, and provenance.

Dynamic Workers then have one focused job: running model-authored Code Mode
programs with explicit capabilities and resource limits. This makes their cost
proportional to generated-code execution rather than to every Codex transition.

## Developer experience

### Minimal host

The host class will look like this:

```ts
export class Coder extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly sessions = new Sessions();

  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "code"
  });

  readonly codex = new CodexHarness({
    tasks: this.tasks,
    streams: this.streams,
    sessions: this.sessions,
    workspace: this.workspace,
    model: createWorkersAI({
      binding: this.env.AI,
      gateway: { id: "default" }
    })("@cf/moonshotai/kimi-k2.7-code")
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.sessions)
    .use(this.codex);
}
```

The host can expose whichever application API it wants:

```ts
async onRequest(request: Request): Promise<Response> {
  const { prompt } = await request.json<{ prompt: string }>();
  const receipt = await this.codex.submit({
    kind: "prompt",
    prompt
  });
  return Response.json(receipt, { status: 202 });
}
```

A caller that wants an attached result can use:

```ts
const result = await this.codex.prompt("Fix the failing parser test");
```

### Code Mode

Code Mode will be enabled through one package helper:

```ts
readonly codex = new CodexHarness({
  tasks: this.tasks,
  streams: this.streams,
  sessions: this.sessions,
  workspace: this.workspace,
  model: this.codexModel,
  codeMode: createCodexCodeMode({
    loader: this.env.LOADER
  })
});
```

`createCodexCodeMode` will construct `DynamicWorkerExecutor`, adapt the
Workspace through `stateTools(workspace)`, install the Codex-facing tool, set
network policy, enforce time and byte limits, and map output into the Codex tool
result format.

A project using the Agents Vite integration will get the Worker Loader binding
from that integration. Wrangler users will add the normal Worker Loader binding
once, in the same way current Codemode applications do. The Codex Wasm kernel
does not use that binding.

### Public operations

The initial capability will expose Pi-aligned operation methods while retaining
Codex's thread, turn, and item vocabulary in results:

```ts
interface CodexHarness {
  submit(
    request: CodexOperationRequest,
    options?: CodexSubmitOptions
  ): Promise<CodexSubmissionReceipt>;

  prompt(
    input: CodexMessageInput,
    options?: CodexSubmitOptions
  ): Promise<CodexPromptResponse>;

  waitForResult(
    operationId: string,
    options?: CodexThreadOptions
  ): Promise<CodexOperationResult>;

  getResult(
    operationId: string,
    options?: CodexThreadOptions
  ): Promise<CodexOperationResult | undefined>;

  snapshot(options?: CodexThreadOptions): Promise<CodexThreadSnapshot>;

  getMessages(options?: CodexThreadOptions): Promise<CodexMessage[]>;

  abort(options?: {
    thread?: string;
    operationId?: string;
  }): Promise<CodexAbortResult | null>;

  steer(
    input: CodexMessageInput,
    options?: CodexThreadOptions
  ): Promise<CodexQueueReceipt>;
}
```

`submit()` resolves after the operation and its wake are durable. `prompt()` is
the waiting convenience. `snapshot()` is the fast UI read. `getResult()` reads
one immutable terminal operation record. `steer()` queues input for the next
model boundary in the active turn.

## Static Wasm runtime

### Package import

The implementation module will import the compiled Wasm directly:

```ts
import codexKernel from "./codex-kernel.wasm";

const module = codexKernel;
```

In Workers, a compiled Wasm import resolves to `WebAssembly.Module`. Workerd
compiles the module as part of the Worker module graph. The harness creates an
instance for the Durable Object isolate:

```ts
const instance = await WebAssembly.instantiate(module, imports);
```

The current proof uses the same mechanism in
[`src/codex-harness.ts`](../examples/next/harnesses/codex/src/codex-harness.ts)
and
[`src/kernel-runtime.ts`](../examples/next/harnesses/codex/src/kernel-runtime.ts).
Its compiled kernel is 186 KiB.

Workerd's implementation is explicit about this representation:

- `WorkerSource::WasmModule` carries the compiled module and its wire bytes;
- static Wasm imports become `WebAssembly.Module` values;
- Worker Loader can also share compiled Wasm with child isolates on current
  workerd.

The relevant workerd source is:

- [`src/workerd/api/worker-loader.h`](https://github.com/cloudflare/workerd/blob/61dc0049f6f1fd5864d721035c4f7124dca488cb/src/workerd/api/worker-loader.h)
- [`src/workerd/api/worker-loader.c++`](https://github.com/cloudflare/workerd/blob/61dc0049f6f1fd5864d721035c4f7124dca488cb/src/workerd/api/worker-loader.c%2B%2B)
- [`src/workerd/io/worker-source.h`](https://github.com/cloudflare/workerd/blob/61dc0049f6f1fd5864d721035c4f7124dca488cb/src/workerd/io/worker-source.h)

### Kernel ABI

The first ABI uses serialized JSON because it gives us an inspectable and
versioned checkpoint while the design is changing:

```rust
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8;

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize);

#[no_mangle]
pub unsafe extern "C" fn transition(
    ptr: *const u8,
    len: usize,
) -> u64;
```

`transition` returns `(pointer << 32) | length`. The JavaScript wrapper copies
one command into Wasm memory, calls the synchronous transition, copies one
result out, and releases both buffers.

The command is one of:

```ts
type KernelCommand =
  | {
      type: "start_turn";
      thread_id: string;
      turn_id: string;
      prompt: string;
      model: string;
    }
  | {
      type: "resolve_effect";
      checkpoint: KernelCheckpoint;
      effect_id: string;
      result: KernelEffectResult;
    };
```

The result is:

```ts
type KernelTransition = {
  checkpoint: KernelCheckpoint;
  events: KernelEvent[];
  action:
    | { type: "model"; effect_id: string; request: ResponsesRequest }
    | {
        type: "tool";
        effect_id: string;
        call_id: string;
        name: string;
        arguments: JsonValue;
      }
    | { type: "completed"; output: string }
    | { type: "failed"; error: CodexError };
};
```

The ABI is implemented today in
[`wasm-kernel/src/lib.rs`](../examples/next/harnesses/codex/wasm-kernel/src/lib.rs).
The TypeScript wrapper is in
[`src/kernel-runtime.ts`](../examples/next/harnesses/codex/src/kernel-runtime.ts).

As the engine grows, the ABI will move from generic JSON values toward compact
versioned records. The transition contract stays the same, which keeps
Lifecycle and storage independent of the encoding choice.

## Codex source reuse

We will pin one upstream Codex commit and keep a provenance map from every
extracted module to its upstream source. The current research pin is:

```text
openai/codex
5e26f7621c1c470fe62350d61c9eb4d6c772a0da
```

Codex is Apache-2.0. The prototype notice is in
[`THIRD_PARTY_NOTICES.md`](../examples/next/harnesses/codex/THIRD_PARTY_NOTICES.md).
The package will ship the upstream license and generated provenance manifest
beside the Wasm artifact.

### Source map

| Cloudflare kernel responsibility                     | Codex source to reuse                                    |
| ---------------------------------------------------- | -------------------------------------------------------- |
| Responses request and WebSocket envelope             | `codex-rs/codex-api/src/common.rs`                       |
| Responses event parsing                              | `codex-rs/codex-api/src/sse/responses.rs`                |
| Responses WebSocket request and connection semantics | `codex-rs/codex-api/src/endpoint/responses_websocket.rs` |
| Response input and output item types                 | `codex-rs/protocol/src/models.rs`                        |
| Core operation and event types                       | `codex-rs/protocol/src/protocol.rs`                      |
| Function, namespace, custom, and deferred tool specs | `codex-rs/tools/src/tool_spec.rs`                        |
| Responses tool serialization                         | `codex-rs/tools/src/responses_api.rs`                    |
| Tool payload classification                          | `codex-rs/tools/src/tool_payload.rs`                     |
| Tool output to response-item conversion              | `codex-rs/tools/src/tool_output.rs`                      |
| Registry and dispatch rules                          | `codex-rs/core/src/tools/registry.rs` and `router.rs`    |
| Model round and tool continuation loop               | `codex-rs/core/src/session/turn.rs`                      |
| Context history updates                              | `codex-rs/core/src/context_manager`                      |
| Compaction decisions and inputs                      | `codex-rs/core/src/compact*.rs`                          |
| Rollout item semantics                               | `codex-rs/rollout` and `codex-rs/thread-store`           |
| Remote process and filesystem vocabulary             | `codex-rs/exec-server-protocol`                          |

### Extraction structure

The target package will separate mechanically synchronized Codex code from
Cloudflare adapters:

```text
packages/agents/src/harness/codex/
  index.ts
  codex-harness.ts
  operation-store.ts
  effect-store.ts
  projection.ts
  model.ts
  workspace-tools.ts
  code-mode.ts
  runtime.ts
  wasm/
    codex-kernel.wasm
    provenance.json
    LICENSE.openai-codex

vendor/codex-worker-kernel/
  Cargo.toml
  rust-toolchain.toml
  src/
    lib.rs
    kernel.rs
    responses.rs
    response-items.rs
    tools.rs
    context.rs
    rollout.rs
  upstream/
    codex-api-common.rs
    codex-api-responses.rs
    codex-protocol-models.rs
    codex-tools-tool-spec.rs
    codex-tools-responses-api.rs
  patches/
  provenance.json

scripts/codex/
  update-upstream.ts
  verify-provenance.ts
  build-wasm.ts
```

`update-upstream.ts` will take a commit SHA, download the allowlisted files,
verify their hashes, place exact snapshots under `upstream/`, and report the
semantic patches that need review. `provenance.json` will record:

```json
{
  "repository": "https://github.com/openai/codex",
  "commit": "5e26f7621c1c470fe62350d61c9eb4d6c772a0da",
  "files": [
    {
      "source": "codex-rs/codex-api/src/common.rs",
      "sha256": "...",
      "modules": ["src/responses.rs"]
    }
  ]
}
```

CI will rebuild the Wasm from source, compare the artifact hash with the
checked-in module, run the Codex-derived protocol fixtures, and reject an
artifact whose source pin or license manifest is missing.

## Turn execution

### Admission

`submit()` will perform this sequence:

1. call `lifecycle.ready()`;
2. parse the operation request;
3. choose or verify the operation ID;
4. insert the operation intake row;
5. open its Streams log;
6. enqueue the internal Tasks driver;
7. return the operation receipt.

The intake row and task run share the same operation ID. A repeated request with
the same ID and identical input returns the existing receipt. A repeated ID with
different input returns a typed conflict.

### Driver

`CodexHarness` registers one internal Tasks definition in its constructor:

```ts
const DRIVER = "__cf_codex_drive_v1";

tasks.register(DRIVER, (input, step) => this.drive(input, step));
```

Tasks owns the attempt claim, wake deadline, cancellation signal, and alarm
re-entry. The Codex operation store owns model and tool effect recovery. The
Tasks handler restarts from the operation's stored checkpoint on every attempt.

The driver loop is:

```ts
while (true) {
  const operation = store.get(operationId);
  const command = await nextKernelCommand(operation);

  const transition = kernel.transition(command);
  store.recordTransition(transition);
  projectEvents(transition.events);

  switch (transition.action.type) {
    case "model":
    case "tool": {
      const result = await effects.perform(transition.action);
      store.recordEffectResult(transition.action.effectId, result);
      continue;
    }
    case "completed":
      store.complete(operationId, transition.action.output);
      streams.close(operationId);
      return;
    case "failed":
      store.fail(operationId, transition.action.error);
      streams.error(operationId, transition.action.error.message);
      return;
  }
}
```

Each effect is journaled before dispatch and settled after dispatch. On a replay,
`effects.perform()` first reads the journal. A completed effect returns its
stored result. A pending effect runs its effect-specific reconciliation before
any retry decision.

### Stable effect identity

The kernel derives effect IDs from Codex identities:

```text
model:<model-round>
tool:<call-id>
approval:<call-id>
compact:<context-window-id>
```

IDs are scoped by operation ID in storage. Tool calls retain the provider's
`call_id`, so the output sent back to Responses uses the exact identity the
model emitted.

## Durable storage

### Active operation tables

The first implementation will store active checkpoints and effect evidence in
the owning Durable Object's SQLite database.

```sql
CREATE TABLE cf_codex_operations (
  operation_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  stream_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  request_json TEXT NOT NULL,
  checkpoint_json TEXT,
  action_json TEXT,
  transition_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  output_json TEXT,
  error_json TEXT
);

CREATE TABLE cf_codex_effects (
  operation_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (operation_id, effect_id)
) WITHOUT ROWID;

CREATE TABLE cf_codex_rollout (
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  item_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, seq)
) WITHOUT ROWID;
```

The current proof keeps the operation row and an event table in
[`src/codex-harness.ts`](../examples/next/harnesses/codex/src/codex-harness.ts)
and journals effects through Tasks `step.do()` rather than its own effect
table.

### Transition transaction

One synchronous SQLite transaction records each pure kernel transition:

1. insert rollout items;
2. update the operation checkpoint;
3. update the next action;
4. advance the transition count;
5. update the visible projection rows that can be derived synchronously.

The checkpoint and action therefore always describe the same kernel state.

### Effect transaction

Each effect runs as one named Tasks step keyed by its stable effect ID.
Tasks records the intent when the step starts and journals the result when it
settles, so a replayed attempt returns the stored result instead of running
the effect again. The step attempt's `AbortSignal` reaches the model call and
tool adapters, so cancellation interrupts in-flight work.

A step interrupted between external completion and journal write is re-run on
the next attempt. Workspace tools are idempotent. A model round is re-issued
and the rare duplicate call is accepted; a harness that must never double a
paid call should fail the turn instead and surface it.

Workspace writes will carry the stable effect ID into their adapter. The first
Workspace implementation uses operation-specific paths or postcondition reads
for reconciliation. Code Mode uses Codemode's durable execution ID and replay
log.

### Sessions projection

Sessions will hold display-ready user, assistant, reasoning, and tool messages.
The projection records Codex rollout sequence numbers so recovery reads and
rebuilds only the unprojected suffix.

A projected tool item contains:

```ts
type CodexToolMessage = {
  type: "tool";
  callId: string;
  name: string;
  input: JsonValue;
  state: "running" | "completed" | "failed";
  output?: JsonValue;
  error?: CodexError;
};
```

The rollout retains the complete provider payload. The Session message retains
the bounded application representation used by the UI and model history.

### R2 rollout tier

After the direct runtime is complete, raw rollout storage will gain an R2 tier
for long threads and large provider payloads. SQLite will retain the ordered
manifest and hot projection:

```sql
CREATE TABLE cf_codex_rollout_segments (
  thread_id TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  last_seq INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  PRIMARY KEY (thread_id, first_seq)
) WITHOUT ROWID;
```

A segment upload completes before the manifest transaction references it. A
content hash verifies every read. Segment keys include the owning Durable
Object identity and thread ID. Active checkpoints remain in SQLite, giving
recovery a direct hot-state read while R2 stores historical segments.

## Model transport

The Rust kernel keeps Codex's Responses representation because Codex uses those
records for context, tools, and rollout state. The application model boundary is
AI SDK `LanguageModelV4`.

```text
Codex Responses records
  -> LanguageModelV4 prompt and function tools
  -> LanguageModelV4.doStream()
  -> V4 text, reasoning, tool-call, metadata, and finish parts
  -> Codex Responses events
```

`CodexHarness` accepts the model directly:

```ts
interface CodexHarnessOptions {
  model: LanguageModelV4;
  tasks: Tasks;
  streams: Streams;
  workspace: Workspace;
}
```

The composition root selects a provider. The example uses
`workers-ai-provider@4`:

```ts
const model = createWorkersAI({
  binding: env.AI,
  gateway: {
    id: "default",
    metadata: { codex_transport: "language-model-v4" }
  }
})("@cf/moonshotai/kimi-k2.7-code");
```

The Codex codec in
[`language-model-v4.ts`](../examples/next/harnesses/codex/src/language-model-v4.ts)
converts records as follows:

| Codex record                             | LanguageModelV4 record                           |
| ---------------------------------------- | ------------------------------------------------ |
| system instructions                      | `system` message                                 |
| user or assistant message                | matching V4 message with text content            |
| consecutive `function_call` items        | one assistant message containing every tool call |
| consecutive `function_call_output` items | one tool message containing every result         |
| Codex function tool                      | V4 function tool with JSON Schema                |

The return path preserves ordered V4 content. Text and reasoning blocks become
Codex deltas. Every V4 tool call becomes a Codex function-call item. Response
metadata supplies the response ID, while the V4 finish reason determines whether
the turn completed, needs tools, or failed.

The adapter consumes the complete provider stream before advancing the pure
kernel. It coalesces token-level V4 deltas into one durable event per completed
text or reasoning block. Raw chunks, request bodies, response headers, and
arbitrary `providerMetadata` are not stored.

V4 is the only supported AI SDK model specification. The harness does not ship a
V3 compatibility path. Unsupported V4 content, such as provider-executed tools
or provider-specific custom parts, fails explicitly rather than being dropped.

### Tool-call batches

A model may return several tool calls even when a provider setting asked it not
to. The kernel therefore stores `pending_calls`, not one `pending_call`.
It preserves every call in provider order, journals one effect per call, and
executes the first implementation sequentially. The next model request starts
only after every call in the batch has one durable result.

This matches the important upstream Codex invariant. A later implementation can
add Codex's per-tool parallel-safety gate without changing the model boundary.

### Authentication

The example's V4 model uses the `AI` binding. Cloudflare authenticates the
binding with the Worker account, and `{ gateway: { id: "default" } }` routes the
request through that account's AI Gateway. Application code supplies no API
token. The browser sends only the prompt and session identity.

```text
browser                 prompt and session id
Codex Wasm              Responses records and effect results
Durable Object storage  operations, effects, events, checkpoints
Workspace               repository files
LanguageModelV4         provider transport and credentials
```

Tokens are excluded from checkpoints, Streams records, Workspace, errors, and
telemetry. Another V4 provider can be supplied without changing Codex's kernel
or harness driver.

## Workspace tools

The first environment adapter will use `@cloudflare/shell` directly:

```ts
interface CodexWorkspace {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  readDir(path: string): Promise<FileInfo[]>;
  glob(pattern: string): Promise<string[]>;
  searchFiles(
    pattern: string,
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult>;
  applyEdits(edits: Edit[]): Promise<ApplyEditsResult>;
}
```

The adapter will expose Codex tool names and Codex wire output while delegating
storage mechanics to Workspace. Initial tools are:

- `read_file`;
- `list_dir`;
- `grep_files`;
- `write_file`;
- `apply_patch`;
- `codemode` when enabled.

The read tools will use byte and line caps at the model projection boundary.
Workspace will retain the full bytes. A truncated result will include the next
offset so Codex can continue at the first unread byte and line.

The proof currently exercises `workspace_write` and `workspace_read` against a
real SQLite-backed Workspace. The code is in
[`performWorkspaceTool()`](../examples/next/harnesses/codex/src/codex-harness.ts).

### Apply patch

The kernel will reuse Codex's freeform `apply_patch` tool definition from
`codex-rs/core/src/tools/handlers/apply_patch_spec.rs`, including its Lark
grammar. The JavaScript adapter will parse the patch into Workspace edits,
produce a preview, apply the edits under one Workspace operation, and return the
same function-call output shape Codex expects.

The effect row will retain:

```ts
type ApplyPatchEffect = {
  effectId: string;
  callId: string;
  patch: string;
  files: Array<{
    path: string;
    beforeHash: string | null;
    afterHash: string | null;
  }>;
};
```

Those hashes provide the postcondition used after a wake to decide whether a
pending patch already landed.

## Code Mode

Code Mode is the dynamic execution boundary. The static Codex kernel will expose
a `codemode` tool whose implementation is built from existing packages:

```ts
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import { stateTools } from "@cloudflare/shell/workers";

const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
const providers = [resolveProvider(stateTools(workspace))];
```

The Codex model writes JavaScript. `@cloudflare/codemode` loads that program in
a disposable Worker with network access blocked by default. The generated code
reaches files through `state.*`, which calls the same Workspace the direct tools
use.

This gives the system two execution levels:

```text
trusted static level
  Codex Rust/Wasm kernel
  Lifecycle and effect journal
  Workspace adapters

model-authored dynamic level
  Code Mode JavaScript
  Dynamic Worker
  explicit state.* capabilities
```

The durable Codemode runtime already records connector calls, supports replay,
and can pause for approvals. `CodexHarness` will use the Codemode execution ID as
the Codex effect ID's external idempotency key, then return the terminal Code
Mode result as a Codex function-call output.

## Lifecycle and recovery

### Startup

On every Durable Object incarnation, Lifecycle starts Tasks, Streams, Sessions,
and CodexHarness in installation order. `CodexHarness.onStart()` will:

1. migrate its tables;
2. attach the static Wasm runtime;
3. find running operations;
4. verify that each operation has a Tasks driver;
5. reconcile pending effects;
6. re-project any rollout suffix absent from Sessions or Streams.

The process-local Wasm instance is recreated. Its state comes entirely from the
stored checkpoint supplied on the next transition.

### Operation recovery

A claimed Tasks attempt has a durable deadline. If an isolate disappears, the
next wake replays the driver. The driver reads the operation row and continues
from its latest checkpoint.

Recovery behavior is selected by durable evidence:

| Stored evidence                    | Next action                                             |
| ---------------------------------- | ------------------------------------------------------- |
| operation queued, no checkpoint    | run `start_turn` transition                             |
| checkpoint requests model, no step | run the model step                                      |
| model step journaled               | feed stored frames into the kernel                      |
| workspace step interrupted         | run the idempotent tool again                           |
| model step interrupted             | re-issue the round and accept a rare duplicate call     |
| Code Mode pending                  | inspect the Codemode execution by ID and resume its log |
| transition terminal, stream live   | settle the projection and stream                        |
| operation terminal                 | return the immutable result                             |

### Cancellation

Cancellation is recorded through Tasks, whose step attempt signal aborts the
in-flight model call or tool adapter. The kernel receives the cancellation result at the next
boundary and emits the terminal Codex event. Streams retains all events emitted
before cancellation. The operation result identifies cancellation separately
from a model or tool failure.

### Hibernation

Between turns, the Durable Object has no open model socket and no active kernel
call. Its state is in SQLite, Sessions, Streams, Workspace, and optional R2
segments. Lifecycle can hibernate the object using its normal platform behavior.
The next request or alarm recreates the Wasm instance and reads the checkpoint.

## Streaming and UI projection

Each operation gets one Streams ID:

```text
codex:<thread-id>:<operation-id>
```

Kernel events have a monotonic sequence. The harness inserts each event into the
rollout and appends its public projection to Streams. On recovery, the Streams
cursor identifies the first event that still needs projection.

The public event union begins with:

```ts
type CodexEvent =
  | { seq: number; type: "turn_started"; threadId: string; turnId: string }
  | { seq: number; type: "model_requested"; round: number }
  | { seq: number; type: "reasoning_delta"; delta: string }
  | { seq: number; type: "assistant_delta"; delta: string }
  | {
      seq: number;
      type: "tool_started";
      callId: string;
      name: string;
      arguments: JsonValue;
    }
  | {
      seq: number;
      type: "tool_completed";
      callId: string;
      output: JsonValue;
    }
  | { seq: number; type: "turn_completed"; output: string }
  | { seq: number; type: "turn_failed"; error: CodexError };
```

A client reads a snapshot first, then tails the active operation stream from the
snapshot's cursor. The durable cursor permits reconnect after a tab close,
network interruption, or Durable Object wake.

The current LanguageModelV4 proof emitted 12 compact durable events for a
three-round turn. Both the operation result and `/codex/result.txt` survived an
explicit Durable Object restart during local and production testing.

### Vite React frontend

The example includes a Vite React frontend. Its implementation is
[`examples/next/harnesses/codex/src/client.tsx`](../examples/next/harnesses/codex/src/client.tsx),
with the Cloudflare Vite integration in
[`vite.config.ts`](../examples/next/harnesses/codex/vite.config.ts).

The page uses the same chat structure as the other Agents examples. The header
shows the Durable Object session and model route. A scrolling transcript shows
user prompts, Codex replies, reasoning, and Workspace tool calls. The composer
stays at the bottom and submits on Enter. Completed turns remain visible when
the user starts another operation.

Durability data stays available without dominating the conversation. Each
Codex reply has a collapsed `Run details` section with transition count, kernel
time, terminal wall time, Workspace file contents, checkpoint JSON, and the
restart verification action. Tool cards show a concise read or write summary
and expand to the complete arguments and result.

The browser connects through the `WebSockets` capability with `useAgent`. On
connect it receives a session snapshot, then subscribes to each operation's
Streams log and replays-then-tails it, so model rounds and tool calls appear
before the turn completes and a reload resumes from the last event. Streams is
the only output path; there is no HTTP polling route.

The selected session is retained in browser local storage. Starting a new
session creates a fresh object identity and clears the local transcript. The
frontend uses Kumo components and semantic color tokens, includes the standard
theme toggle and `PoweredByCloudflare`, and remains a thin HTTP client. The
Durable Object and Lifecycle capability own all durable behavior.

## Scaling and cost

### Per-session placement

Each coding session maps to one named Durable Object. Cloudflare places and
scales those objects independently. One busy repository does not serialize work
for another repository.

### Active-turn cost

During a turn, the object holds:

- one small Wasm instance;
- one active model WebSocket;
- the bounded model context needed by the kernel;
- current effect and projection buffers.

Workspace bytes stay in SQLite and optional R2 rather than being copied into
Wasm memory. Tool output is bounded before entering model context.

### Idle cost

Between turns, process-local state is disposable. The Durable Object can
hibernate, leaving only storage. The static Wasm module is part of the Worker
bundle and is compiled through the platform's normal module path.

### Parallel scale

Parallel coding sessions create independent Durable Object instances. Within
one thread, the harness serializes model rounds and state-changing effects to
preserve Codex ordering. Codex can issue parallel read effects when its tool
batch declares them independent. Writes remain ordered by rollout sequence.

### Bundle distribution

The package will ship one Wasm artifact beside the Codex harness entry point.
Applications importing other Agents entry points will not import the Codex
module. The package build will report:

- raw Wasm bytes;
- compressed Wasm bytes;
- JavaScript wrapper bytes;
- cold instance creation time;
- first transition time.

The proof artifact is 186 KiB before gzip. This number will grow as context,
compaction, and complete tool routing move into Rust, so CI will track it on
every upstream update.

## Observability

Every operation will carry:

```text
agent.name
codex.thread.id
codex.turn.id
codex.operation.id
codex.effect.id
codex.effect.kind
codex.model.round
codex.kernel.transition
codex.kernel.ms
codex.checkpoint.bytes
codex.rollout.seq
codex.workspace.operation
codex.codemode.execution.id
```

Metrics will include:

- operation admissions and deduplications;
- transition count per turn;
- Wasm time per transition and per turn;
- checkpoint and rollout byte size;
- model reconnects;
- tool effect duration and retries;
- Workspace bytes read and written;
- Code Mode executions and pauses;
- recovery source, such as checkpoint, completed effect, or effect
  reconciliation;
- time to first assistant delta;
- time to terminal result.

The proof records transition count and aggregate kernel time in its operation
row.

## Security and authority

The Rust/Wasm kernel receives exactly the serialized checkpoint and settled
effect data, and returns a checkpoint, events, and one next action. Workers
bindings, storage handles, buckets, credentials, and Workspace access stay in
the JavaScript adapters that own those resources.

JavaScript adapters hold authority:

- the model adapter holds model credentials or an account binding;
- the Workspace adapter holds filesystem authority;
- the Code Mode adapter holds a Worker Loader binding and passes only selected
  providers into generated code;
- the approval adapter decides which requested effects may proceed.

Every tool action is parsed before it reaches an adapter. Workspace normalizes
paths. Credentials stay in the adapter that uses them. Errors and traces carry
stable IDs and safe summaries, while request headers and credentials remain at
the integration boundary.

## Implementation plan

### Phase 1: direct Lifecycle proof

Files under
[`examples/next/harnesses/codex`](../examples/next/harnesses/codex/README.md)
will prove:

- a plain Durable Object composed with Lifecycle;
- a static Wasm kernel;
- a Codex-compatible Responses function-call loop;
- Tasks-backed durable admission;
- effect intents and results in SQLite;
- replayable Streams output;
- Shell Workspace read and write tools;
- explicit Durable Object restart with state recovery;
- deployed concurrency measurements.

### Phase 2: complete Codex extraction

The Rust crate will add, in this order:

1. the full Responses event parser;
2. Codex response item types;
3. function and custom tool registries;
4. context history construction;
5. model round continuation rules;
6. output truncation;
7. compaction;
8. usage and retry metadata;
9. approval actions;
10. rollout serialization fixtures.

Each addition will import or adapt one named upstream Codex module and add its
source mapping to `provenance.json`.

### Phase 3: LanguageModelV4 transport

The Codex codec translates between Codex Responses records and AI SDK
`LanguageModelV4`. A live Workers AI turn routed through AI Gateway verifies:

- account-authenticated inference through the AI binding;
- V4 messages and function tools;
- single and batched structured tool calls;
- tool outputs returned together on the next model round;
- final assistant text and reasoning;
- AI Gateway metadata;
- model identity stored in the Codex checkpoint.

### Phase 4: Sessions and UI

The Codex rollout will project into `agents/sessions`. A small browser example
will use a snapshot plus Streams cursor to render:

- user input;
- reasoning summaries;
- assistant deltas;
- tool input and output;
- changed files;
- final result;
- recovery status.

### Phase 5: coding tools

The Workspace adapter will add read, list, grep, write, and apply-patch tools.
A pinned sample repository will exercise a complete edit, test, and diff turn.

### Phase 6: Code Mode

The model will receive the `codemode` tool. The generated program will run in a
Dynamic Worker and reach the same Workspace through `stateTools`. Tests will
cover a multi-file read, a deterministic edit, an execution timeout, and durable
Codemode replay.

### Phase 7: R2 rollout segments

Large raw rollout payloads will move into content-addressed R2 segments while
SQLite retains the active checkpoint and ordered manifest. The load test will
measure long-thread startup, hot suffix reads, and compaction without hydrating
the full historical rollout.

## Current evidence

The first direct proof has these properties:

- Rust `1.95.0`, pinned per project;
- `wasm32-unknown-unknown` target;
- 188 KiB release Wasm artifact;
- static module imported into the Worker;
- plain `DurableObject` host;
- `CodexHarness` as a `LifecycleCapability`;
- real `Tasks`, `Streams`, and Shell `Workspace` instances;
- Codex-compatible `response.create`, `function_call`, and
  `function_call_output` shapes;
- AI SDK `LanguageModelV4` through `workers-ai-provider`;
- three model rounds;
- Workspace write followed by verification read;
- six kernel transitions;
- 12 compact durable public events;
- zero Dynamic Workers in the direct design.

Live Kimi K2.7 Code turns exercise `LanguageModelV4` through
`workers-ai-provider`, Workers AI, and AI Gateway. A typical turn makes three
model calls, invokes `workspace_write` and `workspace_read`, verifies the exact
file contents, deduplicates a repeated submission, and retains the result and
file across a Durable Object restart. Model latency dominates; the Wasm
transitions take a few milliseconds each.

The raw V4 stream contains token-level reasoning and text deltas. Coalescing
completed V4 blocks before the pure kernel keeps the durable event count to
roughly a dozen per turn without dropping content. The codec preserves every
tool call in a model response, and the kernel settles a multi-call batch
sequentially before the next model request starts.

The Rust fixture is in
[`wasm-kernel/src/lib.rs`](../examples/next/harnesses/codex/wasm-kernel/src/lib.rs).
The Worker host is in
[`src/server.ts`](../examples/next/harnesses/codex/src/server.ts). The
Lifecycle capability is in
[`src/codex-harness.ts`](../examples/next/harnesses/codex/src/codex-harness.ts).

## Acceptance criteria

The direct Codex capability is ready for an experimental package when:

- a host class extends only `DurableObject`;
- the host constructs `CodexHarness` and installs it with `Lifecycle.use()`;
- the Codex Wasm artifact is carried by the package import;
- the package build owns Rust invocation and the Wasm module name;
- a submitted operation has durable admission before `submit()` resolves;
- every model and tool effect has a stable ID and durable intent;
- a new Durable Object incarnation resumes from the stored checkpoint;
- Workspace contents survive the same restart;
- a live OpenAI-compatible turn through AI Gateway can read, edit, test, and
  report a repository change;
- clients can reconnect from a Streams cursor;
- Code Mode runs generated JavaScript in a Dynamic Worker against the same
  Workspace;
- the package ships Codex provenance and licenses;
- CI rebuilds and verifies the Wasm artifact;
- bundle size, transition time, and recovery behavior have regression tests;
- `pnpm run check` passes for the complete repository.

## Decision

Implement Codex as a static Rust/Wasm `LifecycleCapability` composed onto a
plain Durable Object. Keep durable operations and effects in the owning object,
store files in `@cloudflare/shell` Workspace, and use Dynamic Workers for Code
Mode programs. Package the Wasm and Codex source provenance inside the Codex
entry point so application code expresses only its model, Workspace, and
Lifecycle composition.
