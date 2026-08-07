# Preliminary ARC-AGI-2 development result

On 2026-08-07, the example ran its predefined three-task `micro` suite from
the pinned ARC-AGI-2 public evaluation split. The run used
`@cf/moonshotai/kimi-k2.7-code`, Workers AI `reasoning_effort=low`, 12 model
steps, a 180-second Think turn budget, RLM depth one, and at most eight
recursive calls.

| Condition     | Exact pairs | Tasks solved | Terminal answers | Runtime errors | Median latency |
| ------------- | ----------- | ------------ | ---------------- | -------------- | -------------- |
| Code Mode RLM | 0/4         | 0/3          | 0/3              | 3/3            | 180.8 s        |
| Direct Think  | 0/4         | 0/3          | 0/3              | 3/3            | 180.0 s        |

Neither condition returned a scorable answer. This is a tied negative result,
not evidence that one condition solves ARC better than the other.

## What happened

| Task       | First condition | RLM trajectory                       | Direct Think trajectory       |
| ---------- | --------------- | ------------------------------------ | ----------------------------- |
| `20270e3b` | RLM             | 180.8 s; 3 steps; 2 Code Mode calls  | 180.0 s; 1 step; 0 tool calls |
| `e8686506` | Direct Think    | 40.5 s; 12 steps; 12 Code Mode calls | 180.0 s; 1 step; 0 tool calls |
| `28a6681f` | RLM             | 180.9 s; 3 steps; 2 Code Mode calls  | 180.0 s; 1 step; 0 tool calls |

The order alternated across the single serial run. With an odd number of
tasks, that leaves an unavoidable 2:1 split in which condition ran first.

The RLM entered Code Mode on every task. Two trials reached the wall-clock
budget without a verified `kernel.finish`; the other exhausted all 12 model
steps in 40.5 seconds without finishing. Each direct Think trial entered one
model step and produced neither a terminal tool call nor a text answer before
the wall-clock budget. These are count-only observations: the artifact does not
retain reasoning text and cannot identify what happened inside a long model
step. Recursive-call counts are unknown for failed RLM turns and are therefore
recorded as `null`, not inferred as zero.

## Reproduction identity

- Runner command:
  `pnpm run eval:arc -- --suite micro --run-id balanced-micro-2026-08-07 --timeout-ms 240000`
- Code commit: `62db23cdb6869099e348ee5deb7d18c335c54fdd`
- Worktree at run start: clean
- Dataset commit: `f3283f727488ad98fe575ea6a5ac981e4a188e49`
- Invocation nonce: `2a69375f3b1142e391e545553e10ccaf`
- Local artifact:
  `eval/results/balanced-micro-2026-08-07-2a69375f3b1142e391e545553e10ccaf.json`

The command's 240-second option is the runner's outer request timeout; the
observed Think turn timeout remained 180 seconds. The runner exits nonzero when
trials have runtime errors, so exit code 1 is expected for this result.

The exact [result artifact](./results/balanced-micro-2026-08-07-2a69375f3b1142e391e545553e10ccaf.json)
is checked in with SHA-256
`ad74d412a934206bb6672ff4e1a83bfa03e8c761469b4bc8bf878f948dd6dd2e`.
It contains empty answer fields and count-only diagnostics. Other generated
artifacts remain gitignored by default because successful runs can contain raw
model answers.

## Scope and caveats

This is a development smoke test, not an official or contamination-resistant
ARC-AGI-2 score. The three public tasks were selected mechanically as those
with the fewest agent-visible cells, making the suite deliberately small and
size-biased. They may be present in model training data and were also exercised
during development, so they are not held out. The conditions use the same model
and task material but are not token- or compute-matched, and the runner does not
capture token or cost telemetry. Four test pairs are far too few to estimate
general benchmark performance, all six trials ended in runtime errors, and the
reported median latency is failed-trial latency rather than successful-answer
latency. The artifact freezes this exact run, but hosted inference is
stochastic and no seed is available, so the command reproduces the protocol
rather than guaranteeing identical outputs.

An earlier targeted, RLM-first sanity trial on `1818057f` did produce one exact
end-to-end RLM solve in 103.3 seconds using nine Code Mode calls, one verified
terminal execution, and no recursive child calls. That single task was not part
of the predefined micro run, predates its frozen run metadata, and must not be
combined with the table above or treated as comparative evidence. It is useful
only as confirmation that the solve-and-score path can complete successfully.
