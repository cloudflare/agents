# Preliminary ARC-AGI-2 development result

On 2026-08-07, the local example ran three pinned ARC-AGI-2 public-evaluation
tasks with `@cf/moonshotai/kimi-k2.7-code`, Workers AI `reasoning_effort=low`,
and the checked-in 180-second Think turn budget. This was a targeted development
sample, not the default suite: `1818057f` is the small stratum selected by the
fixed five-strata procedure, while `e8686506` and `28a6681f` are the second and
third smallest agent-visible public tasks.

| Condition     | Exact pairs | Tasks solved | Runtime errors | Median latency |
| ------------- | ----------- | ------------ | -------------- | -------------- |
| Code Mode RLM | 1/3         | 1/3          | 2/3            | 180.3 s        |
| Direct Think  | 0/3         | 0/3          | 3/3            | 180.0 s        |

The RLM solved `1818057f` exactly in 103.3 seconds with nine Code Mode calls,
one verified terminal execution, and no recursive child calls. Both conditions
hit the turn ceiling on `e8686506` and `28a6681f`; direct Think also hit it on
`1818057f`. The timed-out direct turns each remained in their first model step.
The two timed-out RLM turns each made one Code Mode call, then spent their
second model step reasoning without reaching `kernel.finish`.

This result demonstrates one end-to-end exact solve and a directional 1/3
versus 0/3 difference. It is not evidence of a general ARC advantage: five of
six trials were runtime errors, the tasks are public, the sample is tiny and
targeted, and the conditions are not token- or compute-matched. The most useful
finding is operational: prompt-level “reserve the final step” guidance cannot
guarantee completion when one reasoning step consumes the wall-clock budget.

Reproduce the three trials while the example is running:

```bash
pnpm run eval:arc -- --task-id 1818057f
pnpm run eval:arc -- --task-id e8686506
pnpm run eval:arc -- --task-id 28a6681f
```

Generated JSON answers and count-only trajectory diagnostics remain in the
gitignored `eval/results/` directory. Gold test grids never cross the runner's
scoring boundary.
