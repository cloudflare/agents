# Channels own both rails: durable outbound plus an ephemeral live half

Status: proposed

## Context

The interactive demo runner first rendered its terminal by calling
`engine.tail()` and `engine.ledger.openClaims()` directly from the
composition edge. It worked, but the shape was wrong: display for a surface
was implemented outside the Channel seam, using host-level access
(`Engine`, `Ledger`) that no real surface adapter would have. A Telegram or
web-socket channel wanting streamed output would have to reinvent the same
wiring, and nothing in the contract said where it belonged.

The gap is specific: a Channel's outbound half is a durable Consumer over
committed entries — correct for delivery of record, structurally unable to
carry in-flight model deltas, which are ephemeral `LiveChunk`s that never
become entries. Channels had no sanctioned access to the ephemeral rail.

## Decision

`Channel` gains an optional ephemeral half:

```ts
live?(tail: AsyncIterable<TailEvent>): void;
```

The host calls it once per wake, handing the channel a live tail (committed
entries plus in-flight chunks). The two halves have distinct, non-overlapping
jobs:

- **`outbound` is the delivery of record.** Durable consumer, cursor,
  RetryContract, dedupe keys. A channel that must guarantee the user sees the
  answer uses this half.
- **`live` is display.** Streaming deltas, progress, pass-through entries as
  they commit. Best-effort, lost on crash, never acked. Nothing observed on
  the tail may be treated as delivered.

A terminal uses `live` alone (a TTY has no message identity to reconcile,
and the human is watching). A Telegram channel uses both: `outbound` sends
the final message; `live` edits a draft message as deltas arrive. A
web-socket channel uses `outbound` cursors for reconnect replay and `live`
for the connected case.

## Consequences

- The first real implementation (the demo's terminal channel) confirmed the
  seam is sufficient: input, streamed output, approval verdicts, and pending
  effect settlements all fit through `Inbox` + `live` — the channel appends
  `tools/approval-verdict` and `tools/settlement` entries through its inbox
  like any other inbound event, and needs no host `Agent` surface at all.
  The host's `approve()`/`settleTool()` helpers become conveniences.
- For a channel to know whether an inbound message was admitted (the
  bouncer's silence, made visible), admission outcomes must be observable on
  the log. The runtime now writes the already-specified `turn/marker`
  `admitted` marker when a turn is created; previously the vocabulary named
  it but nothing wrote it.
- Realtime media remains out of scope (unchanged from the channel module
  header): `live` carries log-derived events only, not frames.
