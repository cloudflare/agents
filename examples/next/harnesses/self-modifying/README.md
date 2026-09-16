# Next: self-modifying harness

A full-stack example of a `HarnessRuntime` whose agent loop is itself
editable. `SelfModifyingRuntime` runs editable TypeScript revisions in fresh
Dynamic Workers; the shared `Harness` capability
(`@cloudflare/agents-next-harness`) owns admission, operations, the event
logs, the Tasks driver and the browser link. Both stay local to this example;
neither is an Agents SDK API yet.

```ts
readonly workersAI = createWorkersAI({ binding: this.env.AI });
readonly workspace = new Workspace({
  sql: this.ctx.storage.sql,
  namespace: "self_modifying"
});
readonly tasks = new Tasks();
readonly streams = new Streams();

readonly runtime = new SelfModifyingRuntime({
  workspace: this.workspace,
  loader: this.env.LOADER,
  model: this.workersAI("@cf/moonshotai/kimi-k2.7-code")
});

readonly harness = new Harness<SelfModifyingProtocol>({
  tasks: this.tasks,
  streams: this.streams,
  runtime: this.runtime
});

readonly webSockets = new WebSockets(this.harness.webSockets());

readonly lifecycle = Lifecycle.install(this)
  .use(this.tasks)
  .use(this.streams)
  .use(this.webSockets)
  .use(this.harness);
```

Every connected client can edit source, activate, and restore revisions. The
example has no authentication; put it behind your own before exposing it.

`SelfModifyingRuntimeOptions.model` is exactly AI SDK 7's `LanguageModelV4`.
The Workers AI model from `workers-ai-provider@4` is passed directly.

## Driving it

One developer API, the same as every other harness:

```ts
const session = this.harness.session();
const { operationId } = await session.prompt("Add a roll_die tool");
const result = await session.wait(operationId); // raw: { revisionId, output }
```

Source changes are durable operations of their own, admitted through
`submit()` and settled with their own receipt:

```ts
await session.submit({ kind: "write_source", payload: { path, content } });
await session.submit({ kind: "activate", payload: { note: "add roll_die" } });
await session.submit({ kind: "restore", payload: { revisionId: 2 } });
```

A failed activation settles `failed` with `error.code` set to the phase that
rejected it: `"source"`, `"bundle"` or `"check"`. A failed turn settles with
`error.code: "turn"`. The active revision never moves until a candidate
compiles and passes its isolated check.

The editable harness source lives under `/harness` in a durable
`@cloudflare/shell` Workspace. Activation snapshots that source, bundles it
with `@cloudflare/worker-bundler`, checks it in an isolated Dynamic Worker, and
moves the active revision pointer only after the check succeeds. Every chat
turn pins one revision and loads it with `WorkerLoader.load()`, so module
globals never carry between turns.

## Tools

The example has two tool types:

- **System tools** are fixed trusted capabilities supplied by the runtime.
  They read and write source, activate revisions, restore revisions, and
  append journal entries. They execute in the Durable Object through RPC.
- **Custom tools** are editable `CustomTool` exports under
  `/harness/src/tools/`. They execute inside the turn's Dynamic Worker. The
  agent can create or replace them.

Activation discovers every Custom tool file and generates its registry. A
Custom tool cannot shadow a System tool. Creating a tool requires one source
file and an activation, with no registry edit.

Tool calls reach the browser as the core `tool_start` / `tool_end` frames
every harness emits, model rounds as `{ type: "extension" }` frames, and each
trusted journal record as `{ type: "extension", body: { type: "journal" } }`.

## Run

Worker Loader access is required for this early-access example. The Workers
AI binding is remote, so if your Wrangler login has access to more than one
account, set `CLOUDFLARE_ACCOUNT_ID` when starting.

```sh
pnpm install
pnpm run start
```

Open the Vite URL and try:

```text
Create a Custom tool named roll_die that accepts a number of sides. Inspect the
existing Custom tool example, write the new tool file, activate the harness,
and tell me the new revision.
```

The next chat message runs the new revision and can call `roll_die`. The header
shows the active revision. The inspector shows the active revision's exact
code in an editor, the revision history with a restore action, and the trusted
activity journal.

The browser uses `useHarnessSession()` from
`@cloudflare/agents-next-harness/react` for everything on the session: the
transcript, live token previews, `prompt()` and `submit()`. Everything about
the _host_ rather than the session (the active revision, its source, the
revision list, the journal) is one plain HTTP route on the Durable Object,
`GET /agents/self-modifying-harness/<name>/snapshot`, served by `onRequest`
and refreshed after every settled operation.

## Test

```sh
pnpm run test
```

The Workers-runtime tests cover V4 model conversion, fresh isolates, a
detached prompt driven by the Harness driver, the durable event log, source
activation, failed-candidate recovery, a failing turn's settlement, System and
Custom tool composition, System-name collision rejection, automatic Custom
tool discovery, use on the next revision, and forward restore.

## Review map

- `src/self-modifying-runtime.ts`: the `HarnessRuntime`: `drive()`, activation, the pinned turn
- `src/harness-runtime.ts`: activation, Worker Bundler, and Custom tool discovery
- `src/system-tools.ts`: immutable System tool definitions
- `src/host-bridge.ts`: turn-scoped RPC authority and effect journal
- `src/model-runner.ts`: trusted `LanguageModelV4` projection
- `src/store.ts`: revisions, builds, the transcript, and the trusted journal
- `src/seed.ts`: editable genesis harness
- `src/protocol.ts`: the `HarnessProtocol` and the snapshot the UI reads
- `src/server.ts`: the Durable Object and its `snapshot` route
- `src/client.tsx`: chat, editor, and inspector over `useHarnessSession()`

The design rationale and measured evidence are in
[`design/rfc-self-modifying-harness.md`](../../../../design/rfc-self-modifying-harness.md)
and [`design/rfc-harness-capability.md`](../../../../design/rfc-harness-capability.md).
