# chat-recovery-probe

A headless [`@cloudflare/think`](../../packages/think) harness for validating the
durable chat-recovery assumptions in **#1672** against the real production
runtime.

## Why a synthetic model

The "model" (`src/synthetic-model.ts`) streams deterministic `tick N` content
**inside the Durable Object** — there is no external LLM. So a turn is only ever
interrupted by a real isolate reset (a `wrangler deploy`) or an explicit
`ctx.abort()`. That isolates exactly the variable #1672 is about — a turn making
forward progress that keeps getting interrupted — with no cost or nondeterminism.

Modes: `progress` (emits N ticks then finishes; resumes monotonically across
interruptions), `runaway` (never finishes), `stuck` (no progress, parks).

## Assumptions under test

| ID | Assumption | Driver |
| -- | ---------- | ------ |
| **A1** | A progressing turn **survives unbounded deploy churn** (no `max_recovery_window_exceeded`) | real `wrangler deploy` loop |
| **A2** | A stuck turn is sealed `no_progress_timeout` | `ctx.abort()` + small `noProgressTimeoutMs` |
| **A4** | A content-emitting runaway is sealed `work_budget_exceeded` | `ctx.abort()` + finite `maxRecoveryWork` |
| **A5** | `shouldKeepRecovering()` → false seals `recovery_aborted` | `ctx.abort()` + `abortAfterAttempt` |

`onExhausted` records every seal `{reason, attempt, ...}` into SQLite, exposed at
`/probe/debug` along with the live incident records and progress marker.

## Deploy

```bash
cd experimental/chat-recovery-probe
npm run deploy
```

## Run the guard scenarios (fast, abort-driven)

```bash
export BASE=https://chat-recovery-probe.<your-subdomain>.workers.dev
node scripts/driver.mjs a4   # work_budget_exceeded
node scripts/driver.mjs a5   # recovery_aborted
node scripts/driver.mjs a2   # no_progress_timeout
```

Each prints `expected=… got=… => PASS|FAIL`.

## Run the A1 invariant (real deploy churn, ~20 min)

```bash
# 1. start a ~30-min progressing turn
SESSION=a1 node scripts/driver.mjs a1-start

# 2. in another shell, drive real deploys past the old 15-min ceiling
COUNT=6 INTERVAL=210 ./scripts/churn.sh

# 3. watch until it completes (or seals — a seal is a FAIL for A1)
SESSION=a1 node scripts/driver.mjs watch
```

A1 holds if the turn **completes** despite churn crossing 15 min, with **no**
exhausted seal (and definitely no `max_recovery_window_exceeded`).

## Control endpoints

`POST /probe/start?session=S` · `GET /probe/inspect?session=S&id=…` ·
`GET /probe/debug?session=S` · `POST /probe/interrupt?session=S` ·
`POST /probe/reset?session=S`

> Experimental test harness — not a product example.
