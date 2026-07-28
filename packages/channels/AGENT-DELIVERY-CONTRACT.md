# Agent delivery contract

This document defines what an agent (or the receiver adapter in front of it)
must do to participate in durable submission delivery. It covers roadmap items
11–16: acknowledgement binding, timeout classification, retry classification,
and agent-side deduplication. The full acknowledgement protocol — transport,
authentication, and response encoding — is roadmap item 21; it may refine how
these obligations are proven, but not weaken them.

## What an agent receives

Every physical delivery attempt carries the same two identities:

- the **submission ID** of the accepted inbound request, and
- the **turn ID** of the one logical turn created for it.

Automatic retries, lease recovery, and authorized manual replay all reuse the
same turn ID. Only the attempt ID changes between physical requests.

## Acknowledgement

A delivery attempt succeeds only when the receiver returns an acknowledgement
that **echoes the delivered turn ID**. Returning the turn ID binds the
acknowledgement to the turn, so an unrelated success response, a load
balancer's `200`, or a buggy adapter returning someone else's acknowledgement
cannot be mistaken for delivery. A return without a matching turn ID is
recorded as `unacknowledged` and the turn is delivered again.

By acknowledging, the agent asserts that it has **durably accepted
responsibility for the turn** — not that it has finished it. Acknowledge after
the turn is persisted to survive the agent's own restart, and before doing
long-running work. Progress and completion reporting are separate lifecycles
(roadmap items 21–30).

## Delivery is at least once — deduplicate on the turn ID

Channels retries until it observes an acknowledgement. An acknowledgement can
be lost after the agent received the turn — a crash between agent receipt and
Channels recording the result, a dispatch timeout racing a slow success, or an
expired lease being recovered while the original request is still in flight.
In each of those cases **the same turn ID is delivered again**.

Agents must therefore treat the turn ID as their deduplication identity:

- if the turn ID has not been seen: durably record it, start the turn, and
  acknowledge;
- if the turn ID is already recorded: do **not** start a second execution;
  re-acknowledge the turn so Channels can stop retrying.

Re-acknowledging an already-recorded turn is required, not optional — the
retry only stops once an acknowledgement is observed. Recording the turn ID
and starting the turn should be atomic on the agent side; an agent that
records before durably committing can drop a turn, and one that executes
before recording can double-execute.

Provider or submission identifiers are not a substitute: the submission ID
maps 1:1 to the turn ID today, but steering input and agent-initiated turns
will later break that symmetry. The turn ID is the stable execution identity.

## Failure classification

How a receiver fails determines whether Channels retries:

| Receiver behavior                                                           | Recorded outcome  | Retried?                               |
| --------------------------------------------------------------------------- | ----------------- | -------------------------------------- |
| Returns an acknowledgement bound to the turn ID                             | `acknowledged`    | No — delivered.                        |
| Returns without a turn-bound acknowledgement                                | `unacknowledged`  | Yes.                                   |
| Does not settle within the dispatch timeout                                 | `timeout`         | Yes; the request may still be running. |
| Throws an error carrying `retryable: false` (e.g. `PermanentDispatchError`) | `permanent_error` | No — the submission fails terminally.  |
| Throws anything else                                                        | `retryable_error` | Yes.                                   |

Throw a permanently classified error for malformed input, authentication or
authorization failures, and explicit agent rejection — retrying those wastes
the retry budget and delays dead-lettering. Transient infrastructure errors
should be thrown as ordinary errors so the bounded backoff schedule applies.
Hosts can replace the default classification by giving the delivery
coordinator a custom `DispatchErrorClassifier`.

## Timeouts

The dispatch timeout is classified separately from rejection because it is
ambiguous: the agent may have received the turn, may still be working, or may
never have seen the request. A timed-out attempt releases its claim so the
turn can be retried — which is exactly why the deduplication rule above is a
contract, not guidance. Agents whose work regularly outlives a reasonable
dispatch timeout should acknowledge receipt quickly and report progress
through the turn event lifecycle (milestone 2) instead of holding the dispatch
open.
