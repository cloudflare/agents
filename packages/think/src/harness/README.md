# The harness-backed Think

Internal. `think.ts` here is Think rebuilt on `agents/harness/think`
(`ThinkHarness` for the turn loop, `ThinkChat` for the `useAgentChat`
protocol). `pnpm test:harness` runs Think's workers suite against it, with the
test agents' `../think` import pointed at `compat.ts`, and records the score in
[`../../harness-compat.md`](../../harness-compat.md). `pnpm test:harness:check`
fails when a test recorded as passing now fails.

When every test passes, this class replaces `../think.ts`.

Every method the real Think has and this class lacks throws
`Think.<name> is not supported by the harness-backed Think yet`, so a failing
test names the missing feature.

## What carries over

An agent that moves onto this class keeps its transcript: the harness reads
and writes the same Sessions tables (`cf_agents_session_*`) and the root
session is Think's default session `""`. Work in flight at the moment of the
move (a running turn, a parked approval, a queued submission, a recovery in
progress) is allowed to die. Think's own tables (`think_config`,
`cf_think_submissions`, `cf_think_scheduled_tasks`, the action ledger, agent
tool runs) are not read yet; a feature ported from Think must read the tables
Think wrote.

Scheduler jobs the previous engine queued for in-flight work
(`_chatRecoveryRetry`, `_chatRecoveryContinue`,
`_cfRetryMessengerRecoveryDelivery`) complete without doing anything.
