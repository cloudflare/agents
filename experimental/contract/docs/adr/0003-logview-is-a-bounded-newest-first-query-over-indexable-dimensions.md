# LogView is a bounded, newest-first query over indexable dimensions

Status: proposed

## Context

The generated `TranscriptView` exposed `head()`, `read(opts)` returning an
`AsyncIterable<Entry>`, `get(id)`, and `openClaims()`, with a `ReadOptions`
carrying `after`/`until`/`filter`/`limit`/`compacted` and an `EntryFilter` of
`kinds`/`originModule`/`run`/`correlation`. The domain-modeling pass flagged
two requirements that pull against each other:

- **Deep module, small interface** — do not bake `latest`/`after`/`until`/
  `filter` as first-class methods; make the view interpret a `Query` VALUE so
  new access patterns are new values, not new methods.
- **Cheaply "find my latest entry of kind X"** — the self-resume requirement a
  compacting assembler needs so a heavily-compacted conversation never forces
  an O(full log) read. (Removing engine compaction-awareness depends on this.)

The tension: a `Query`-value surface is only _deep_ if the store can execute
every expressible query from an index; the classic failure is a query object
that degrades to "scan everything and filter in memory."

## Decision

**`LogView` has one read primitive over a closed, indexable `Query`:**

```ts
interface LogView {
  readonly branch: BranchId;
  head(): Promise<EntryRef | null>;
  get(id: EntryId): Promise<Entry | null>;
  getBlob(ref: BlobRef): Promise<ReadableStream<Uint8Array>>;
  query(q: Query): Promise<readonly Entry[]>;
}

interface Query {
  readonly kinds?: readonly string[];
  readonly correlation?: CorrelationId;
  readonly turn?: TurnId;
  readonly after?: Seq; // seq floor, exclusive — the resume cursor
  readonly before?: Seq; // seq ceiling, exclusive
  readonly limit?: number; // count cap, newest-first
  // INVARIANT: at least one of {after, before, limit} present.
}
```

- **Closed struct of indexable dimensions, not an open predicate.** Every
  expressible query is index-served. New access patterns are new field
  combinations, not new methods — keeping LogView a deep module with a small
  interface. `originModule` is dropped (no reader needed it; re-add as a field
  if one appears — cheap, by design).

- **Newest-first, always. No direction knob.** Recency is the log's natural
  gravity (harness wants the latest marker, assembler the last N messages,
  self-resume the latest overlay). "Latest entry of kind X" collapses to
  `{ kinds:[X], limit:1 }` — the performance-critical query is the simplest
  query, with no special affordance. Chronological consumers reverse a bounded
  result in memory; the view does selection, not presentation, and never emits
  oldest-first.

- **Bounded, always — but not necessarily count-bounded.** At least one of
  `{after, before, limit}` must be present; a fully-unbounded query is rejected
  at runtime. `limit` is OPTIONAL: "everything since the last compaction
  marker" is `after`-bounded with no known count; a `before`+`after` window is
  range-bounded. The invariant is STRUCTURAL ("a bound exists"), not SEMANTIC
  ("the result is small") — `after: <recent seq>` is cheap, `after: 0` is the
  caller shooting itself. We do not type-contort to prevent that: any guardrail
  is trivially defeated by `after: 0`, so it is not worth the cost; tightness
  is the caller's responsibility.

- **Array, not AsyncIterable.** Because bounded-always, `query()` returns a
  finite array — no streaming/backpressure on the normal surface.

- **Constructor functions are the ergonomic surface.** `since(seq)`,
  `between(after, before)`, `latest(kind, n?)`, `window({...})` each produce a
  valid bounded `Query`; the raw struct stays internal. The enumerated named
  access patterns become the readable interface while `Query` stays the closed
  representation.

**`openClaims` moves to `Ledger`.** It is an anti-join (claimed entries with no
matching settle), a relationship between two entry kinds — not expressible as a
`Query` over one kind. It belongs where its claim/settle meaning lives.

**`LogExport.scan(branch, from?)` is a separate escape hatch.** Unbounded,
streamed, OLDEST-FIRST (export/migration wants chronological order), on the
Engine/substrate side, never on LogView or in `TurnDeps`. Visibly separate and
obviously expensive so the bounded newest-first `query()` stays the habitual
path.

## Considered options

- **`limit` required (count-bounded-always).** Rejected: conflates
  count-bounded with bounded. "Since the last compaction marker" has no known
  count; a `before`+`after` window is already bounded. The right invariant is
  "at least one of `{after, before, limit}`."
- **Open predicate `(entry) => boolean`.** Rejected: maximally expressive,
  un-indexable — the trap that makes a Query value shallow.
- **Caller-chosen `direction`.** Rejected: recency is the near-universal need;
  dropping the knob removes a dimension, halves the index obligation, and makes
  latest-of-kind free.
- **`openClaims` on LogView.** Rejected: it is Ledger semantics, not generic
  log reading.
- **`scan` newest-first for consistency.** Rejected: the one legitimate
  whole-log consumer (export) wants chronological order; keeping `scan`
  oldest-first lets the normal surface stay uniformly newest-first.

## Consequences

- Unblocks deleting engine compaction-awareness (`CompactionPayload`,
  `ReadOptions.compacted`): a compacting assembler finds its overlay with
  `latest("<mod>/summary-overlay", 1)` and reads the tail with `since(seq)`,
  both index-served — the engine need not know compaction exists.
- Resolves the read-slice/self-resume requirement.
- The store must maintain indexes on `kind`, `correlation`, `turn`, and `seq`
  order (all four are Query dimensions), plus the claim/settle anti-join index
  behind `Ledger.openClaims`. This is the storage contract the Query struct
  implies.
- The eventual `src/` rename folds `TranscriptView`→`LogView`, replaces
  `ReadOptions`/`EntryFilter` with `Query` + constructors, moves `openClaims`
  onto `Ledger`, and adds `LogExport`.
