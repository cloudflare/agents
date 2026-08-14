# Split the Transcript into a Log plus an Engine of deep sub-modules

Status: proposed

## Context

The generated contract had one type, `Transcript`, that was simultaneously a
data record (the durable ordered log), a claim/settle ledger, a step/streaming
engine, a delivery-consumer factory, a blob store, and a reconciler registry —
an 11-method god-interface that was both a noun and a behavioral service.

## Decision

Separate the _thing_ from the _service that operates on it_, and decompose the
service into deep sub-modules related by dependency rather than one wide
interface:

- **Log** — the durable, ordered, branch-aware sequence of Entries. Data only;
  read via a **LogView** (read-only projection of one branch).
- **Engine** — the composition that owns the Log and wires the sub-modules;
  callers receive only the sub-modules they need, not the whole thing.
  - **Ledger** — `claim` / `settle` (+ `openClaims`), including reconciliation
    as its liveness half (a **Reconciler** only ever acts on open Ledger
    claims).
  - **Steps** — `beginStep` + live streaming; our commit unit.
  - **Consumers** — durable at-least-once delivery cursors (the outbox engine).
  - **Blobs** — content store the Log references by `BlobRef`.

## Considered options

- **Keep one `Transcript` interface.** Rejected: it fused a data noun with a
  behavioral service and forced every caller to learn 11 methods regardless of
  need; the read-only clients (context assemblers, reconcilers) could hold the
  full engine, which is a latent design bug.

## Consequences

- The Log/Engine split is **enforceable by type**: pure-read clients receive a
  `LogView`; only the harness/runtime receives Engine sub-modules. Holding an
  Engine where a LogView suffices becomes a compile-time-visible smell.
- Directly serves the **Harness** seam (see ADR 0002). NOTE (superseded by ADR
  0002): the seam is NOT "which sub-modules you receive" — every harness
  receives the SAME narrowed surface (`TurnDeps`), and the default-vs-foreign
  distinction is commit GRANULARITY, not structure. A foreign harness does see
  the shared `commit`/`write` primitives; it simply commits at span (not step)
  granularity. `Steps`/`StepHandle` are default-harness-internal, layered on
  top of the shared commit primitive.
- The deletion test justified each split: removing Ledger / Steps / Consumers
  makes their complexity reappear (real behavior with invariants), not vanish
  (they are not pass-throughs). Two adapters (default harness + foreign
  harness) make the Log and Steps seams real rather than hypothetical.
- Each sub-module is independently testable through its own small interface.
- The same seam logic re-partitions `AgentDefinition` into two tiers:
  **substrate** (`channels`, `tools`, `admission`, `reconcilers` — the governed
  world-boundaries and gate, true under any harness) versus **harness-internal**
  (`model`, `context`, `loop`, `policy`, `failureNotice` — how a specific
  harness thinks, moved inside the harness constructor). `channels` and `tools`
  are peers: the two governed boundaries around whatever harness thinks in the
  middle.
