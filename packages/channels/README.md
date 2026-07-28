# @cloudflare/channels

Durable, identity-aware communication channels for Cloudflare Agents.

Agents moved to the cloud and left their users behind: the agent lives in a
Durable Object, the user lives in Slack, email, and phone calls. Channels
restores that proximity. It takes responsibility for the messy boundary
between messaging platforms — which expect acknowledgement in milliseconds —
and agents, which take minutes or hours and fail in uncommon ways.

Channels provides three things:

1. **A durable protocol for long-running agent turns** — accept fast, store
   first, deliver at-least-once with stable identities, in both directions.
2. **Identity-aware routing between agents and people** — channel-specific
   senders and threads resolve to shared principals and conversations.
3. **A shared language for messages and conversations** — rich,
   agent-oriented content that renders to the best of each channel's ability.

See [CHANNELS-ROADMAP.md](./CHANNELS-ROADMAP.md) for the full plan.

## Status: milestone 1 complete

Today the package ships the reliability core — durable acceptance plus
idempotent, at-least-once submission to an agent:

- **Atomic idempotent acceptance** (`SubmissionStore.accept`): adapters derive
  a globally unique idempotency key; duplicates return the original submission
  ID; conflicting reuse is rejected deterministically.
- **One logical turn per submission**, with a turn ID that is stable across
  every retry, crash, lease recovery, and manual replay. Physical attempts are
  recorded separately.
- **Classified delivery outcomes**: turn-bound acknowledgement, timeout,
  retryable and permanent errors, lease expiry.
- **Bounded exponential backoff with jitter**, persisted next-attempt times,
  and durable alarm-driven scheduling that survives restarts and evictions.
- **Lease-protected dispatch** so concurrent workers cannot double-claim, with
  deterministic recovery when a worker dies mid-attempt.
- **Dead-lettering, status, and audited manual replay** once attempt or age
  limits are reached.

The contracts are written down and tested: [submission
invariants](./SUBMISSION-INVARIANTS.md), the [canonical
envelope](./SUBMISSION-ENVELOPE.md), the [state
machine](./SUBMISSION-STATE-MACHINE.md), and the [agent delivery
contract](./AGENT-DELIVERY-CONTRACT.md).

## Using it today

```ts
import {
  AgentDeliveryCoordinator,
  AgentDeliveryScheduler,
  AgentDispatcher,
  SubmissionStore,
  createSubmissionRouter
} from "@cloudflare/channels";
import { DurableObject } from "cloudflare:workers";

export class ChannelGateway extends DurableObject<Env> {
  #store = new SubmissionStore(this.ctx.storage);
  #scheduler = new AgentDeliveryScheduler(
    this.#store,
    new AgentDeliveryCoordinator(
      this.#store,
      new AgentDispatcher((agentTarget) => this.resolve(agentTarget)),
      { dispatchTimeoutMs: 30_000 }
    ),
    this.ctx.storage // Durable Object alarms make the retry schedule durable
  );

  async accept(input: SubmissionInput) {
    const acceptance = this.#store.accept(input); // durable before the ack
    this.ctx.waitUntil(this.#scheduler.deliverDue()); // deliver after it
    return acceptance;
  }

  async alarm() {
    await this.#scheduler.deliverDue(); // recover leases, retry due work
  }
}
```

Agents receive turns and acknowledge them, bound to the stable turn ID:

```ts
const receiver: AgentTurnReceiver = {
  async receiveTurn({ submission, turnId }) {
    if (await this.alreadyRecorded(turnId)) {
      return { turnId }; // duplicate delivery: re-acknowledge, never re-run
    }
    await this.durablyRecordAndStart(turnId, submission);
    return { turnId };
  }
};
```

Try it interactively in
[`examples/channels-playground`](../../examples/channels-playground), which
puts a controllable fake agent and a live state-machine inspector behind a
fake webhook surface.

## Where this is going

Everything below is aspirational — APIs are illustrative sketches of what the
remaining milestones make possible on top of the reliability core that exists
today. The point is how _small_ each capability becomes once submissions,
turns, identities, and conversations are durable, first-class objects.

### A support agent that meets users everywhere (milestones 4–6)

One handler, every channel. Inbound Slack messages, emails, and SMS resolve to
the same person and the same conversation; rich responses degrade to what each
channel can render — a table becomes an image in Slack, HTML in email, a link
on SMS.

```ts
export class SupportAgent extends ChannelAgent {
  async onTurn(turn: Turn) {
    const order = await lookupOrder(turn.message.text);

    // One rich reply; every adapter renders it as well as it can.
    await turn.reply({
      parts: [
        text(`Order ${order.id} is ${order.status}.`),
        table({
          columns: ["Item", "Qty", "ETA"],
          rows: order.lines,
          fallbackText: order.summaryText // deterministic degradation
        }),
        link({ label: "Track package", url: order.trackingUrl })
      ]
    });
  }
}
```

```ts
// The same person, recognized across channels — no per-channel user tables.
const conversation = await channels.conversations.resolve(turn);
conversation.participants; // [Principal("chris"), Principal("support-agent")]
conversation.history(); // Slack thread + the email they sent last night
```

### Long-running work that outlives every request (milestone 2)

The webhook was acknowledged in milliseconds; the turn runs for an hour. The
agent reports progress through an authenticated, turn-scoped callback — and
every event is idempotent, so crashes and retries cannot corrupt the timeline.

```ts
async onTurn(turn: Turn) {
  await turn.progress("Analyzing 3 years of invoices…"); // safe to repeat

  const result = await this.longAnalysis(turn); // minutes or hours

  await turn.complete({
    parts: [text(result.summary), media(result.reportPdf)]
  }); // atomic: the turn cannot complete twice
}
```

### Approvals that are real security objects (milestone 7)

An approval is not a button in one chat app — it is a canonical action bound
to a principal, a turn, an expiry, and a single-use nonce. Slack renders it as
buttons, email as links, voice as a spoken confirmation.

```ts
const approval = await turn.requestApproval({
  action: "wire-transfer",
  summary: "Send $12,000 to Acme Corp?",
  approver: conversation.principal("cfo@example.com"),
  expiresIn: "2h"
});

if (await approval.granted()) {
  await executeTransfer(); // approval.audit has who, where, and when
}
```

### Routing that understands people (milestone 8)

Reply-to-origin by default; preferences, capability, and failover when it
matters. The agent states intent — Channels picks the destination and records
why.

```ts
await turn.reply(urgentUpdate, {
  route: {
    prefer: "most-recent", // they were just active in Slack
    require: ["actions"], // needs interactive approval buttons
    respect: user.preferences, // "never call me after 22:00"
    failover: ["slack", "email", "sms"] // voice dropped? try the next channel
  }
});
// channels.explainRouting(turn) → "slack: recent + supports actions;
//   voice rejected: quiet hours; sms rejected: no action support"
```

### Agents that start the conversation (milestone 8)

No inbound message required. Agent-initiated turns carry explicit actor,
reason, and authorization context — and delivery re-evaluates preferences at
send time, not schedule time.

```ts
await channels.initiate({
  agent: "renewal-agent",
  to: principal("chris"),
  reason: "contract-renewal-window",
  at: "2026-08-01T09:00:00Z", // local morning, per preferences
  message: {
    parts: [
      text("Your Acme contract renews in 30 days. Want me to negotiate?"),
      action({ label: "Yes, negotiate", action: "start-negotiation" })
    ]
  }
});
```

### Agent-to-agent, with authority (milestones 6–7)

Another agent is just another principal — with service identity and delegated
authority that policy hooks can reason about before your agent ever runs.

```ts
async onTurn(turn: Turn) {
  if (turn.sender.kind === "service") {
    // "procurement-agent, acting for chris@example.com, may read budgets"
    const authority = turn.sender.delegation;
    if (!authority.permits("budget:read")) {
      return turn.reply(deny("Not authorized for budget data."));
    }
  }
  // ...
}
```

Every one of these sits on the same spine built in milestone 1: accepted once,
stored first, delivered at-least-once, with identities that never change under
retry. That is what makes the rest of it safe to build.
