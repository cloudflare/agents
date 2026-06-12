# issue-1625-live — real-deploy MCP teardown repro

Verifies the [#1625](https://github.com/cloudflare/agents/issues/1625) fix
against a **real Cloudflare deployment**. The bug only manifested in production:
the MCP Streamable-HTTP session-DELETE handler ran `agent.destroy()` on the
front Worker's `ctx.waitUntil`, and because the client has usually already
disconnected by the time a DELETE lands, the runtime gave that trailing task
little to no grace and cancelled the multi-step teardown mid-flight — leaving a
half-deleted "zombie" session DO whose tables the constructor silently recreated
on the next wake.

The local `vitest-pool-workers` runtime **does not cancel `waitUntil`**, which
is exactly why the unit tests can't reproduce the original defect. This harness
exercises the real path on deployed infra.

## How it detects a zombie

A clean teardown calls `ctx.storage.deleteAll()`, so re-addressing the session
afterwards constructs a **fresh** DO whose `state.counter` is back to
`initialState` (1). A zombie keeps whatever counter was there — the
constructor's `CREATE TABLE IF NOT EXISTS` does not overwrite a surviving
`state` row. The harness seeds a sentinel counter (default 7) before DELETE and
then polls until the session reports `counter === 1`, no condemned marker, no
alarm, and not `initialized`.

## What it does

1. `POST initialize` → obtain an `mcp-session-id`.
2. Seed `state.counter` to the sentinel via `/introspect?action=seed`.
3. Probe to confirm the sentinel stuck and the session is `initialized`.
4. `DELETE` the session. With `--abort`, the client connection is dropped right
   after the request is sent — the disconnected-client condition behind #1625.
5. Poll `/introspect?action=probe` until the session DO is fully wiped, or fail
   if it stays a zombie past `--timeout`.

## Setup

```bash
pnpm install      # from repo root (workspace)
wrangler login    # deploys to your account
```

## Run

From `wip/issue-1625-live`:

```bash
# Deploy, run the check, then tear the worker back down:
pnpm run repro -- --deploy --cleanup

# Deploy once and leave it up (re-run against it, watch logs):
pnpm run repro -- --deploy
pnpm run repro -- --url https://issue-1625-live.<you>.workers.dev --abort
pnpm run tail     # live logs: shows `[1625] DELETE …` and `[1625] alarm: … teardown`
```

Flags:

- `--deploy` — run `wrangler deploy` first and use the resulting `*.workers.dev` URL.
- `--url <url>` — run against an already-deployed worker (skip deploy).
- `--cleanup` — `wrangler delete` the worker after the run (only with `--deploy`).
- `--abort` — abort the DELETE client-side ~50ms after sending (simulates the
  disconnected client that starved the old `waitUntil(destroy())`).
- `--sentinel <n>` — seeded counter value (default 7).
- `--timeout <ms>` — how long to wait for convergence (default 30000).
- `--poll <ms>` — probe interval (default 1000).

Exit code: `0` = PASS (teardown converged), `1` = FAIL (zombie/stuck teardown),
`2` = setup error (no URL, init failed, seed didn't take).

## Interpreting a failure

- **counter still holds the sentinel** → the #1625 zombie: storage survived a
  cut-short teardown.
- **marker still present** → teardown started but the alarm is stuck; check
  `pnpm run tail` for errors thrown inside the destroy alarm.

## A/B against the unfixed package

To watch it fail on the old behavior, point this package's `agents` dependency
at a pre-fix build (e.g. a `pkg.pr.new` URL for a commit before this PR, or the
last published version), `pnpm install`, redeploy, and run with `--abort`. The
sentinel should stick (zombie). Then restore `agents: "*"` and confirm it
converges.

## Notes

- Verification harness (`wip/`), not part of CI.
- `--abort` is the most faithful reproduction of the original trigger, but even
  a plain DELETE exercises the fixed path (teardown now runs in the agent's own
  alarm with a durable marker rather than on the request's `waitUntil`).
