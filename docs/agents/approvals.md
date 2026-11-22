# Approvals

> **Experimental.** Everything exported from `agents/approvals` may change
> between releases.

`agents/approvals` adds two things to a [Lifecycle Object](./lifecycle.md):
an effect ledger, which runs a side effect once per key and records its
value, and decisions, which park work until someone approves or rejects it
and then run what comes next, across resets.

## Install

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Approvals, type Decision } from "agents/approvals";

type Refund = { orderId: string; amount: number };

export class RefundDesk extends DurableObject<Env> {
  readonly approvals: Approvals = new Approvals({
    onDecided: (decision: Decision) => this.onDecided(decision),
    onSettled: (decision: Decision) => this.approvals.acknowledge(decision.id)
  });
  readonly lifecycle = Lifecycle.install(this).use(this.approvals);

  async onDecided(decision: Decision) {
    if (!decision.verdict?.approved) {
      return { refunded: false, reason: decision.verdict?.reason };
    }
    const refund = decision.subject as Refund;
    const result = await this.approvals.once({
      key: `refund:${refund.orderId}`,
      name: "refund",
      input: refund,
      run: () => this.env.PAYMENTS.refund(refund)
    });
    return { refunded: true, result };
  }
}
```

## Run a side effect once

```ts
const outcome = await this.approvals.once({
  key: `email:${orderId}`,
  name: "sendReceipt",
  input: { orderId, to },
  run: () => sendReceipt(orderId, to)
});
```

`outcome.status` is one of:

| Status       | Meaning                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `ran`        | This call ran `run` and recorded its value.                                                             |
| `replayed`   | The value was recorded earlier. `run` did not run.                                                      |
| `in-doubt`   | An earlier attempt claimed the key and its isolate ended before it finished. `run` did not run.         |
| `reclaimed`  | As `in-doubt`, but the claim was older than `reclaimAfterMs`, so this call took it over and ran `run`.  |
| `conflict`   | The key was used before with another `name` or `input`. Nothing ran.                                    |
| `unrecorded` | `run` returned a value that is not JSON. It is returned once and not recorded; a later call runs again. |

`ran`, `replayed`, `reclaimed` and `unrecorded` carry `value`. The recorded
value is the JSON form of what `run` returned, and the first call gets that
form too.

If `run` throws, the claim is released and the error is rethrown. Two calls
for the same key in the same isolate share one run.

Pass `reclaimAfterMs` only when running the effect twice is safe, for
example when the key is also the idempotency key of the API you call.

## Park work for a decision

```ts
const decision = this.approvals.park({
  kind: "refund",
  subject: { orderId: "o_1", amount: 40 },
  descriptor: { summary: "Refund $40 on order o_1" }
});

// Later, from a dashboard, a webhook or another tab:
const result = await this.approvals.decide(decision.id, { approved: true });
```

`decide()` returns:

- `{ status: "settled", decision }` when this call decided it. `onDecided`
  ran, and `decision.outcome` is what it returned.
- `{ status: "already-decided", decision }` when someone decided it first.
  The record has their verdict and, once settled, the outcome.
- `{ status: "not-found" }`.

Reject with `{ approved: false, reason }`. Both verdicts take an optional
`data` value that reaches `onDecided` unchanged.

Other methods:

- `pending()` lists decisions nobody has made, oldest first.
- `get(id)` returns a decision whatever its status.
- `wait(id, { timeoutMs, signal })` resolves once the decision is settled.
- `unacknowledged()` lists settled decisions whose outcome was not
  acknowledged; `acknowledge(id)` marks one done.
- `sweep({ force })` deletes expired rows. It also runs on start, at most
  once an hour.

## What is durable

| Stored in SQLite                                                                  | Held in memory                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------------- |
| Effect claims and recorded values (`cf_agents_effects`)                           | The running effect that same-isolate callers share |
| Decisions with their verdict, outcome and acknowledgement (`cf_agents_decisions`) | The running continuation, `wait()` waiters         |
| One recovery job per unfinished decision                                          |                                                    |

- A verdict is taken once.
- `onDecided` runs at least once per decision. If the object resets after it
  ran and before its outcome was stored, it runs again. Put its side effects
  in `once()`, as in the example above, so the second run replays them.
- `onSettled` runs after the outcome is stored, and again after a reset
  until you call `acknowledge()`.
- If `onDecided` throws, the error reaches the caller of `decide()` and the
  recovery job retries it. After three failures the decision settles with
  `decision.error`.

## Retention

```ts
new Approvals({
  retention: () => ({
    effectSettledMs: 30 * 24 * 60 * 60 * 1000,
    effectPendingMs: 90 * 24 * 60 * 60 * 1000,
    decisionPendingMs: 30 * 24 * 60 * 60 * 1000,
    decisionSettledMs: 30 * 24 * 60 * 60 * 1000,
    maxSweepRows: 500
  })
});
```

The values shown are the defaults. Set one to `false` to keep those rows.
Deleting a recorded effect ends the run-once guarantee for its key, so keep
`effectSettledMs` longer than any retry you expect.
