# Code Mode Recursive Language Model

The Code Mode RLM is an experimental full-stack example that composes Think,
the Agents SDK, Code Mode, and Cloudflare Computer into a durable Recursive
Language Model. A Vite, React, and Kumo frontend provides the chat surface; the
model sees exactly one tool: `codemode`.

**Status:** experimental example
([`examples/codemode-rlm`](../examples/codemode-rlm)).

Related documents:

- [Example README](../examples/codemode-rlm/README.md) — setup and usage
- [Research notes](../examples/codemode-rlm/RESEARCH.md) — Prime Agent/RLM comparison
- [Suggested SDK changes](../examples/codemode-rlm/SUGGESTED_SDK_CHANGES.md) — framework gaps found while simplifying
- [Code Mode + Computer RFC](./rfc-codemode-computer-rlm.md) — proposed durable Workspace and execution data plane
- [Think durable submissions](./think-durable-submissions.md), [agent tools](./agent-tools.md), and [Code Mode runtime](../docs/codemode/runtime.md)

## Problem and goals

An RLM needs to inspect inputs that are too large to repeat in each model
request, write programs over that material, preserve useful state, and delegate
bounded semantic work. A durable implementation must also survive retries
without repeating child work or serving an answer from a failed program.

The example should demonstrate those ideas using framework-owned primitives:

- keep full task material outside the active model context;
- expose only Code Mode to the model;
- use Think for recoverable root and child turns;
- use Agents for one-shot and retained child orchestration;
- use a Computer Workspace for durable per-agent files;
- verify `kernel.finish` against its successful Code Mode execution;
- keep harness changes explicit, versioned, and rollbackable;
- provide a small Vite chat UI with production bearer authentication.

It does not reproduce Prime Agent's persistent IPython heap or daemon. The
example deliberately uses serializable JSON and files as its cross-execution
memory. It also does not claim benchmark parity, automatically evaluate harness
changes, or provide production multi-tenancy, cost accounting, and retention
policy.

## Architecture

```text
Vite + React + Kumo chat
  | POST admission + GET polling (bearer-authenticated in production)
  v
RlmThinkAgent (Think)
  |-- RLM SQLite: external inputs, JSON kernel, answer candidates,
  |               operation keys, harness snapshots/mutation claims
  |-- Computer Workspace: isolated durable VFS (/workspace convention)
  |-- CodemodeRuntime facet
  |     `-- root: context/kernel/workspace/rlm/harness;
  |         child: context/kernel/workspace
  |-- runAgentTool(RlmChildAgent)       one-shot query
  `-- subAgent + submitMessages         retained child/follow-up
```

The separation is deliberate:

| Owner     | Source of truth                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------- |
| Think     | model Session and durable FIFO submissions                                                              |
| Agents    | sub-agent registry, facets, and agent-tool runs                                                         |
| Code Mode | generated-code execution, replay, calls, logs, and status                                               |
| Computer  | isolated, durable per-agent virtual filesystem; `/workspace` is the example's path convention           |
| RLM store | byte-addressable inputs, notebook values, verified answers, logical operation claims, harness revisions |
| Browser   | presentation, a per-tab token, request ID, bounded task preview, and terminal error                     |

The example does not mirror Think submissions, child heads, or Code Mode
execution summaries in parent-owned ledgers.

## Turn lifecycle

### Admission and recovery

The browser sends a caller-generated `requestId` to
`POST /sessions/:id/think`. The server derives one stable input/submission ID
and binds it to the exact chunked task material. Reusing the request ID with
changed arguments fails. `Think.submitMessages()` durably
queues a compact pointer message, and polling reads its status through
`inspectSubmission()`.

If the admission response is lost, the browser keeps the same request ID and
polls. If the input exists but the Think submission does not, the server safely
resubmits the same compact message under the same submission and idempotency
key.

### Context as a variable

`beforeTurn()` replaces assembled model messages with input metadata and a
short task preview. `context.inputs`, `context.search`, and `context.slice`
expose only the active input and earlier inputs whose turns have activated.
Later queued submissions are not visible to an earlier turn.

The JSON kernel is semantic persistence, not a literal interpreter heap. Every
Code Mode program runs in a fresh Dynamic Worker, so closures, imports, and
local variables do not survive that execution. The example has three explicit
state lifetimes:

| Lifetime                                  | Mechanism                                     | Use                                         |
| ----------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| One Dynamic Worker pass                   | ordinary JavaScript variables                 | scratch values and in-program orchestration |
| Across Worker passes, turns, and restarts | `kernel.get/set/list/delete`                  | small JSON-serializable notebook values     |
| Across Worker passes, turns, and restarts | Computer `workspace.read/ls/write/edit` files | large or reusable artifacts                 |

This covers the useful RLM memory pattern without pretending that a serialized
value is a live heap object. A true heap is needed only for non-serializable
state such as closures, class instances, module namespaces, generators, or open
resources. That would require a separate long-lived Computer session runtime;
it is not required for the filesystem-first example.

### One model-facing tool and completion

Each root turn constructs an explicit Code Mode runtime with `context`,
`kernel`, `workspace`, optional `rlm`, and `harness` connectors. Child turns
expose `context`, `kernel`, and their own `workspace`. Every turn replaces
Think's instructions and tools, forces `codemode`, and blocks every other tool
again in `beforeToolCall()`.

Every child is a separate Durable Object, so its Computer Workspace is durable
but isolated from the root and other children. Root/child sharing remains an
explicit operation through `rlm` rather than an accidental shared filesystem.

`kernel.finish({ content })` stores an unverified answer candidate with the
connector call's execution ID. Code Mode then invokes the connector's awaited,
terminal `disposeExecution` hook:

1. a completed execution verifies only its own candidate;
2. an error, rejection, or rollback discards only its own candidate; and
3. a pause keeps the candidate for the same execution's resume.

The outer tool wrapper only compacts the model-facing envelope. Think stops and
the HTTP API serves an answer only after a verified candidate exists, never
from incidental assistant prose.

A provider can occasionally finish a model step without honoring the forced
Code Mode call. If the root submission completes without a verified candidate,
the request projection admits exactly one repair submission under a stable ID.
Repeated polls inspect the same repair; a second no-finish result is a terminal
error. This recovery is a bounded Think turn, not a persistent interpreter
heap and not an extra recursive child operation.

### Recursive orchestration

`rlm.query` uses `runAgentTool()` with a stable run ID and waits for the child
answer. `rlm.spawn` addresses a retained `RlmChildAgent` with `subAgent()` and
admits a durable turn through that child's `submitMessages()`. `rlm.followup`
uses the same child, Session, input store, kernel, and FIFO queue.

Children intentionally do not receive a separate, permanently empty harness.
The root harness supplies delegation guidance; the stable admitted prompt
defines each child subtask.

The Agents registry is the authoritative child list. Parent-side status calls
ask the child to inspect its own submission; there is no duplicate parent child
table. Depth is capped at one.

Every mutating recursive call includes a short caller key. Its logical ID is
derived from the active root input, operation kind, child when relevant, and
key. A stored argument hash rejects changed replay, and each unique claim
charges the per-turn call budget once even if Code Mode retries with a new
execution ID.

### Continual harness

The harness is intentionally small: versioned `instruction`, `memory`, and
`delegate` text entries that supplement the immutable base prompt. Normal turns
can read them. Only an explicit `/refine` turn receives `harness.update` and
`harness.rollback`.

One refinement input may make one idempotent mutation. Updates and rollbacks
require the revision that was inspected and concrete evidence; an update may
change at most 12 entries. Each mutation stores a complete bounded snapshot,
and rollback creates a new monotonic revision. This is an editable continual
harness, not proof of improvement: there is no evaluator or automatic rollout
loop.

## Security boundary

Production builds authenticate every `/sessions/*` route before resolving an
agent. Session names are routing keys, not credentials. The bearer token is
entered at runtime and kept in browser session storage; it is never a `VITE_*`
value. Local Vite development bypasses bearer authentication behind the
compile-time `import.meta.env.DEV` guard.

The generic Think WebSocket route is intentionally not exposed because it
would bypass exact external-input binding, durable POST recovery, and verified
completion. Generated Workers use `globalOutbound: null` and receive no parent
bindings, credentials, MCP/browser tools, or host filesystem. Their only
durable file access is the isolated Computer Workspace explicitly exposed as a
connector. Standard Worker/Node-compatible ambient APIs may still exist, but
durable and privileged effects must cross a connector.

This is a single-operator boundary: the same token authorizes tasks and
refinement (including rollback within refinement). A production service needs
tenant authorization and distinct control-plane roles.

## Invariants

- `codemode` is the only model-visible and executable tool.
- Full external material remains connector-addressable rather than copied into
  the prompt.
- JavaScript heap state is Worker-pass-local; cross-call memory is explicit JSON
  or a durable per-agent Workspace file.
- A queued input is invisible until its own turn activates.
- Only `kernel.finish` from a matching successful Code Mode execution becomes
  a served answer.
- Stable logical operation IDs govern recursive idempotency and call budgets.
- Think/Agents/Code Mode records remain the source of truth for their own
  lifecycle state.
- Harness writes require explicit refinement, one mutation claim, and
  optimistic revision checks.
- Authentication happens before agent resolution and no secret is bundled.

## Tradeoffs and validation

Polling is recovery-friendly and honest about verified completion, but it does
not stream tokens. History reload shows bounded task previews, while the
terminal poll carries the complete current answer. Literal search is not
semantic search. Retained children and durable inputs currently have no
automatic garbage collection. Token/cost budgets and harness evaluation remain
production work. Because this example is experimental, an app-schema version
change resets only its RLM-owned tables; production deployments need explicit
data migrations instead.

Pure tests cover tuple-safe IDs, chunking, prompt capability disclosure, and
harness updates. Worker-pool tests cover request/input replay, causal
visibility, operation idempotency, execution-bound answer verification, kernel
limits, history bounds, one-mutation harness rollback, Computer connector
discovery, and generated-program file persistence across fresh Worker passes.
The example is also typechecked, built with Vite, and verified with a Wrangler
deployment dry run.

## Evaluation boundary

The example includes a small ARC-AGI-2 public-evaluation smoke comparison. The
runner downloads task files at a pinned commit, verifies their hashes, and
removes every test output before either condition receives the puzzle. Gold
grids remain in the host-side scorer. Each task and condition uses a fresh
Durable Object so history, kernel state, children, harness entries, and Computer
Workspace files cannot cross trials.

The comparison is deliberately system-level:

- the RLM gets its normal external context, Code Mode, JSON kernel, Computer
  Workspace, and depth-one delegation budget; and
- the direct Think control gets the same model and task material in its active
  prompt, with only a schema-neutral terminal-answer tool active and web/MCP
  disabled.

Exact nested-grid equality is the headline metric. A non-official cell metric
helps diagnose near misses, but gives zero credit to wrong-shaped outputs.
Because the tasks are public and the small suite is not representative, the
result is neither an official ARC-AGI-2 score nor evidence against training-data
contamination. It tests the example's end-to-end reasoning path and supplies a
repeatable baseline, not benchmark parity.
