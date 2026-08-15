# Research notes: Prime Agent, RLMs, Think, Code Mode, and Computer

Research started 2026-08-06; implementation notes updated 2026-08-11.

## Bottom line

Prime Agent combines four contracts:

1. Large context and useful state live outside the active model window.
2. The model's built-in interface is a programming environment.
3. Programs can make semantic model calls and admit retained child sessions.
4. A separate refinement path can revise the surrounding prompt, memory, and
   delegation harness.

Cloudflare Code Mode is a strong match for the first two contracts and supplies
a durable execution/replay spine. Cloudflare Computer supplies durable files
without making a filesystem tool model-facing. Think and the Agents SDK already
supply persistent turns, child facets, idempotent agent-tool runs, recovery, and
a durable programmatic-submission queue. Custom connectors bridge those
capabilities into one programming tool.

The result is RLM-like, but it is not a Prime clone. Fresh Dynamic Workers plus
a compact JSON kernel and durable files cannot reproduce Prime's literal
IPython heap or always-on multi-process session daemon.

## Implemented hybrid memory model

The example deliberately separates live program state from retained state:

| Layer              | Lifetime and purpose                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JavaScript heap    | Variables, imports, closures, and objects exist only for one Dynamic Worker pass. An approval resume starts a fresh pass and replays connector observations. |
| JSON kernel        | Small JSON-serializable notebook values persist across Worker passes and turns for one agent. The kernel is bounded and is not a general object heap.        |
| Computer workspace | Files under `/workspace` persist across Worker passes and turns for one agent. They are intended for larger or reusable artifacts.                           |

The model still receives only the `codemode` tool. `context`, `kernel`,
`workspace`, `rlm`, and `harness` are connector namespaces available to the
JavaScript program when that agent is allowed to use them; they are not
additional model-facing tools.

Every root or child agent owns a separate Computer workspace. A follow-up sent
to the same retained child can reuse that child's files, but the root and other
children cannot directly read them. Cross-agent transfer must use admitted
task material or an explicit child answer. The example does not claim a shared
Prime-style process filesystem.

## Original Recursive Language Models

The original RLM keeps the corpus or prompt outside the root model context as a
variable. The root receives metadata and a short preview, writes code to
inspect or transform selected regions, and can call language models on
dynamically constructed slices. Useful intermediate state remains in the REPL,
and an environment variable/protocol determines completion.

The essential invariants are:

- complete input remains symbolically addressable;
- useful program state survives root iterations;
- code chooses the content and concurrency of semantic subcalls;
- observations are bounded before returning to the root model; and
- completion is environment-backed rather than inferred from prose.

The evidence does not support “more recursion is better.” The RLM paper reports
large depth-one gains on context-heavy benchmarks but also model sensitivity,
pathological trajectories, and worse tail cost. Depth zero—external context and
a REPL without recursion—already helps several tasks. An independent
reproduction likewise finds that deeper recursion can overthink.

Design consequence: this example defaults to depth one, host-enforces a small
logical call budget, and requires `kernel.finish`.

Primary sources:

- [Recursive Language Models paper](https://arxiv.org/html/2512.24601)
- [Official RLM implementation](https://github.com/alexzhang13/rlm)
- [Minimal reference implementation](https://github.com/alexzhang13/rlm-minimal)
- [Author explanation](https://alexzhang13.github.io/blog/2025/rlm/)
- [Independent reproduction](https://arxiv.org/abs/2603.02615)

## Prime Agent's RLM-native variant

Prime gives the model a persistent IPython kernel as its built-in tool. Python
bindings bridge to tools, provider calls, conversation logs, and child-agent
admission. The TypeScript host owns credentials, sessions, process lifecycle,
and child orchestration.

Two details are easy to misread:

- `await rlm(...)` is child admission, not the eventual answer; and
- the current system still has conversation messages and an append-only log,
  so it is not a literal copy of the original paper's root loop.

This example exposes both useful shapes:

- `rlm.query` waits for an idempotent `runAgentTool` child turn. It is richer
  and heavier than a plain leaf-model call.
- `rlm.spawn` and `rlm.followup` use a named Think child and its durable FIFO
  submission queue. The child retains its Session, external inputs, Code Mode
  facet, JSON kernel, and its own Computer workspace. Root harness guidance
  shapes delegation; the child receives only the admitted subtask and its
  `context`, `kernel`, and `workspace` namespaces. Its workspace is not shared
  with the root or another child.

Prime describes its process/kernel boundary as lifecycle isolation, not a
security sandbox. Code Mode's Dynamic Worker is a stronger default for this
example: outbound network and parent bindings are disabled, and privileged or
durable effects exist only behind connector RPC. Worker/Node-compatible
ambient APIs and an ephemeral execution-local filesystem can still exist; they
do not expose the parent host filesystem or credentials. The durable Computer
filesystem is available only through the `workspace` connector.

Primary sources:

- [Prime Agent launch post](https://www.primeintellect.ai/blog/prime-agent)
- [Prime Agent repository](https://github.com/PrimeIntellect-ai/prime-agent)
- [Prime RLM documentation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md)
- [Prime runtime architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md)
- [Prime system architecture](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/architecture.md)
- [Actual RLM prompt](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/core/prompts/rlm.ts)
- [Python RLM bridge](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/prime-agent-runtime/src/rlm/__init__.py)

The launch narrative and current source have drifted in a few places (including
child idle timeout and older follow-up/skill examples). Implementation choices
here follow current source rather than launch prose.

## Continual Harness

The Continual Harness paper treats the harness as system prompt plus subagents,
skills, and memory. Its outer loop reviews recent trajectory and revises those
components. It also documents capability floors, unused memories, invalid
evolved schemas, self-reinforcing false beliefs, regressions, and long loops.

Prime's `/refine` is more guarded than unrestricted source self-modification:
base behavior remains immutable, supplemental state is versioned, and the
refiner may return no change. Recording an expected outcome does not prove that
outcome on held-out work.

This example deliberately implements a smaller version:

- explicit `/refine` turns are the only write path;
- the immutable base prompt is outside the editable state;
- entries are plain `instruction`, `memory`, or `delegate` text;
- each refinement may make one idempotent mutation;
- updates and rollbacks require evidence and an expected revision;
- full bounded snapshots support monotonic rollback; and
- no model path edits TypeScript, promotes executable code, or automatically
  retains a candidate based on unmeasured claims.

Primary sources:

- [Continual Harness paper](https://arxiv.org/html/2605.09998)
- [Continual Harness implementation](https://github.com/sethkarten/continual-harness)
- [Prime refinement implementation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/src/core/refinement/refinement.ts)
- [Prime harness state](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/prime-agent-runtime/src/rlm/harness.py)

## What the local `./agents` repository establishes

The implementation was derived from the workspace's current public APIs, not a
guessed older surface. Relevant sources include:

- `packages/think/src/think.ts`: turn assembly, `beforeTurn`, tool filtering,
  recovery, and durable submissions;
- `packages/think/src/tools/execute.ts`: explicit connector-only Code Mode
  construction;
- `packages/agents/src/index.ts`: `subAgent`, `listSubAgents`,
  `runAgentTool`, inspection, and recovery;
- `packages/codemode/src/runtime-handle.ts` and `runtime.ts`: durable execution,
  replay, and connector call logs; and
- `packages/codemode/src/executor.ts`: fresh Dynamic Workers and
  `globalOutbound: null`.

Findings that shaped the simplified design:

- Think assembles several capability classes before `beforeTurn`; there is no
  single “server-only Code Mode” policy. The example therefore replaces the
  instructions/tools, sets `activeTools`, forces Code Mode, and blocks other
  server tools again in `beforeToolCall`.
- The convenience `createExecuteRuntime(this)` can derive workspace/browser
  capabilities. The explicit `{ ctx, loader, connectors, globalOutbound: null }`
  form keeps the root boundary to at most five RLM namespaces; children receive
  only `context`, `kernel`, and their own `workspace`.
- Each Dynamic Worker pass gets a fresh JavaScript heap. Compact JSON belongs in
  `kernel`; larger or reusable artifacts belong in the per-agent Computer
  `/workspace`. Neither mechanism makes live JavaScript objects persistent.
- Computer workspaces are backed by each agent's Durable Object storage. No
  shell backend or additional production binding is required for the exposed
  `read`, `ls`, `write`, and `edit` operations.
- `runAgentTool` is idempotent by `runId` and fits one terminal child turn.
  Reusing a terminal ID returns that run; it is not a follow-up mechanism.
- A named `subAgent` plus the child's `submitMessages` and
  `inspectSubmission` fits a retained child with later FIFO follow-ups.
- The Agents registry is already the child source of truth. Parent projection,
  child-head CAS tables, and completion mirrors are unnecessary.
- Code Mode already owns execution audit and invokes
  `CodemodeConnector.disposeExecution` on terminal outcomes. The RLM store
  needs only a candidate answer bound to the execution ID; that lifecycle hook
  verifies completion or discards terminal failure while preserving pauses.
  The outer wrapper only compacts the model-facing result.
- A fresh Code Mode call gets a fresh execution ID. Recursive idempotency must
  instead derive from stable root input, operation kind, child, and caller key.
- A caller request ID can be both stable input identity and Think
  submission/idempotency identity. Comparing it with the exact stored chunks
  on replay removes the need for a second root-request ledger or a second
  20-million-character hash buffer.
- Think Session messages can replace a duplicate bounded transcript, but not
  the byte-addressable 20-million-character input store or causal visibility.
- Inputs become connector-visible only when their queued turn starts; an
  activation sequence prevents earlier turns from seeing later admissions.
- Think owns the Durable Object alarm for submissions, schedules, fibers, and
  agent-tool recovery. Application code must not replace it with a custom alarm.
- Root, child, and `CodemodeRuntime` classes must be exported for facet
  resolution; only the root class needs a top-level DO binding/migration.
- Dynamic Workers require a Worker Loader binding and may require a paid plan.
- Authentication belongs at the Worker boundary before agent resolution; the
  token is never passed to generated-code Workers.

Further framework opportunities are listed in
[`SUGGESTED_SDK_CHANGES.md`](./SUGGESTED_SDK_CHANGES.md).

Official documentation:

- [Think package guide](https://github.com/cloudflare/agents/blob/main/packages/think/README.md)
- [Agents as tools](https://github.com/cloudflare/agents/blob/main/packages/agents/docs/agent-tools.md)
- [Think programmatic submissions](https://github.com/cloudflare/agents/blob/main/packages/think/docs/programmatic-submissions.md)
- [Code Mode overview](https://developers.cloudflare.com/agents/tools/codemode/)
- [Code Mode API reference](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)
- [Durable runtime](https://developers.cloudflare.com/agents/tools/codemode/durable-runtime/)

## Mapping the systems

| Prime/original concept  | Think + Agents + Code Mode + Computer construction                          |
| ----------------------- | --------------------------------------------------------------------------- |
| Context variable        | Chunked `context.inputs/search/slice` over active and prior inputs          |
| Live REPL values        | Execution-local JavaScript heap; deliberately not retained                  |
| Compact retained state  | Per-agent durable JSON through `kernel.get/set/list/delete`                 |
| Retained file artifacts | Per-agent durable Computer files through `workspace.read/ls/write/edit`     |
| Answer variable         | `kernel.finish` + terminal connector lifecycle verification                 |
| Recursive model call    | Stable, awaited `runAgentTool` child through `rlm.query`                    |
| Retained child          | `subAgent` + child `submitMessages`, with its own kernel and workspace      |
| Follow-up               | Another durable submission in the same child Session, kernel, and workspace |
| Execution trajectory    | Code Mode's own durable runtime facet                                       |
| Harness refinement      | One claimed mutation, optimistic revision, snapshots, rollback              |

## Important limitations

Neither durable JSON nor durable files preserve a live JavaScript heap:
closures, imports, class instances, generators, open resources, and arbitrary
object graphs disappear after each Dynamic Worker pass. Exact Prime semantics
would need a long-lived language runtime with a different lifecycle and
security design. Prime uses IPython; a JavaScript variant could use an optional
computerd session whose heap survives reconnects only for the lifetime of that
process.

Computer workspaces are isolated per agent, not shared across the root and its
children. The exposed Computer tools provide file operations but no shell. A
parent cannot directly browse a child's workspace, and the example has no
automatic promotion of child artifacts into the root workspace.

Agents/Think persistence is not Prime's continuously running multi-process
manager or live bidirectional mailbox. A retained child does not automatically
wake its parent on completion; the generated program or a later turn polls it.

Harness updates commit when `harness.update` runs, before the enclosing program
later calls `kernel.finish`. A failed refinement can therefore leave a versioned
revision applied. There is no separate evaluator, staged rollout, or automatic
cadence. Candidates should be compared against an unchanged harness on held-out
work before anyone calls them improvements.

Input search is literal rather than semantic. The example has no automatic
garbage collection for its inputs, kernel values, workspace files, answers,
children, or Think submissions. Code Mode bounds terminal execution history by
default, although running/paused execution expiry still needs an application
policy. The Worker parses the complete JSON request before field limits, and
the example has no aggregate token or monetary budget. Those are production
requirements, not hidden properties of the frameworks.

## Recommended evaluation before production

Compare the same tasks/model across ordinary prompting, depth-zero external
context, depth-one synchronous query, and depth-one retained-child variants.
Measure task/evidence accuracy, root and child tokens, latency/cost tails,
recursive/code/finish failures, recovery under forced termination, and harness
candidate performance on recurring plus held-out tasks. Do not automatically
retain refinement until candidates beat the control within explicit cost and
latency budgets.
