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
interruptions), `runaway` (never finishes), `stuck` (no progress, parks),
`hitl` (emits a CLIENT tool call `ask_user` and holds the stream open — a turn
parked on a pending human interaction).

## Assumptions under test

| ID        | Assumption                                                                                                    | Driver                                        |
| --------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **A1**    | A progressing turn **survives unbounded deploy churn** (no `max_recovery_window_exceeded`)                    | real `wrangler deploy` loop                   |
| **A2**    | A stuck turn is sealed `no_progress_timeout`                                                                  | `ctx.abort()` + small `noProgressTimeoutMs`   |
| **A4**    | A content-emitting runaway is sealed `work_budget_exceeded`                                                   | `ctx.abort()` + finite `maxRecoveryWork`      |
| **A5**    | `shouldKeepRecovering()` → false seals `recovery_aborted`                                                     | `ctx.abort()` + `abortAfterAttempt`           |
| **A6**    | A turn parked on a pending CLIENT tool call is **NOT** sealed by churn, and completes once the human replies  | `hitl` mode + `ctx.abort()` churn + WS reply  |
| **A7**    | A SERVER-tool orphan is **NOT** exempted — it recovers via transcript repair (not parked, not sealed)         | `server-orphan` mode + churn                  |
| **A8**    | A turn parked on `approval-requested` is **NOT** sealed by churn, and completes once the approval is replayed | `approval` mode + churn + WS approval         |
| **RAPID** | A sealed incident fires `onExhausted` **exactly once** and is NEVER re-emitted under a sustained deploy storm | `runaway` + `prime-seal` + real-deploy hammer |

`onExhausted` records every seal `{reason, attempt, ...}` into SQLite, exposed at
`/probe/debug` along with the live incident records, progress marker, and a
compact `transcript`.

## Deploy

```bash
cd experimental/chat-recovery-probe
npm run deploy
```

## Automated opt-in suite (`test:e2e:deployed`)

The Layer-5 live counterpart to ai-chat's `deployed-recovery.test.ts`. It deploys
the probe under a **unique throwaway name** (never clobbering a real
`chat-recovery-probe`), runs the FAST, deterministic, abort-driven scenarios
against the live edge, and ALWAYS deletes the Worker afterwards:

```bash
# from experimental/chat-recovery-probe (or `pnpm run test:recovery:live` at root)
RUN_DEPLOYED_E2E=1 pnpm run test:e2e:deployed
```

Default scenario set: `a6 a7 a8 idem` (the `ctx.abort()`-driven invariants — no
slow/racy real redeploys). Override with `SCENARIOS="a6,a7"`; add `CHURN=deploy`
for the real-eviction variant of `a6/a7/a8`. The deploy-churn scenarios
(`a1/a2/a4/a5/a9/rapid`) stay manual (see below).

It is double-gated (the dedicated script + `RUN_DEPLOYED_E2E=1`) and runs in CI
only via the opt-in `e2e-deployed-think-probe` nightly job (enabled by the
`RUN_DEPLOYED_E2E` repo variable or a manual `run_deployed` dispatch).

> **Account:** with multiple accessible accounts, wrangler can resolve the wrong
> one and fail with `Authentication error [code: 10000]`. Pin it explicitly:
> `export CLOUDFLARE_ACCOUNT_ID=<id>` (the nightly job passes this as a secret).

## Run the guard scenarios (fast, abort-driven)

```bash
export BASE=https://chat-recovery-probe.<your-subdomain>.workers.dev
node scripts/driver.mjs a4   # work_budget_exceeded
node scripts/driver.mjs a5   # recovery_aborted
node scripts/driver.mjs a2   # no_progress_timeout
node scripts/driver.mjs a6   # HITL exemption — parked client tool NOT sealed, completes on reply
node scripts/driver.mjs a7   # SERVER-tool orphan recovers via repair (NOT exempt, NOT sealed)
node scripts/driver.mjs a8   # approval-requested exemption — NOT sealed, completes on approval
node scripts/driver.mjs rapid # onExhausted fires exactly once; no duplicate seals under churn
```

Each prints `expected=… got=… => PASS|FAIL`.

`a6` is the fix for the customer's "session interrupted" reports. It acts as the
SPA: it PRIMES `ask_user` as a client tool with a quick WS chat request (the only
way `clientTools` attach), then `submitMessages` the HITL turn — because only a
submission leaves a durable `running` row that the next isolate's boot-recovery
sweep picks up. It waits for the turn to park on the pending tool call, churns
the isolate past a deliberately tight recovery budget **without replying**,
asserts **no** seal (`exhausted` stays empty; submission not `error`), then
replays the `tool-result` with `autoContinue:true` and asserts the turn
**completes**.

On the FIXED build the submission is marked `completed` at park and recovery
parks (`awaiting_client_interaction`), so eviction can't resurrect it as an
error. On the PRE-FIX build the submission is left `running` and the recovery
sweep seals it within ~1 min. Requires the `WebSocket` global (Node 22+).

Verified against the deployed runtime (both `ctx.abort()` and real
`CHURN=deploy` churn → `expected=completed got=completed => PASS`).

By default `a6` churns with `ctx.abort()` (fast). For real rolling-deploy
eviction instead, set `CHURN=deploy` (slower — each round runs `wrangler
deploy`):

```bash
CHURN=deploy node scripts/driver.mjs a6
```

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

## Run the RAPID seal-exactly-once invariant (real deploys, ~3 min)

```bash
SESSION=rapid node scripts/driver.mjs rapid
```

Driving a live turn to a _natural_ seal under churn is racy: a content-emitting
`runaway` advances the conversation leaf, so its budget seal is lost to a
`conversation_changed` skip in the continuation path; a `stuck` turn is dropped
as non-recoverable on attempt 1 so the no-progress clock never accrues. So
`rapid` **seeds** the seal deterministically instead:

1. Start a `runaway` turn (a genuinely recoverable chat fiber) with a small
   `maxRecoveryWork`.
2. One real deploy lets boot recovery open the incident with the correct id.
3. `POST /probe/prime-seal` rewrites that incident's `workBaseline` to 0 so the
   next detection sees `work = progress > maxRecoveryWork` and seals via the
   **race-free boot path** (`_handleInternalFiberRecovery` decides exhaustion
   BEFORE scheduling any continuation).
4. One deploy interrupts the still-live fiber → it seals exactly once
   (`work_budget_exceeded`) and CONSUMES the fiber.
5. Four more deploys hammer the session — with the fiber consumed there is
   nothing to re-detect, so `onExhausted` must not fire again.

PASS = exactly one `exhausted` row with reason `work_budget_exceeded` after the
whole storm.

> **Footgun this surfaced:** set `chatRecovery` as a class field/getter, NOT in
> `onStart`. Chat-fiber recovery can evaluate budgets before a subclass
> `onStart` body runs, so a config assigned there is read as the base default
> (`maxAttempts: 10`, `maxRecoveryWork: Infinity`) and a configured seal
> silently never fires. The probe binds `chatRecovery` to state-backed getters
> in its constructor (see `src/server.ts`).

## Control endpoints

`POST /probe/start?session=S` · `POST /probe/start-chat?session=S` ·
`POST /probe/config?session=S` (set mode/recovery without starting a turn) ·
`POST /probe/prime-seal?session=S` (force the open incident to seal via
`work_budget_exceeded` on the next boot detection — used by `rapid`) ·
`GET /probe/inspect?session=S&id=…` · `GET /probe/debug?session=S` ·
`POST /probe/interrupt?session=S` · `POST /probe/reset?session=S`

The HITL turn itself is started over the use-chat **WebSocket**
(`/agents/probe-agent/S`) by the driver, since only a real chat request can
register `clientTools` — see `scripts/driver.mjs` `a6`.

> Experimental test harness — not a product example.
