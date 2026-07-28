# Channels Playground

An interactive test bench for the [`@cloudflare/channels`](../../packages/channels) durable submission pipeline. It wires the real package — `createSubmissionRouter`, `SubmissionStore`, `AgentDeliveryCoordinator`, and `AgentDeliveryScheduler` — between two fake surfaces you control from the browser:

- **A fake inbound surface** that plays the role of a provider webhook. Sending derives the idempotency key from a provider event ID, so you can replay the same event (duplicate → same submission ID) or replay it with edits (conflict → rejected).
- **A fake agent** whose behavior you pick live: acknowledge, fail transiently, reject permanently, hang past the dispatch timeout, or stay flaky for the first N deliveries. Its inbox lists logical turns with physical delivery counts, so at-least-once redelivery and turn-ID deduplication are visible.
- **A live inspector** over the submission state machine (`pending → delivering → delivered`, with `retrying`, `failed`, `cancelled`): per-attempt outcomes, retry countdowns with bounded backoff, the durable alarm's next wake time, dead-lettering, cancellation, and audited manual replay.

## Run it

```bash
pnpm install
pnpm run start
```

Then open the printed URL and try:

1. **Happy path** — behavior "Acknowledge", send a webhook: accepted in milliseconds, delivered on the first attempt.
2. **Retries** — behavior "Flaky" with 2 failures: watch `retrying` with growing backoff until the third delivery acknowledges.
3. **Timeout ambiguity** — behavior "Hang": the dispatch times out, but the agent still received the turn. The retry redelivers the same turn ID and the agent deduplicates it.
4. **Dead-letter and replay** — behavior "Reject (permanent)" (or let "Fail (transient)" exhaust the 5-attempt budget): the submission fails terminally with its history preserved; switch the agent to "Acknowledge" and hit Replay.
5. **Idempotency** — "Redeliver last event" returns the original submission ID; "Redeliver with edits" returns a conflict.

## Key pattern

The gateway Durable Object owns the whole pipeline; its storage doubles as the durable alarm scheduler, so retries survive restarts with no in-memory timers:

```ts
export class ChannelGateway extends DurableObject<Env> {
  #store = new SubmissionStore(this.ctx.storage, { policy: DEMO_POLICY });
  #scheduler = new AgentDeliveryScheduler(
    this.#store,
    new AgentDeliveryCoordinator(this.#store, dispatcher, {
      dispatchTimeoutMs: 5_000
    }),
    this.ctx.storage // alarms: retries survive eviction
  );

  async accept(input: SubmissionInput) {
    const acceptance = this.#store.accept(input); // durable before ack
    this.ctx.waitUntil(this.#scheduler.deliverDue()); // deliver after ack
    return acceptance;
  }

  async alarm() {
    await this.#scheduler.deliverDue(); // recover leases, retry due work
  }
}
```

The HTTP boundary is the package's own router, mounted per host context:

```ts
app.route(
  "/api/submissions",
  createSubmissionRouter({
    acceptor: (c) => ({ accept: (input) => gateway(c.env).accept(input) }),
    reader: (c) => ({ getStatus: (id) => gateway(c.env).getStatus(id) })
  })
);
```

## Related

- [`packages/channels`](../../packages/channels) — the package, its roadmap, and the submission invariants, state machine, and agent delivery contract documents.
