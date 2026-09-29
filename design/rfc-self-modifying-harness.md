Status: proposed

# Self-modifying harness in a Dynamic Worker

## The problem

A long-running agent should be able to change more than its identity prompt or
install individual tools. It should be able to inspect and edit the code that
assembles context, selects tools, calls the model, handles tool results, and
ends a turn.

That code still needs durable state, credentials, recovery, and a safe way to
adopt a replacement. Giving mutable agent code direct access to Durable Object
storage and account bindings would mix behavior with authority. Replacing live
code without a build gate would also let one syntax error strand the agent.

## The proposal

Store the complete editable harness project under `/harness` in a Shell
Workspace. Compile source snapshots with Worker Bundler. Load the active bundle
into a fresh Dynamic Worker for every turn.

A small trusted Lifecycle capability owns authority and recovery:

```ts
export class SelfModifyingHarnessObject extends DurableObject<Env> {
  readonly workersAI = createWorkersAI({ binding: this.env.AI });
  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "self_modifying"
  });
  readonly tasks = new Tasks();
  readonly streams = new Streams();
  readonly harness = new SelfModifyingHarness({
    tasks: this.tasks,
    streams: this.streams,
    workspace: this.workspace,
    loader: this.env.LOADER,
    model: this.workersAI("@cf/moonshotai/kimi-k2.7-code")
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.harness);
}
```

The proof is implemented in
[`examples/next/harnesses/self-modifying`](../examples/next/harnesses/self-modifying/README.md).
It does not use `Agent`, `AIChatAgent`, a Durable Object mixin, or an alternate
Durable Object base class.

## Ownership

`SelfModifyingHarness` owns:

- the active revision pointer;
- source snapshots and compiled bundles;
- activation history;
- turn admission and revision pinning;
- the append-only journal;
- model and tool effect evidence;
- the temporary RPC authority passed to editable code;
- projection into Streams and visible messages.

The editable project owns:

- identity and instructions;
- context assembly;
- the model round loop;
- model-visible tool definitions;
- Custom tool implementations;
- decisions to edit or activate itself;
- its terminal turn result.

The application composition root owns the model and Loader binding.
`SelfModifyingHarnessOptions.model` is exactly AI SDK 7's `LanguageModelV4`.
`workers-ai-provider@4` returns that interface directly, so the composition root
passes a Workers AI model without a harness-specific wrapper or raw `Env`.

## Editable project

Genesis writes this project into Workspace:

```text
/harness/
  package.json
  src/
    index.ts
    identity.ts
    types.ts
    tools/
      describe-self.ts
```

Each Custom tool has its own source file under `src/tools/`. During activation,
the trusted compiler discovers every exported `CustomTool` and generates a
virtual registry module. The module publishes Custom definitions to Workers AI
and dispatches selected calls in the turn isolate. Creating a tool means writing
one file and activating the candidate source snapshot.

`src/index.ts` default-exports this contract:

```ts
interface EditableHarness {
  manifest: {
    name: string;
    version: string;
  };
  runTurn(
    input: HarnessTurnInput,
    host: HarnessHost
  ): Promise<HarnessTurnResult>;
}
```

The source is ordinary TypeScript. It may split into more files, add local
tools, or change the whole turn loop. `package.json` can declare dependencies
that Worker Bundler can resolve. Production policy can restrict registries and
package versions without changing the editable contract.

## Immutable entry module

Worker Bundler receives the source snapshot plus one generated module named
`__self_modifying_entry.ts`. That module imports `/harness/src/index.ts` and
exposes
`check()` and `run()` from a `WorkerEntrypoint`.

This generated module is not part of the working tree. It preserves the host
RPC contract even when the editable project reorganizes itself. Its only jobs
are shape checking and delegation.

## Activation

The working tree and active revision are different states. File edits do not
change running behavior.

`activate_harness` performs:

1. read every `/harness` source file from Workspace;
2. canonicalize and hash the source map;
3. bundle the snapshot with `createWorker()`;
4. load the candidate with `WorkerLoader.load()` and no outbound network;
5. call the generated `check()` entrypoint;
6. persist the content-addressed build;
7. append a monotonic revision whose parent is the current active revision;
8. update `active_revision` in the same synchronous SQLite transaction;
9. append `harness_activated` to the trusted journal.

A source, bundle, or check failure appends `harness_activation_failed`. The
active pointer does not move.

Restore copies an earlier source snapshot into the working tree and activates
it under a new revision ID. History always moves forward:

```text
v1 genesis -> v2 changed identity -> v3 restored v1 source
```

Builds are keyed by source hash, so v1 and v3 may share compiled bytes while
remaining separate historical decisions.

## Turn execution

Admission reads the active revision and stores that revision ID on the turn.
The Tasks run uses the same pinned revision on every replay.

```text
admit turn
  -> persist turn, user message, and Streams log
  -> enqueue Tasks run
  -> load pinned bundle with WorkerLoader.load()
  -> pass HarnessTurnInput and a new SelfModifyingTurnHost RPC target
  -> editable harness controls model rounds and tool routing
  -> persist assistant result
  -> close Streams log
```

`WorkerLoader.load()` creates a one-shot Worker rather than retrieving a named
cached Worker. Each turn begins with fresh module globals. The proof exposes an
`isolateRun` counter from editable module scope. Consecutive turns both report
`1`.

A turn activated under v1 remains on v1 even if it calls `activate_harness` and
creates v2. The next admitted turn reads v2. This makes source changes visible
at a clear turn boundary.

## System authority

The Dynamic Worker receives a `SelfModifyingTurnHost` as an RPC call argument.
It does not receive `Env` bindings. The host currently exposes:

```ts
interface HarnessHost {
  infer(request: HarnessInferenceRequest): Promise<HarnessInferenceResult>;
  callTool(callId: string, name: string, input: JsonValue): Promise<JsonValue>;
  note(key: string, text: string): Promise<void>;
}
```

`infer` accepts the instructions, messages, and Custom tool definitions chosen
by editable code. `SelfModifyingHarness` owns the `generateText()` projection
onto its injected `LanguageModelV4`. The trusted host adds its immutable System tool definitions
immediately before calling Workers AI. A Custom tool whose name conflicts with
a System tool is rejected. The model adapter authenticates the request and
returns text plus unexecuted tool calls. The editable harness decides what to
execute and whether to continue.

`callTool` executes the System operations needed for self-improvement:

- `read_file`
- `write_file`
- `delete_file`
- `list_files`
- `activate_harness`
- `list_revisions`
- `restore_revision`
- `journal_note`

Source paths are confined to `/harness`. The proof accepts at most 256 source
files, 1 MB per file, and 4 MB for one snapshot. Custom tools run directly in
editable code. Adding a Custom tool means writing its file under `src/tools/`
and activating the new revision. Activation rejects modules without an exported
`CustomTool`, duplicate Custom names, and Custom names that shadow System tools.

The loaded Worker has `globalOutbound: null` and explicit CPU and subrequest
limits. It cannot read the Durable Object database, Workers AI binding, Loader,
or account credentials.

## Durable effects and recovery

Tasks replays its handler after process loss. The handler starts a fresh
Dynamic Worker from the turn's pinned bundle.

The host records external effects under stable identities:

```text
model:<round>
tool:<tool-call-id>
```

Each effect row contains a request hash, state, and terminal result. A replay
with the same identity and request returns the stored result. Reusing an
identity with different input is a protocol error.

A tool write is therefore not repeated after its result was recorded. An
activation uses a unique activation key derived from the turn and tool call,
so a replay cannot append another revision. A model request interrupted before
its terminal result may run again. This can repeat provider cost, but it cannot
repeat a filesystem or activation mutation. A future model adapter can attach a
provider idempotency key when the selected protocol supports one.

Streams events also have stable event keys. Replayed task code appends only
missing events. If the process disappears after the Dynamic Worker returns but
before the turn settles, the memoized Tasks step supplies the same terminal
result and the host finishes the turn and stream.

## Storage

The trusted SQLite tables are:

- `self_modifying_builds`: source hash, source snapshot, and compiled modules;
- `self_modifying_revisions`: monotonic activations and parent revision;
- `self_modifying_metadata`: active revision pointer;
- `self_modifying_turns`: admission, pinned revision, and terminal result;
- `self_modifying_messages`: visible user and assistant messages;
- `self_modifying_journal`: trusted append-only history;
- `self_modifying_effects`: model and tool intent and result evidence;
- `self_modifying_stream_events`: replay fence for Streams projection.

Workspace remains the durable editable filesystem. The build and revision
tables are trusted metadata, so editable code cannot rewrite history by editing
a file.

## Product UI

The app presents chat as the main product. The header shows the active
revision. Each assistant message records the pinned revision that produced it
and shows its tool calls as they happen. The browser connects through the
`WebSockets` capability with `useAgent`: it receives an object snapshot on
connect, subscribes to each turn's Streams log to replay-then-tail its events,
and submits turns through the durable Tasks path. There is no HTTP polling.

A side inspector, available from the chat header, has three read-only views:

- Code shows every file from the exact active revision snapshot.
- Revisions shows activation notes, source hashes, the active revision, and a
  restore action that activates an older snapshot as a new forward revision.
- Activity shows the trusted append-only journal.

The inspector does not edit source. The agent changes its code through normal
chat tool calls, so source edits and activation remain part of the
model-visible turn and its durable journal.

## Current evidence

The Workers-runtime integration tests prove:

- genesis bundles and validates inside workerd;
- two turns both report module-scope `isolateRun: 1`;
- a Workspace edit remains dormant before activation;
- a valid activation changes the next turn's behavior;
- a syntax error is rejected during bundling and leaves the last active build
  runnable;
- the editable harness can call `write_file` and `activate_harness` itself;
- one turn writes a new Custom tool file, auto-discovers it, and activates
  revision 2;
- the next turn sees and executes that tool from revision 2;
- restoring v1 after v2 creates v3 with v2 as its parent.

A fresh production object proved automatic Custom tool discovery with Workers
AI through the exact `LanguageModelV4` constructor contract. Revision 1 had no
editable registry or System definitions. In four model rounds it inspected the
example, wrote only `src/tools/auto-probe.ts`, and activated revision 2. The next
chat turn was pinned to revision 2, called `auto_probe`, and returned
`auto discovered: LanguageModelV4`. The active revision endpoint returned the
generated implementation source. An older revision using the previous combined
tool protocol also continued to run its existing Custom tool after deployment.

The Vite production build contains the host Worker, the esbuild Wasm module
used by Worker Bundler, and the Kumo chat client:

| Artifact        |           Raw |         Gzip |
| --------------- | ------------: | -----------: |
| Host Worker JS  |  1,723.99 KiB |   361.44 KiB |
| esbuild Wasm    | 13,940.12 KiB | 3,790.39 KiB |
| Client entry JS |  1,084.60 KiB |   339.98 KiB |
| Client CSS      |    150.58 KiB |    23.83 KiB |

Streamdown's code plugin emits syntax languages as separate lazy chunks rather
than including them in the client entry. The deployed Worker has three
bindings: the Durable Object, Workers AI, and Worker Loader.

## Scope

This remains an example-only implementation under
`examples/next/harnesses/self-modifying`. `SelfModifyingHarness` is not exported
from `agents`, does not define an SDK API, and does not require a changeset.

Possible example improvements include a compiled bundle byte limit, npm
registry and dependency policy, cancellation, process-loss tests at model and
tool boundaries, canary evaluation before activation, and explicit retention
for builds, effects, Streams logs, and journal rows. These are not commitments
to a package version.

## Alternatives

### Hot-load individual hooks and tools

The earlier dynamic self-improvement experiment loaded tool modules and
optional runtime hooks while the main model loop remained stable application
code. That is useful for
extensions but does not let the agent replace context assembly or turn
orchestration. This proposal makes the complete turn entrypoint editable.

### Run editable code directly in the Durable Object

This avoids Worker Loader startup, but editable code would share an isolate
with storage and credentials. Module globals could also survive between turns.
The Dynamic Worker boundary is worth its cost for this use case because the
code itself is the object being modified.

### Rebundle on every turn

This guarantees current working source, but it removes an explicit adoption
boundary and pays esbuild cost when no source changed. Activation compiles once.
Turns load the persisted bundle for their pinned revision.

## Decision

Ship the implementation as an early-access example only. Revisit package
extraction separately if the example produces a stable reusable contract.
