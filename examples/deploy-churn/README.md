# Deploy churn — durable chat recovery under real deploys

A reliability harness that drives a long durable chat turn against a **deployed**
Worker, then fires **repeated real `wrangler deploy`s mid-turn** to see how chat
recovery behaves when a Durable Object is reset by a live code update.

## Why this exists

The kill/restart e2e tests (`packages/ai-chat/src/e2e-tests/chat-recovery.test.ts`)
`SIGKILL` `wrangler dev` and restart it against the same persisted state. That
covers one class of eviction — same code, fresh isolate — but a **real deploy is
different**:

- `wrangler deploy` ships a **new script version**.
- A Durable Object still running the **old** version is reset with
  `Durable Object reset because its code was updated`.
- Storage calls on that stale isolate keep throwing for the rest of the
  invocation; **fresh code only loads on the next execution** (a new `requestId`).

A customer report described the resulting failure: a mid-turn redeploy poisons
one recovery alarm's isolate, the in-process retry budget is burned against that
single stale isolate in ~7s, recovery is marked terminally exhausted, and the
turn is never retried again — even though the **DO itself re-instantiates fine on
the new code** and serves later requests normally. The orphaned turn only revives
when the user sends a new message.

This harness reproduces that environment empirically against the real platform
and records what actually happens.

## What's in here

- `src/server.ts` — `DeployChurnAgent` (`@cloudflare/think`, matching the
  runtime the report describes). LLM-free and deterministic: `getModel()`
  returns a mock model that streams one chunk per second for a configurable
  duration, so a deploy reliably lands mid-turn. `chatRecovery` is enabled, so an
  interrupted turn is wrapped in a durable fiber and continued via the
  alarm-scheduled `_chatRecoveryContinue`. It captures **both** error hooks —
  `onChatError(error, ctx)` (per-turn, tagged with `stage`, including
  `stage: "recovery"` when a recovery continuation fails) and `onError(error)`
  (agent-level: scheduled callback dispatch and scheduled tasks) — logging each
  as a structured JSON line (`"kind":"deploy-churn"`) and persisting them for
  inspection over RPC. Turn outcomes are recorded from `onChatResponse`.
- `src/client.tsx` — a browsable UI: start a turn, watch turns + recovery
  incidents update live while you deploy in another terminal.
- `scripts/churn.ts` — the orchestrator. Starts a turn, fires N real deploys
  mid-turn, records a millisecond timeline, and prints a verdict.
- `scripts/tail.ts` — captures the deployed worker's server logs (incl. the
  "code was updated" exceptions) during a run.

## Prerequisites

```bash
wrangler login   # the worker deploys to <name>.<your-subdomain>.workers.dev
```

The default worker name is `agents-deploy-churn`, so with subdomain
`threepointone` it deploys to `https://agents-deploy-churn.threepointone.workers.dev`.

## Run the scripted repro

From `examples/deploy-churn`:

```bash
# 3 real deploys during a 90s turn, first deploy 8s in:
npm run churn -- --deploys 3 --duration 90 --mid-turn-delay 8

# back-to-back deploy storm:
npm run churn -- --deploys 5 --duration 120 --between 0
```

The orchestrator will:

1. Deploy once (so the worker exists and is current), then `reset` agent state.
2. Start a long streaming turn and drop the socket (the turn runs server-side).
3. Fire `--deploys` real `wrangler deploy`s while the turn is in flight,
   capturing each new **version id**.
4. Reconnect through every deploy bounce (mirrors the browser reconnect storm)
   and poll the agent's recovery state.
5. Wait `--settle` seconds for recovery, then send a **fresh** message to prove
   whether the DO itself is healthy or wedged.

Output (per run, gitignored) lands in `scripts/runs/`:

- `<ts>.jsonl` — full millisecond timeline (deploys, version ids, ws bounces,
  recovery-incident transitions).
- `<ts>.summary.json` — config + verdict + final agent status.

The printed verdict distinguishes the two failure shapes from the report:

- **SELF-RECOVERED** — a turn completed on fresh code after the churn.
- **RECOVERY EXHAUSTED** — the attempt budget was burned and the turn abandoned.
- plus **Durable Object health after churn** — a fresh message must complete,
  proving it's the _turn_ that's orphaned, not the _DO_ that's wedged.
- plus an **error breakdown** from `onChatError` grouped by `stage` (and any
  `onError` agent-level errors), so you can see the actual failure class — e.g.
  a `recovery`-stage error carrying "Durable Object reset because its code was
  updated".

### Common flags

| Flag                  | Default | Meaning                                |
| --------------------- | ------- | -------------------------------------- |
| `--deploys N`         | 3       | mid-turn deploys                       |
| `--duration S`        | 90      | turn length (seconds)                  |
| `--mid-turn-delay S`  | 8       | wait before first deploy               |
| `--between S`         | 0       | gap between deploys (0 = back-to-back) |
| `--settle S`          | 150     | recovery wait after last deploy        |
| `--base-url URL`      | derived | override the deployed origin           |
| `--no-initial-deploy` | off     | skip the pre-run deploy                |

## Watch it in a browser

```bash
npm start
```

Open the dev server, send `stream a response for 90 seconds`, then run
`npm run deploy` in another terminal. The right-hand panel shows turns, recovery
incidents (attempt N/6), and whether recovery exhausted.

## Where error logs and events come from

1. **In-agent capture (no setup).** `onChatError` / `onError` persist every
   failure to storage; the orchestrator reads them over RPC and writes them into
   the timeline and verdict. This is the primary, zero-auth way to see the actual
   error class and `stage` without depending on log-stream timing.
2. **Live tail** (`npm run tail`) — the deployed worker's raw server logs,
   including uncaught runtime exceptions.
3. **Workers Observability MCP** — the deploy-correlated view (per-event
   `requestId` + `scriptVersion` + ms timestamps), for the same reconstruction
   the report used.

### Live tail

In a second terminal during a run:

```bash
npm run tail
```

Writes structured `deploy-churn` log lines and any thrown exceptions to
`scripts/runs/tail-<ts>.jsonl`.

### Workers Observability MCP (deploy-correlated, with scriptVersion)

For the same analysis the report used — every error event with millisecond
timestamps, `requestId`, and `scriptVersion`, plus the deploy/version timeline —
point an MCP client at the
[Workers Observability MCP server](https://github.com/cloudflare/mcp-server-cloudflare/tree/main/apps/workers-observability):

```jsonc
{
  "mcpServers": {
    "cloudflare-observability": {
      "command": "npx",
      "args": ["mcp-remote", "https://observability.mcp.cloudflare.com/mcp"]
    }
  }
}
```

It uses Cloudflare OAuth (a browser window opens on first connect). Once
authenticated, query the `agents-deploy-churn` worker:

- `query_worker_observability` — list/aggregate logs and exceptions in the
  failure window (filter by `requestId` to confirm whether the "N attempts"
  shared a single alarm `requestId`, and group by `scriptVersion` to see the
  real deploy cadence).
- `observability_keys` / `observability_values` — discover fields (e.g.
  `event`, `incidentId`, `scriptVersion`) and their values to build precise
  filters.

`observability.logs` is already enabled in `wrangler.jsonc`. Events can lag a
minute or two, so run observability queries after the churn run completes.

## Related

- `packages/ai-chat/src/e2e-tests/chat-recovery.test.ts` — kill/restart recovery.
- `packages/ai-chat` — `chatRecovery`, `onChatRecovery`, the
  `_chatRecoveryContinue` alarm path, and `maxAttempts` (default 6).
- `docs/agents/durable-execution.md` — eviction causes (incl. code updates).
