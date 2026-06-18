# ops-approval-agent

A **non-coding discovery prototype** for Think (`qw-demo`): a refund/dispute
operations agent built on _today's_ Think APIs. It exists to surface the
ergonomic gaps that the Turns, Actions, and Channels RFCs aim to close — not to
be a polished, shipped example.

The agent processes a refund request: it looks up the order, then issues the
refund — a money-moving side effect that must be **permission-gated**,
**human-approved**, and **idempotent** (a retry or redeploy must never
double-pay). Building those three guarantees on today's primitives is where the
friction lives.

Read the findings in [`design/think-ops-demo-findings.md`](../../design/think-ops-demo-findings.md).
Every `GAP(...)` comment in `src/server.ts` maps to a finding there.

## Run it

```bash
pnpm install
cd experimental/ops-approval-agent
pnpm run dev
```

Then drive it over the HTTP control surface (headless — no UI):

```bash
# 1. Grant the scopes the tools require (today this is hand-rolled authz)
curl -X POST 'http://localhost:8787/ops/grant?session=demo' \
  -d '{"scopes":["orders:read","refunds:write"]}'

# 2. Durably accept a refund request; the agent runs a turn, looks up the
#    order, then calls issue_refund — which PARKS at approval.
curl -X POST 'http://localhost:8787/ops/request-refund?session=demo' \
  -d '{"orderId":"ord_123","amountCents":4200,"reason":"late delivery"}'

# 3. Inject out-of-band context (e.g. an upstream "dispute escalated" webhook)
#    without starting a turn — uses the new addMessages() API.
curl -X POST 'http://localhost:8787/ops/inject-context?session=demo' \
  -d '{"note":"customer opened a chargeback"}'

# 4. Inspect a submission, or dump transcript + ledger + granted scopes.
curl 'http://localhost:8787/ops/inspect?session=demo&id=SUBMISSION_ID'
curl 'http://localhost:8787/ops/debug?session=demo'
```

## What it exercises (and where it hurts)

| Production semantic               | Today's primitive used        | Gap (RFC)                                                  |
| --------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| Permission-gated side effects     | hand-rolled scope set + throw | `action({ permissions })` / `authorizeTurn` (Actions)      |
| Idempotent money movement         | hand-rolled SQLite ledger     | `cf_think_action_ledger` (Actions)                         |
| Human approval before a write     | `tool({ needsApproval })`     | no server-side resolve path (Actions)                      |
| Durable acceptance of a request   | `submitMessages()`            | one of three turn doors (Turns / `runTurn`)                |
| Proactive daily digest            | `getScheduledTasks()` prompt  | NL-string trigger, not unified (Turns)                     |
| Out-of-band context for the model | `addMessages()`               | model-only; no `deliverNotice({ informModel })` (Channels) |

## Related

- `examples/think-submissions` — durable submission pattern (full example)
- `experimental/chat-recovery-probe` — durable recovery probe (template for this)
