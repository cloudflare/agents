# Submission invariants

This document defines the behavioral contract for accepting work into Channels.
It deliberately does not define the submission envelope, concrete state names,
storage schema, retry schedule, or HTTP API. Those are later roadmap items and
must preserve these invariants.

## Terms

- **Host application**: the application integrating Channels. It configures
  adapters, supplies authenticated tenant and integration context, and resolves
  agent targets.
- **Adapter**: the boundary that translates an external system's event into a
  Channels submission. It derives Channels identities from provider identity
  and authenticated host application context.
- **Submission**: the immutable inbound request durably accepted by Channels.
- **Turn**: one logical invocation of an agent. It may involve one input message,
  multiple input messages, or no input messages, and may emit zero or more
  output messages.
- **Delivery attempt**: one physical attempt to deliver that turn to the agent.
- **Acknowledgement**: the result returned by the acceptance operation. It says
  whether Channels durably accepted or recognized a submission; it does not say
  that the agent received or completed the turn.

Milestone 1 creates exactly one turn from each accepted submission. Attaching
new steering input to an active turn and creating proactive turns without a
submission are deferred; the broader definition prevents the turn model from
ruling them out.

## Identifier ownership

| Identifier      | Owner    | Rules                                                                                                            |
| --------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| Idempotency key | Adapter  | Required for acceptance, globally unique within a Channels deployment, and stable for retries of the same event. |
| Submission ID   | Channels | Allocated once when work is first accepted and never reused.                                                     |
| Turn ID         | Channels | Allocated once for the submission and stable across every delivery attempt and manual replay.                    |
| Attempt ID      | Channels | Allocated for one physical delivery attempt and never reused.                                                    |

A submission has exactly one submission ID and exactly one turn ID. A turn may
have zero or more attempt IDs. Retrying acceptance does not allocate any new
identity. Retrying delivery allocates a new attempt ID but retains the existing
submission and turn IDs.

External systems do not supply Channels idempotency keys. An adapter derives
the key from a provider message or event ID plus enough authenticated host
application context to prevent collisions between tenants, installations, and
event kinds. The resulting key is opaque to Channels. Provider identifiers do
not replace a Channels-owned submission or turn ID.

## Idempotency

The idempotency identity is the globally unique idempotency key. The first
successfully persisted request for that key wins. Acceptance must atomically
persist both the submission and the key's claim; concurrent requests cannot
each create a submission.

Channels computes a stable payload identity from all immutable,
execution-relevant input. At minimum this includes the agent target, payload,
source, and conversation hint when present. Generated identifiers, acceptance
time, tracing data, and other transport-only metadata do not affect payload
identity. The canonical representation will be defined with the submission
envelope.

A later request with the same idempotency key:

- with the same payload identity returns the existing submission ID and does
  not alter the stored submission, create another turn, or schedule delivery
  merely because it was repeated;
- with a different payload identity returns a deterministic conflict and does
  not alter the original submission;
- has the same result regardless of whether the original submission is active,
  delivered, failed, or cancelled.

Accepted input is immutable. Correcting an accepted request requires a new
idempotency key and therefore a new submission and turn.

## Acceptance boundary

A successful acknowledgement may be returned only after the canonical
submission is durably stored and its idempotency claim is committed. Once that
acknowledgement is returned, Channels owns the work independently of the
request, process, or isolate that accepted it.

A successful acknowledgement guarantees:

- the submission can be retrieved by its submission ID;
- an equivalent retry can recover the same submission ID;
- Channels will not intentionally create a second logical turn for it;
- eligible delivery work remains recoverable after restart or eviction until
  it is delivered, cancelled, or reaches a configured terminal limit.

It does not guarantee that an agent has received, started, or completed the
turn. Agent delivery and execution remain at least once.

Acceptance outcomes are:

| Outcome       | Meaning                                                                                                                     | Safe caller behavior                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Accepted      | A new submission was durably committed.                                                                                     | Store the returned submission ID or query it later.                    |
| Duplicate     | An equivalent submission was already committed.                                                                             | Treat the returned original submission ID as success.                  |
| Conflict      | The key is already bound to materially different input. Nothing changed.                                                    | Stop retrying with that key; correct the caller's identity or input.   |
| Rejected      | Validation or authorization failed before acceptance. Nothing was committed.                                                | Correct the request before trying again.                               |
| Indeterminate | The caller did not receive a definitive outcome, for example because the connection was lost. Acceptance may have occurred. | Have the adapter retry the same request with the same idempotency key. |

An internal failure may be reported as indeterminate unless Channels can prove
that no acceptance commit occurred. The contract must not tell a caller to use
a new idempotency key merely because an acknowledgement was lost.

## Lifecycle invariants

The concrete state machine is defined separately, but it must obey these rules:

1. A submission does not become accepted before its durable commit.
2. Every externally visible state transition is durably recorded before it is
   reported.
3. Delivery can begin only for an accepted, non-terminal submission.
4. At most one unexpired lease may authorize active delivery of a turn at a
   time. Lease expiry may cause another attempt, never another turn.
5. Every physical delivery is represented by a distinct attempt record,
   including attempts that time out or whose acknowledgement is lost.
6. Automatic retries retain the submission ID and turn ID, append an attempt,
   and preserve prior attempt history.
7. Delivery success is recorded only after the agent's delivery contract is
   satisfied. Starting an HTTP request is not delivery success.
8. Failure or cancellation never erases the submission, idempotency claim,
   turn identity, or attempt history.
9. Terminal states do not reopen automatically. An authorized manual replay is
   an explicit audited operation; it retains the turn ID and appends new
   attempts.
10. Stale workers and late attempt results cannot regress state, overwrite a
    newer result, or create another logical turn.

These rules constrain but do not predetermine whether the concrete model stores
submission and logical delivery state separately or exposes one as a projection
of the other.

## Duplicate and failure scenarios

| Scenario                                                                                | Required outcome                                                                                                       |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Two equivalent requests arrive concurrently with the same idempotency key.              | Exactly one submission and one turn are created. Both callers receive, or can recover, the same submission ID.         |
| Two tenants receive the same raw provider event ID.                                     | Their adapters derive different idempotency keys, so the submissions cannot collide or reveal one another.             |
| An adapter produces the same supposedly global key for independent events.              | Channels applies normal duplicate or conflict behavior; correcting the adapter requires a new key.                     |
| A retry changes execution-relevant input.                                               | Conflict; the original submission remains unchanged.                                                                   |
| Channels crashes before the acceptance commit.                                          | No successful acknowledgement was valid. Retrying may create the submission.                                           |
| Channels crashes after commit but before sending the acknowledgement.                   | The outcome is indeterminate to the caller. Retrying returns the committed submission.                                 |
| Channels crashes after acknowledgement but before dispatch.                             | Recovery eventually makes the same turn eligible for delivery.                                                         |
| Channels crashes after sending to the agent but before recording success.               | Recovery may deliver the same turn again using a new attempt ID. The turn ID remains unchanged.                        |
| An agent receives a turn but its acknowledgement is lost.                               | The attempt may time out and be retried. The agent can deduplicate using the stable turn ID.                           |
| A stale attempt reports success after a newer attempt settles delivery.                 | Its result is retained or classified for observability but cannot change the settled outcome.                          |
| The external system repeats an event after delivery, terminal failure, or cancellation. | The adapter resubmits the same key; Channels returns the original submission and does not reopen work.                 |
| An operator manually replays a terminal failure.                                        | The same submission and turn are retained, prior history remains, and each new physical request gets a new attempt ID. |

## Explicit non-guarantees

- Channels does not promise exactly-once agent execution or exactly-once agent
  side effects.
- A successful acceptance acknowledgement does not promise eventual successful
  completion; bounded retry, cancellation, or permanent rejection may end the
  submission.
- A lease prevents intentional concurrent dispatch but cannot revoke a request
  that has already escaped to an agent. Agents must treat the turn ID as their
  deduplication identity.
- No ordering guarantee between different submissions is established here.
