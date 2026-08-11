# RFC: Replay-safe Code Mode + Computer execution for RLMs

Status: proposed

## The problem

The Code Mode RLM example already implements the smallest useful Code
Mode–Computer composition. Each root and child Durable Object owns a
[`@cloudflare/computer`](https://github.com/cloudflare/computer) Workspace
backed by its storage and exposes `read`, `ls`, `write`, and `edit` methods
through `ToolSetConnector`. Reads, writes, and edits have configured byte
limits; the current Computer `ls` tool is not paginated or bounded. Generated
programs still run in fresh, network-isolated Dynamic Worker passes, and the
model still sees only the `codemode` tool.

The example deliberately uses a hybrid retained-memory model:

- ordinary JavaScript variables are scratch state for one Dynamic Worker pass;
- the JSON kernel stores compact structured notebook values; and
- Computer stores larger or reusable per-agent files in the conventional
  `/workspace` subtree of its isolated VFS.

Both retained layers survive later turns and Durable Object restarts, but
neither is a live interpreter heap. The custom RLM store remains authoritative
for external-input admission, the JSON kernel, verified answers, recursive
operation claims, and harness revisions.

This RFC starts from that implemented filesystem baseline. It proposes the
additional contracts needed for replay-safe Computer command execution:
cross-layer mutation receipts, command admission and attachment, backend
discovery, contract revision pinning, and complete cancellation. A long-lived
`openSession/evaluate/interrupt/close` runtime is an optional later extension;
it is not required by the filesystem-first example.

The target composition preserves these invariants:

- the model receives only the `codemode` tool;
- Code Mode remains the generated-program control plane;
- Computer owns durable files and command execution;
- connector types and policies are discoverable from generated JavaScript;
- a pause, eviction, timeout, or host crash does not silently duplicate an
  external mutation; and
- a local, same-Durable-Object deployment needs no MCP, HTTP hop, or bearer
  token at the Code Mode–Computer boundary.

It does not replace the example's Think/Agents architecture.

## Implementation boundary

| Capability                  | Current example                                   | Proposed or optional                        |
| --------------------------- | ------------------------------------------------- | ------------------------------------------- |
| Model-facing interface      | Only `codemode`                                   | Unchanged                                   |
| Live JavaScript heap        | One fresh Worker pass                             | Optional computerd session                  |
| Compact retained memory     | Durable JSON kernel                               | Implemented                                 |
| Artifact memory             | Durable per-agent Computer files                  | Implemented                                 |
| Computer command execution  | Not configured or exposed                         | Proposed after replay hardening             |
| Tool schemas                | Inputs generated; supplied outputs preserved      | Add output schemas to Computer tools        |
| Approval/replay policy API  | Implemented in `ToolSetConnector`                 | Decide and configure example policies       |
| Stable connector call ID    | Implemented for runtime dispatch                  | Add Computer receipts keyed by it           |
| Timeout abort               | Best-effort and initiated by the executor timeout | Add caller cancellation and termination ack |
| Persistent language session | Not implemented                                   | Optional container/computerd capability     |

## Existing building blocks

### Code Mode

Code Mode supplies one AI SDK-compatible model tool, a network-isolated Dynamic
Worker executor, connector discovery, TypeScript generation from JSON Schema,
durable call logging, approval pause/resume, snippets, and an execution audit.
Each execution pass uses a fresh Worker; persistence belongs in connectors, not
its JavaScript heap. Approval resume replays earlier connector observations in
a new pass rather than restoring the heap.

`ToolSetConnector` adapts an AI SDK `ToolSet` into one connector namespace. The
adapter on this branch also drains an async-iterable tool to its terminal
snapshot, preserves `outputSchema`, forwards a stable per-call ID and sandbox
timeout signal, and accepts declarative approval/replay policies.
Those capabilities depend on the source tool metadata: Computer's filesystem
tools currently supply input schemas but no output schemas, so their arguments
are typed while their return values remain `unknown`.

### Computer

Computer's `Workspace` is an authoritative SQLite-backed filesystem. Its
`workspace.runtime.exec()` selects a registered backend by stable ID. The
currently shipped backends cover full Linux containers, a just-bash Dynamic
Worker, and a callable JavaScript Dynamic Worker. `createAITools()` supplies AI
SDK `read`, `ls`, `write`, `edit`, optional `exec`, and optional `publish`
tools.

The direct filesystem seam is structurally composable now:

```ts
import { toolSetConnector } from "@cloudflare/codemode/ai";
import { createAITools } from "@cloudflare/computer/tools";

const workspaceConnector = toolSetConnector(ctx, {
  name: "workspace",
  instructions:
    "Durable files in this agent's isolated VFS; use /workspace by convention.",
  tools: createAITools({ workspace, assets: false })
});
```

The example now uses this direct seam without approval policies and runs a
Worker-pool test that discovers the generated namespace, writes and edits a
file, then reads it through a later request to the same Durable Object. The
broader crash/replay contract below is not implemented by that test.

## The proposal

### Implemented filesystem composition

```text
model
  `-- codemode({ code })                  only model-facing tool
        `-- fresh Code Mode Worker pass
              |-- context.* / kernel.*
              |-- rlm.* / harness.*
              `-- workspace.*
                    `-- Computer Workspace.fs
                          `-- Durable Object SQLite storage
```

The Workspace is constructed without execution backends, and `createAITools()`
is called without `shell`. Generated programs can read and mutate durable files
but cannot currently ask Computer to execute a command or retain a language
process. Each child owns a different Workspace; the root and children do not
share files implicitly.

### Proposed execution extension

```text
model
  `-- codemode({ code })
        `-- Code Mode Worker pass          orchestration and replay owner
              `-- execution connector
                    `-- Computer Workspace.runtime
                          |-- worker-shell
                          |-- worker-javascript
                          `-- container/computerd
```

Code Mode remains the executor for the model-generated orchestration program.
Computer executes only an explicitly requested command or module. Computer's
Worker JavaScript backend is not a drop-in Code Mode executor because it does
not implement Code Mode's connector proxy, durable call journal, approval, or
replay contracts.

A single Durable Object may own both the Code Mode runtime facet and Computer
Workspace. Browser automation, APIs, recursive model calls, and the continual
harness stay separate Code Mode connectors. This keeps credentials and
capability policy on the host while the generated Worker receives typed RPC
namespaces only.

Think continues to own the outer model-turn loop and durable submissions. That
choice is independent of the Code Mode–Computer connector boundary.

### JavaScript-native contracts and generated types

Connector authors should not maintain a separate `defineTypes()` string. The
JavaScript/TypeScript-native source of truth is a tool object with Standard
Schema-compatible input and output schemas, such as an AI SDK `tool()` built
with Zod. Code Mode converts those schemas into the `workspace.*` declarations
returned by `codemode.describe()`.

On this branch, Code Mode resolves supplied input and output schemas and uses
them in connector- and method-level declarations. Computer should add an
`outputSchema` to every file tool. Until then, Workspace arguments are typed but
results remain `unknown`. Handwritten declaration strings are an escape hatch
for dynamic APIs, not the default integration.

Connector metadata also needs a stable `revision`. Code Mode should record the
connector name and revision with an execution and saved snippet, and refuse to
resume when the callable contract changed. Otherwise a paused program can
replay against different types or policies after deployment.

### Policy and replay

The implemented experimental connector exposes byte-bounded `read`, `write`,
and `edit` plus an unpaginated `ls`. Calls and results remain in Code Mode's
durable log. A production integration should bound or paginate listings. It
may also require approval for mutations, and applications may opt a large,
idempotent read into `replay: "reexecute"` only when freshness is more important
than deterministic replay. Approval does not solve crash replay; the receipt
contract below is still required.

Every connector invocation receives:

```ts
type ToolExecuteContext = {
  executionId: string;
  seq?: number;
  callId?: string;
  abortSignal?: AbortSignal;
};
```

`seq` and `callId` are present on runtime-dispatched calls and optional only for
backwards-compatible direct connector calls. `callId` is stable across a
pause/resume replay, but identity alone does not provide exactly-once effects.
Code Mode marks a call `executing` before invoking the host; if the host dies
after the effect and before `recordResult`, it must invoke the connector again.
Computer therefore needs an invocation receipt or idempotency journal keyed by
`callId` for writes, publishing, and command admission. For Workspace
mutations, the effect and receipt should commit in the same SQLite transaction.

Command execution needs an `execOnce`/attach contract:

1. admit a command under `callId`;
2. return the existing handle when that ID is already running;
3. return the recorded terminal result when it already completed; and
4. never dispose and restart a known execution merely because the caller
   reconnects.

Approval remains a policy decision, not an idempotency mechanism. A crash can
occur after an approved effect just as it can after an unapproved one.

### Streaming, cancellation, and result bounds

Computer's exec AI tool is an async generator of progressive snapshots. A
single Code Mode connector call records only the last snapshot as its durable
result. Live progress belongs in the Computer execution log and UI trajectory,
not in repeated Code Mode return values.

The implemented path propagates a Code Mode executor timeout into
`ToolExecuteContext.abortSignal`, and `ToolSetConnector` forwards that signal
through AI SDK execution options. Cancellation is deliberately best-effort:
the executor dispatches connector abort hooks without waiting for arbitrary
cleanup promises. Caller-initiated cancellation and confirmation that a
Computer process actually terminated remain future work. Before `exec` is
exposed, a timed-out orchestration Worker must not be able to leave an
unobserved container or shell command running.

Both sides retain their own bounds:

- Computer caps stdout, stderr, file reads, and structured results before they
  cross the connector boundary.
- Code Mode caps each durable args/result value and the final model-facing
  envelope.
- Large artifacts stay in Workspace and return a path plus compact metadata.

### Backend discovery

Computer should expose `workspace.describeBackends()` rather than require a
second hand-maintained description map. Each descriptor should include:

```ts
type BackendDescriptor = {
  id: string;
  type: string;
  protocol: "command" | "module";
  description: string;
  callable: boolean;
  reattachable: boolean;
  filesystem: "shared" | "synced";
  egress: string;
};
```

The exec tool and Code Mode type/discovery surface should derive from the same
descriptors. A backend revision joins the connector revision recorded for
resume safety.

### Optional future: a process-lifetime heap session

The implemented JSON kernel and Workspace files preserve data, not JavaScript
object identity. Closures, module namespaces, class instances, generators, and
open resources disappear after each Dynamic Worker pass.

A later Computer runtime could expose:

```ts
const session = await workspace.runtime.openSession({
  backend: "container",
  language: "javascript"
});

await session.evaluate(source);
await session.interrupt();
await session.close();
```

This is an optional connector capability, not a replacement for Code Mode's
planner executor. The generated orchestration program would call the session
through a typed namespace while Code Mode continued to own call logging,
approval, and replay.

Such a session is process-lifetime rather than fully durable. A
container/computerd implementation could survive a Code Mode Worker, Capnweb
transport, or Durable Object reconnect while the same computerd process
remains alive. A container restart, computerd restart, child crash, or forced
kill loses the heap and must return an explicit lost-session error. Durable
JSON and files remain the restart-recoverable checkpoint layer. Computer's
current Worker JavaScript backend creates a fresh Dynamic Worker per execution
and cannot provide this reconnectable heap across Durable Object incarnations.

### Remote laptop backend

A laptop is a later `WorkspaceBackend`, not a special Code Mode transport. The
first implementation should stay local or use a private Container binding.
Public remote computerd needs reverse dialing, pairing, mutually authenticated
transport, workspace ownership, tenant authorization, protocol negotiation,
and revocation. A routing key or reachable WebSocket URL is not authorization.

## Implementation sequence

1. **Implemented filesystem baseline:** per-agent Computer Workspace with
   byte-bounded `read`, `write`, and `edit` plus `ls`, exposed inside Code Mode.
2. **Implemented adapter layer:** terminal async-iterable results, supplied
   output schemas, policy maps, stable runtime call IDs, timeout signals, and
   method-level declarations.
3. **Finish the filesystem seam:** decide whether example writes require
   approval, add Computer output schemas, bound or paginate `ls`, and test
   Workspace isolation. If `/workspace` becomes an enforced subtree rather
   than a prompt convention, make the confinement symlink-safe.
4. **Replay-safe effects:** add mutation receipts and `execOnce`/attach keyed by
   `callId`; pin connector and backend revisions.
5. **Computer execution:** expose `exec` only after cancellation,
   deduplication, and backend discovery work end to end.
6. **Optional live sessions:** prototype
   `openSession/evaluate/interrupt/close` on container/computerd without making
   it a prerequisite for the RLM example.
7. **Remote backends:** add authenticated remote computerd/laptop attachment
   only after local replay and isolation tests pass.

## Required validation

The current branch validates connector discovery, generated-program
write/read persistence across fresh Worker passes, direct write/edit/read
calls, stable call IDs, and best-effort timeout signaling. The remaining system
boundary requires:

- read → approval pause → Durable Object eviction → resume uses the recorded
  read result;
- a crash after a mutation or command admission does not duplicate work;
- Code Mode timeout aborts and kills the Computer execution;
- Worker shell/container file changes are visible to later host reads;
- two Durable Object/session identities cannot see each other's workspaces;
- any future `/workspace` path-confinement wrapper rejects traversal and
  symlink escapes;
- readonly configuration omits every mutation and execution method;
- connector or backend revision drift rejects resume;
- a remote backend rejects unauthenticated and wrong-tenant attachment.

The RLM example also needs one deterministic, passing system evaluation before
ARC is treated as more than a smoke workload: external-context retrieval,
durable Workspace mutation, replay, terminal completion, and one bounded child
call should all succeed under forced restart.

## Alternatives

### Expose Computer tools directly to the model

This loses the one-tool RLM boundary and makes tool count, intermediate output,
and context growth properties depend on the provider. Code Mode should remain
the model's programming interface.

### Replace Code Mode execution with a Computer backend

Rejected for orchestration because it duplicates Dynamic Worker lifecycle and
disconnects connector replay from the program making the calls. In particular,
Computer's Worker module runner does not implement Code Mode's connector proxy,
approval, call journal, or replay contracts. Computer backends remain
appropriate for explicit workspace commands and modules.

### Bridge through MCP or HTTP

This adds serialization, authentication, discovery, and failure modes inside a
same-object composition. It remains useful when Computer is genuinely remote,
but is not the local default.

### Keep `@cloudflare/shell` as a second Workspace implementation

`@cloudflare/shell` already supplies a Code Mode state connector and is a useful
interim implementation. Long term, maintaining two durable Workspace and
execution abstractions creates overlapping policy, replay, and filesystem
semantics. The preferred direction is a thin Code Mode adapter over Computer's
Workspace rather than parallel data planes.

## Tradeoffs

The implemented baseline provides durable JSON, durable files, and durable Code
Mode call history. It does not provide a retained process or reattachable
Computer execution in this example.

The proposed execution layer adds a cross-package exactly-once boundary and
requires coordinated releases. In return, each layer has one job: Code Mode
owns orchestration and replay, Computer owns durable files and requested
processes, and Think owns model turns. Mutation receipts and contract revisions
add storage and complexity, but without them the durable replay claim stops at
the boundary where the most expensive side effects occur.

An optional live session would improve fidelity for non-serializable state but
would be less restart-durable than the existing JSON/file layers and require
explicit checkpointing conventions.

## Decision

The filesystem-only composition and generic ToolSet adapter are implemented on
this branch. The example uses the hybrid JSON/file memory model and does not
require a live heap. This RFC remains proposed for mutation receipts, Computer
execution, backend discovery, contract revision pinning, remote attachment,
and the optional live-session runtime. None of those later capabilities gates
the current example.

## Source audit

Audited 2026-08-11 against:

- Agents `main` at
  [`48eeba71`](https://github.com/cloudflare/agents/tree/48eeba71f59eee41fc541b215150377e0aba3593)
- Computer `main` at
  [`9422fc8`](https://github.com/cloudflare/computer/tree/9422fc860494f51a79eb0c525565026abf82aff6)
- [Code Mode connector contract](https://github.com/cloudflare/agents/blob/48eeba71f59eee41fc541b215150377e0aba3593/packages/codemode/src/connectors/base.ts#L24-L267)
- [Code Mode durable runtime](https://github.com/cloudflare/agents/blob/48eeba71f59eee41fc541b215150377e0aba3593/packages/codemode/src/runtime.ts#L412-L526)
- [Computer AI tools](https://github.com/cloudflare/computer/blob/9422fc860494f51a79eb0c525565026abf82aff6/packages/computer/src/tools/ai.ts#L10-L43)
- [Computer streaming exec tool](https://github.com/cloudflare/computer/blob/9422fc860494f51a79eb0c525565026abf82aff6/packages/computer/src/tools/exec.ts#L174-L297)
- [Computer backend interface](https://github.com/cloudflare/computer/blob/9422fc860494f51a79eb0c525565026abf82aff6/packages/computer/src/backend.ts#L31-L100)
- [Computer Workspace runtime](https://github.com/cloudflare/computer/blob/9422fc860494f51a79eb0c525565026abf82aff6/packages/computer/src/runtime/runtime.ts#L30-L133)

The commit links establish the upstream baseline. Statements about the generic
ToolSet adapter and the Computer-backed example refer to this RFC's
implementation branch, not Agents `main` at the audited commit.
