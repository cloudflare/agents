# Canonical submission envelope

This document defines the semantics of the smallest durable representation of
an accepted submission. The authoritative TypeScript shape is
[`SubmissionEnvelope`](./src/submissions.ts); this document records the
protocol rationale rather than duplicating that interface.

The envelope intentionally carries only enough information to identify,
deduplicate, inspect, and eventually deliver one logical turn. Channel-specific
normalization belongs in later roadmap milestones.

## Shape

The acceptance input omits `schemaVersion`, `submissionId`, and `createdAt`
from `SubmissionEnvelope`. Channels assigns those fields as part of the atomic
acceptance commit. The adapter supplies the remaining input fields.

## Fields

### `schemaVersion`

The version of the persisted envelope shape. The first version is the integer
`1`. Channels assigns it; callers do not negotiate or override it.

A version is included now so persisted submissions can later be decoded without
inferring their shape from deployment age. It does not imply that version 1
accepts arbitrary extension fields.

### `submissionId`

The Channels-owned stable identity of the accepted submission. It is allocated
once, returned by acceptance, and never reused or changed.

The identifier is opaque. Callers must compare and store it as a string rather
than parse meaning from its format.

### `idempotencyKey`

The adapter-owned identity of the source event. It must be a non-empty string,
globally unique within the Channels deployment, and stable across retries of
that event.

External systems do not need to know about this key. The adapter derives it from
a stable provider event ID plus authenticated host application context that
prevents collisions between tenants, installations, ingress integrations, and
event kinds. For example, an adapter might distinguish a message creation from
an edit even when a provider associates both with the same message ID.

The key is not the submission ID or turn ID. Channels treats it as opaque and
does not parse tenant or provider identity from it.

### `agentTarget`

An opaque stable name that the host application can resolve to the agent that
should receive the turn. Version 1 uses a string rather than embedding
Cloudflare binding, Durable Object, URL, or RPC details in the durable protocol.

Resolution may fail later during delivery, but the accepted target is immutable.
Retargeting creates a new submission rather than changing the meaning of an
accepted one.

### `payload`

The complete execution input for the selected agent, represented as a JSON
value. Version 1 does not impose a shared message format. An ingress adapter may
store a provider-shaped object here until the shared message language is
introduced.

The payload must be self-contained and durable. It cannot contain streams,
functions, symbols, `undefined`, `bigint`, non-finite numbers, cyclic objects,
class instances, or capabilities whose meaning depends on the accepting
isolate. Large binary content should be stored elsewhere and represented by a
durable JSON reference.

### `source`

Minimal provenance for the submission:

- `type` is a non-empty, adapter-defined source category such as `api`,
  `slack-webhook`, `email`, or `agent`.
- `id`, when present, is the source system's stable event or message identifier
  used for correlation. It does not replace `idempotencyKey`.

Provider payloads, signatures, headers, sender identity, and arbitrary metadata
do not belong in this minimal object. An adapter may retain required raw data in
`payload` until dedicated channel and identity representations exist.

### `createdAt`

The time at which Channels durably accepted the submission, assigned from the
Channels clock in the same atomic operation as acceptance. It is an RFC 3339 UTC
timestamp with millisecond precision, for example
`2026-06-11T12:34:56.789Z`.

It is not a provider event time or a caller-supplied timestamp. Channel event
times, when needed, remain part of the payload.

### `conversationHint`

An optional opaque string supplied by the adapter to help later conversation
resolution. It is a hint, not an authenticated conversation identity and not an
authorization input.

For example, it might carry a stable Slack thread key or email thread key.
Channels version 1 preserves it but does not interpret it. Absence means no hint
was available; an empty string is invalid.

## Payload identity

The idempotency conflict check from
[SUBMISSION-INVARIANTS.md](./SUBMISSION-INVARIANTS.md) compares this immutable
input tuple:

```text
(agentTarget, payload, source, conversationHint-or-absent)
```

`schemaVersion`, `submissionId`, `idempotencyKey`, and `createdAt` are excluded.
The key selects the idempotency record; the Channels-owned fields do not exist
in the acceptance input.

Equality uses JSON value semantics after validation:

- object property order is ignored;
- array order is significant;
- object property presence is significant, including `null` versus absence;
- strings are compared exactly, without case or Unicode normalization;
- finite numbers with the same JSON numeric value are equal, such as `1` and
  `1.0`.

An implementation may persist a deterministic fingerprint for efficient
comparison, but the semantic equality above is the contract. Hash collisions
must not cause different input to be accepted as equivalent.

## Example

```json
{
  "schemaVersion": 1,
  "submissionId": "sub_01JY0N4Q5X6Z7A8B9C0D1E2F3G",
  "idempotencyKey": "tenant-acme:slack:T123:event:Ev01ABC",
  "agentTarget": "support-agent/acme",
  "payload": {
    "type": "message",
    "text": "Where is order 1234?"
  },
  "source": {
    "type": "slack-webhook",
    "id": "Ev01ABC"
  },
  "createdAt": "2026-06-11T12:34:56.789Z",
  "conversationHint": "slack:T123:C456:thread:1712345678.000100"
}
```

The example values illustrate host application and adapter conventions, not
required identifier formats.

## Deliberately deferred

Version 1 does not yet define:

- a canonical cross-channel message or attachment representation;
- authenticated principal, tenant, or authorization claims;
- a resolved conversation identity;
- provider-specific raw metadata storage;
- delivery, retry, lease, or callback fields;
- mutable status or attempt history inside the envelope;
- tracing, routing preferences, or outbound destinations.

Those concepts are stored or introduced separately. In particular, mutable
lifecycle state must not be folded into the immutable submission envelope.
