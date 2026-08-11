# ARC-AGI-2 smoke comparison

This runner compares the Code Mode RLM with a basic Think control
on a small, reproducible subset of the official ARC-AGI-2 public evaluation
split.

It is a development smoke test, not an official ARC-AGI-2 score. Public tasks
may be present in model training data; contamination-resistant evaluation needs
ARC Prize's semi-private or private sets.

## Conditions

Both conditions use the configured Workers AI model and the same canonical task
instruction and redacted puzzle JSON.

The checked-in configuration sets Workers AI `reasoning_effort` to `low` for
both conditions. Trials run serially, alternating which condition goes first,
because parallel remote-model calls can create local head-of-line blocking and
make wall-time comparisons meaningless.

| Condition     | Context and capability budget                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rlm`         | Material is external context; the sole model-facing tool is Code Mode, whose programs can use a compact JSON kernel, per-agent durable files, and children. |
| `basic-think` | Material is in the active prompt; direct Think reasoning plus only a schema-neutral terminal-answer tool.                                                   |

Each Dynamic Worker pass has a fresh JavaScript heap: variables and imports do
not carry into the next pass. An approval resume replays earlier connector
observations rather than restoring that heap. The RLM can retain small
JSON-serializable values in its bounded kernel and larger or reusable artifacts
in its durable Computer `/workspace`. Every child has its own isolated kernel
and workspace; neither is shared with the root or another child. A follow-up to
the same retained child can reuse that child's state.

The browser chat is always the RLM. `BasicThinkAgent` exists only for this
evaluator: it declares and forces `submit_answer` as its sole active tool,
disables MCP and fetched tools, and blocks any unexpected tool call. Exporting
the Code Mode runtime from the shared Worker registers the RLM runtime class; it
does not expose Code Mode to the basic control.

Every invocation generates a nonce independent of the human-readable `runId`.
The nonce is included in every Durable Object and request identity, so reusing a
`runId` still creates fresh history, kernels, workspaces, and children and
cannot overwrite an earlier result file. Every task starts with an empty
harness and receives no correctness feedback. The scorer retains
`test[].output` in the local runner and sends only training pairs plus test
inputs to either agent.

## Dataset selection

The source is
[`arcprize/ARC-AGI-2`](https://github.com/arcprize/ARC-AGI-2) at commit
`f3283f727488ad98fe575ea6a5ac981e4a188e49` (Apache-2.0). The five-task suite
was selected mechanically rather than by inspecting task semantics:

1. Count all visible cells (training inputs/outputs and test inputs).
2. Sort the 120 public evaluation tasks by visible-cell count.
3. Split them into five equal strata.
4. In each stratum, choose the lowest SHA-256 of
   `codemode-rlm-arc-agi-2-smoke-v1:<task-id>`.

The default fast suite uses the small, middle, and largest selections:
`1818057f`, `38007db0`, and `62593bfd` (three tasks, five test grids). `--suite
full` uses all five selections (five tasks, eight test grids). Downloads are
pinned and verified against SHA-256 values before a model sees any puzzle.

For a quicker correctness comparison, `--suite micro` uses the three public
evaluation tasks with the fewest visible cells: `20270e3b`, `e8686506`, and
`28a6681f` (three tasks, four test grids). This is explicitly size-biased and is
useful for development, not for estimating benchmark-wide performance.

## Run

Start the example, then run the evaluator in another terminal:

```bash
pnpm run start
pnpm run eval:arc
```

For a clean experiment that cannot recover Durable Object state or alarms from
an earlier local run, give Vite a unique persistence directory:

```bash
eval_state="$(mktemp -d /tmp/codemode-rlm-eval.XXXXXX)"
RLM_DEV_PERSIST_PATH="$eval_state" pnpm run start
```

Runtime budget overrides also belong on the Vite process, not the runner. For
example, a generous 10-minute/40-step sensitivity run uses:

```bash
eval_state="$(mktemp -d /tmp/codemode-rlm-eval.XXXXXX)"
RLM_DEV_PERSIST_PATH="$eval_state" \
  TURN_TIMEOUT_MS=600000 \
  MAX_STEPS=40 \
  pnpm run start

# In another terminal. The outer request timeout must exceed TURN_TIMEOUT_MS.
pnpm run eval:arc -- --suite micro --timeout-ms 720000
```

Changing both limits is a budget sensitivity experiment, not a timeout-only
replication of the checked-in default result.

Useful options:

```bash
pnpm run eval:arc -- --suite full
pnpm run eval:arc -- --suite micro
pnpm run eval:arc -- --task-id e8686506
pnpm run eval:arc -- --suite micro --limit 1
pnpm run eval:arc -- --base-url http://localhost:5173 --run-id experiment-2
```

`--task-id` accepts any task in the checked-in micro or five-strata manifests
and overrides the suite selection. `--limit` takes the first N tasks from the
selected suite; the two targeting options cannot be combined.

Before starting trials, the runner reads `/eval/config` and records the
effective, non-secret model, reasoning effort, step/timeout budget, depth, and
recursive-call limit. It also records the current Git commit and whether the
worktree was dirty. All `/eval/*` routes exist only in local development and
return 404 in production.

The runner prints each condition's exact score, latency, and lightweight
step/tool counts as soon as that condition finishes. A missing recursive-call
count is recorded as `null` and printed as unknown, never inferred as zero.
Only counts and tool names
are collected from the eval diagnostics endpoints; reasoning text is not copied
into the result artifact. Because `workspace` is a connector namespace inside
Code Mode rather than a model-facing tool, a diagnostic `codemode` call does
not by itself show whether that execution used the workspace. The runner then
prints an aggregate table and writes raw answers and diagnostics to the
gitignored `eval/results/` directory.

See [RESULTS.md](./RESULTS.md) for one dated, predefined micro-suite run and its
caveats. That run predates the Computer workspace integration, so it measures
the earlier external-context-plus-kernel harness rather than the current hybrid
memory condition.

## Scoring

Each test input may receive one or two candidate grids. A test pair is correct
only when at least one candidate has the exact dimensions and cell values of
the gold output. The report includes:

- exact test pairs correct;
- tasks solved completely;
- mean per-task exact score;
- wall latency and RLM recursive-call count; and
- non-official cell accuracy for diagnostics (zero on shape mismatch).

The comparison is intentionally not compute-matched: basic Think reasons over
the complete puzzle in one active prompt, while the RLM gets its
external-context, Code Mode, JSON kernel, durable per-agent workspace, and
recursion harness. These are available capabilities; the evaluator does not
claim that a particular trial used every capability. Both conditions must use
an explicit terminal-answer protocol. The comparison answers the system-level
question “does this harness help?” rather than isolating an equal-token
algorithmic effect.
