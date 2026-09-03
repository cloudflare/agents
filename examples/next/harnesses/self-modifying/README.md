# Next: self-modifying harness

A full-stack example of a `SelfModifyingHarness` Lifecycle capability that runs
editable TypeScript revisions in fresh Dynamic Workers. The class and all of
its implementation stay local to this example; this is not an Agents SDK API.

```ts
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
```

`SelfModifyingHarnessOptions.model` is exactly AI SDK 7's `LanguageModelV4`.
The Workers AI model from `workers-ai-provider@4` is passed directly.

The editable harness source lives under `/harness` in a durable
`@cloudflare/shell` Workspace. Activation snapshots that source, bundles it
with `@cloudflare/worker-bundler`, checks it in an isolated Dynamic Worker, and
moves the active revision pointer only after the check succeeds. Every chat
turn pins one revision and loads it with `WorkerLoader.load()`, so module globals
never carry between turns.

## Tools

The example has two tool types:

- **System tools** are fixed trusted capabilities supplied by
  `SelfModifyingHarness`. They read and write source, activate revisions,
  restore revisions, and append journal entries. They execute in the Durable
  Object through RPC.
- **Custom tools** are editable `CustomTool` exports under
  `/harness/src/tools/`. They execute inside the turn's Dynamic Worker. The
  agent can create or replace them.

Activation discovers every Custom tool file and generates its registry. A
Custom tool cannot shadow a System tool. Creating a tool requires one source
file and an activation, with no registry edit.

## Run

Worker Loader access is required for this early-access example.

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
shows the active revision. The read-only inspector shows its exact code,
revision history, and trusted activity journal.

## Test

```sh
pnpm run test
```

The Workers-runtime tests cover V4 model conversion, fresh isolates, queued
Tasks execution, Streams events, source activation, failed-candidate recovery,
System and Custom tool composition, System-name collision rejection, automatic
Custom tool discovery, use on the next revision, and forward restore.

## Review map

- `src/self-modifying-harness.ts`: Lifecycle capability and Tasks driver
- `src/harness-runtime.ts`: activation, Worker Bundler, and Custom tool discovery
- `src/system-tools.ts`: immutable System tool definitions
- `src/host-bridge.ts`: turn-scoped RPC authority and effect journal
- `src/model-runner.ts`: trusted `LanguageModelV4` projection
- `src/seed.ts`: editable genesis harness
- `src/client.tsx`: chat and active-revision inspector

The design rationale and measured evidence are in
[`design/rfc-self-modifying-harness.md`](../../../../design/rfc-self-modifying-harness.md).
