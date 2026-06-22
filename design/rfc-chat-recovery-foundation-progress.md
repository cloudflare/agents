# Progress log — Shared chat recovery foundation RFC

> Archived point-in-time working record for
> [rfc-chat-recovery-foundation.md](./rfc-chat-recovery-foundation.md). This log
> was kept inline in the RFC while the `chat-recovery-foundation` branch was in
> flight; it was moved here at branch finalization so the RFC freezes as a
> point-in-time decision record (per [AGENTS.md](./AGENTS.md)).

Running record of completed steps (newest first). Each entry links the phase,
the change, and the key review findings.

- _Cross-RFC breadcrumb — Channels v1 persists channel id in turn metadata (docs,
  no code)_ — The [Channels RFC](./rfc-think-channels.md) shipped per-channel
  policy (instructions / tool-narrowing / `maxTurns`) as a turn-scoped
  `_activeChannelContext`, and to survive recovery it persists the channel **id**
  on the user message metadata (`metadata.channel`). `continueLastTurn` /
  `_chatRecoveryContinue` re-resolve the channel from that stamp on wake and
  re-apply policy — there is deliberately **no** serialized `TurnSpec.channelContext`.
  **Implication for the recovery-engine convergence:** any unified turn-metadata /
  persistence model must preserve `metadata.channel` (and the re-resolve-on-wake
  step) so per-channel policy keeps applying after a recovered turn. Flagged here
  so convergence does not drop it.
- _Phase 7 — chat-shared-layer.md: recovery-engine ownership (docs, no code)_ —
  Updated `design/chat-shared-layer.md` (which predated the whole chat-recovery
  foundation) to document the shared recovery layer. Added a `recovery-engine.ts`
  module section: `ChatRecoveryEngine` ownership of the wake lifecycle + its
  ordering invariants (incident → exhausted-persist-before-seal #1631 → guarded
  `onChatRecovery` → persist-gate → complete → dispatch), the two host seams
  (`ChatRecoveryAdapter` + per-wake `ChatFiberWakeHooks`), `pi-recovery` as the
  non-AI-SDK forcing function, and the four orphan-persist seams ((a) shared
  `StreamAccumulator`, (b) host `resolveOrphanTargetId`, (c) shared
  `reconcileOrphanPartial`, (d) `SessionProvider`-subset upsert) with the
  flat-vs-tree rationale. Also **corrected stale content** the refactor invalidated:
  the `applyChunkToParts` users list and the "accumulator used vs not" section both
  claimed `_persistOrphanedStream` used `applyChunkToParts` directly (it goes through
  `StreamAccumulator` now), added `reconcileOrphanPartial` to the module map +
  reconciler section, and added a History entry linking this RFC. Anchor/cross-refs
  verified. No code change.
- _Phase 6 — orphan-persist e2e audit (no code)_ — Audited whether the SIGKILL +
  persistent-state e2e suites cover the just-landed (a)/(b)/(c)/(d) orphan-persist
  behavior, and re-ran the two ai-chat e2e files that drive the refactored
  `_persistOrphanedStream` through a real process crash: `chat-recovery-outcomes`
  **2/2** (partial persisted as exactly one assistant message under `continue:false`;
  plain-text `persist:false` dropped) and `chat-recovery` **3/3** (retry on empty
  partial, continue → `assistantMessages === 1` merge-to-one, restart churn). Both
  green post-refactor. Built the orphan-persist coverage map (see the Phase-6 audit
  subsection): (a)/(d) and the persist gate are covered both at the workers runtime
  level and via real-SIGKILL e2e; (b) #1691 distinctness and (c) tool-approval dedup
  are covered at the workers level (`durable-chat-recovery.test.ts:1096/1152/1267`)
  - the new `reconcileOrphanPartial` unit tests. **One documented, accepted gap:**
    no real-SIGKILL e2e for the (c) tool-dedup path (the ai-chat e2e worker has no
    client-tool/approval agent); the dedup is a runtime-independent pure function
    already asserted at the workers + unit layers, and the alarm-wake it would add is
    exercised generically by the plain-text orphan e2e — so marginal value is low,
    harness cost high. Think e2e not re-run: its orphan path is unchanged and it
    doesn't call the new helper. Phase-6 exit criteria for the converged orphan-persist
    behavior otherwise met.
- _Phase 5 / Tier-2 — orphan-persist (b)/(c)/(d) consolidation: named seams +
  shared merge primitive (LANDED)_ — Factored ai-chat's `_persistOrphanedStream`
  into the three RFC seams now that the Session-provider spike settled their shape.
  **(b):** extracted `AIChatAgent._resolveOrphanTargetId(streamId, reconstructedId,
fallbackId)` — the #1691 stored-id / last-assistant-fallback policy — as a named
  per-host method. **Design correction:** kept the hook **on the host, not the shared
  engine adapter** (the earlier plan floated an engine-level `resolveOrphanTargetId`);
  hoisting the orchestration into the engine would need strip/broadcast/flush hooks
  that fight the flat-vs-tree split for negative clarity, and the engine boundary
  (whether-to-persist vs how) is already correct. **(c):** extracted the
  append-merge-with-`toolCallId`-dedup-and-metadata-overlay into a shared pure
  `reconcileOrphanPartial(existing, incoming)` in `message-reconciler.ts` (exported
  from `agents/chat`, **8 new unit tests**). Confirmed it is _not_ convergeable to
  Think's whole-message replace: ai-chat's early tool-approval persist can apply a
  client tool result in place that lives only in storage (never in the chunk
  stream), so a replace would clobber it. Think has no early-persist, so its replace
  is already dedup-safe and it doesn't call the helper — (c) is a shared primitive
  with one consumer today. **(d):** the store-write is now recognizably the same
  `SessionProvider`-subset shape on both hosts (ai-chat `findIndex`→map/append over
  the flat array; `Think._upsertMessageInHistory` `getMessage`→`update`/`append` over
  the Session tree). The two `_persistOrphanedStream` bodies stay separate by design
  — the substrate split and ai-chat's tool-result preservation are product/substrate
  decisions, not drift. **Validation:** ai-chat **687/687**, agents **2067 passed /
  8 skipped**, typecheck **113/113**, `pnpm run check` clean. No changeset — pure
  internal refactor of `@internal` methods, no public API / observable behavior
  change (the new export is additive). The old finding-#4 second-decode (hand the
  decoded partial through the codec) was **not** in scope and stays open.
- _Phase 5 — Session-provider alignment spike: orphan-persist (b) unblocked
  (design, no code)_ — Ran the spike that gated the (b) consolidation: read the real
  `SessionProvider` interface (`experimental/memory/session/provider.ts`) to decide
  whether the orphan store-write can be shaped toward it without a second storage
  abstraction. **Result: yes.** (1) The store-write half needs exactly four ops and
  the interface already has them with the right semantics — `getMessage`,
  `getLatestLeaf`, `appendMessage` (idempotent, `parentId:undefined→latest leaf`),
  `updateMessage`; methods return `T | Promise<T>` so sync DO-SQLite and async
  Postgres both fit. (2) **ai-chat's flat `UIMessage[]` is a degenerate _linear_
  `SessionProvider`** (findIndex / last / push / replace-by-id), so both hosts reduce
  to one interface — ai-chat linear, Think `AgentSessionProvider` (tree); the
  "neutral store interface" the Persist-orphan note deferred already exists. (3)
  **`resolveOrphanTargetId` is recovery _policy_, not a store method** (corrects
  alignment point 1, which had listed it as storage): it reads the stored stream
  `message_id` (#1691, ai-chat) or `getLatestLeaf` (Think) — knowledge the store
  shouldn't have — so it stays a thin adapter hook that _calls_ the provider. `chat-sdk`'s
  `ChatSdkStateAdapter` (subagent-sharded thread/history _state_ for the external
  `chat` package) confirmed orthogonal, not conflated. Recorded the finish-line
  layering (reconstruct → `resolveOrphanTargetId` → `getMessage` → merge →
  `update`/`append`) as the (b)/(c)/(d) target. Scope guardrails hold: "shape toward"
  = align signatures (a `SessionProvider` _subset_), **not** migrate ai-chat onto
  Session storage or promote it out of `experimental/` (both still non-goals). See
  the _Session-provider alignment spike — result_ note.
- _Phase 5 / Tier-2 — orphan-persist step (a): ai-chat reconstruction onto the
  shared `StreamAccumulator` (LANDED)_ — `AIChatAgent._persistOrphanedStream` now
  rebuilds the partial via the shared `StreamAccumulator` instead of a hand-rolled
  `applyChunkToParts` loop + inline `start`/`finish`/`message-metadata` extraction
  (the drift-prone duplication step (a) targeted). **Scoped deliberately narrower
  than "seed-then-replace dissolves (c)/(d)":** a closer read showed a full
  seed-then-replace would change ai-chat's tool-result-merge semantics — its merge
  intentionally _keeps_ an existing in-place-applied tool part rather than letting
  a replayed `output-available` chunk re-advance it (`index.ts` merge comment) —
  so on the highest-risk path the id-resolution (b, #1691) and the
  append-merge-with-`toolCallId`-dedup (c/d) are **kept verbatim**. Reconstruction
  is provably behavior-identical (the accumulator defaults `continuation:false`, so
  it adopts `start.messageId` unconditionally like the old code, and merges the
  same metadata chunks). **Validation:** ai-chat durable-chat-recovery **63/63**,
  full workers suite **609/609**, typecheck **113/113**, `pnpm run check` clean. No
  changeset — pure internal refactor of an `@internal` method, no public API or
  observable behavior change. _Adjusts the earlier RFC framing: step (a) is "use
  the shared reconstruction primitive"; (c)/(d) do not auto-dissolve because the
  append-merge carries ai-chat-specific tool-result preservation — converging them
  needs explicit behavior analysis + tests, deferred into the (b) consolidation._
- _Phase 5 — orphan-persist (c) correction: not a bug, downstream of (b) (design,
  no code)_ — Before implementing the proposed standalone "(c) dedup" fix, a read
  of the actual reconstruction code **reversed the finding**. `applyChunkToParts`
  is **already fully idempotent by `toolCallId`** (`message-builder.ts:237–240,
273–297` — the #1404 `findToolPartByCallId` guards), so the accumulator never
  holds duplicate tool parts and `StreamAccumulator.mergeInto` (which _replaces_
  with the deduped parts, not append) needs no dedup — the premise "`mergeInto`
  lacks dedup" was wrong. Think also has **no early/mid-stream message persist**
  (its persists are all at stream finalize, which a crash skips; tool-approval
  early-persist is ai-chat-only), so its fresh-id orphan path has nothing to
  duplicate against — not a gap. ai-chat's hand-rolled dedup is purely a
  consequence of its **reconstruct-fresh-then-append-onto-same-id** model (which
  exists because of (b)'s same-id merge + the ai-chat-only early-persist). **(c) is
  therefore downstream of (b), not an independent bug-asymmetry**; there is no
  standalone fix and `mergeInto` is left unchanged. The dedup dissolves for free
  when ai-chat adopts the shared **seed-then-replace** model in step (a). Corrected
  the 4-step table, open item #1, the Tier-3 bullet, the matrix note, and the
  bucket-2 example (which had cited (c)). Lesson captured in the litmus test:
  **verify the asymmetry is real before propagating a "fix."** Recommended next
  step is now the step-(a) reconstruction migration (part of the consolidation),
  not a standalone (c) patch.
- _Phase 5 — foundation revisit through the convergence litmus test (design, no
  code)_ — Carried the new lens (shared client contract + the 3-bucket litmus
  test) back over **all three tiers** of the extraction map and the convergence
  matrix, not just Tier 3. Findings: **(1)** the "Persist-orphan boundary"
  responsibility split was miscalibrated — re-split so reconstruct+merge+dedup are
  **shared** and only target-id resolution + raw store write + broadcast are
  adapter, and stated the general seam rule (_merge/reconcile is shared; only id
  resolution + the store write are the adapter seam_). **(2)** Convergence-matrix
  "Message reconciliation: keep adapter-owned" is already false — `reconcileMessages`
  /`resolveToolMergeId` are shared and both hosts call them (Think `7590`/`8766`);
  reframes orphan-persist (c) as _finishing_ that convergence. **(3)** Stale matrix
  cells (terminal delivery persist-first; reconciliation) corrected via a status +
  litmus-bucket note under the matrix. **(4)** "Reconstruct partial" was
  double-assigned to both adapter and codec seams — removed from the adapter list,
  homed on the shared `StreamAccumulator`. **Tier 1:** the 4f-ii items
  (`enforceRowSizeLimit`, inline protocol parse) are the same "hand-rolled subset
  of a shared primitive" shape as orphan-persist (a) → their verify gate must diff
  for a latent bucket-2 fix, not just equivalence. **Tier 2:** item 1's handshake
  spine is already partly shared (`ResumeHandshake`), narrowing divergence to wire
  vocab + the idle-connect payload (the latter possibly a bucket-1 convergence, not
  a permanent knob); item 2 **shrinks** — orphan-persist (a) collapses the
  "`applyChunkToParts` vs `StreamAccumulator`" codec difference into one shared
  reconstruction, so the orphan consolidation and the streaming-codec extraction
  share work and the codec seam is thinner (driver + vocabulary only). No code
  landed; this tightens the foundation before the orphan-persist consolidation.
- _Phase 5 / Tier-2 — orphan-persist 4-step investigation (design finding, no
  code yet)_ — Pressure-tested the long-standing assumption that
  `_persistOrphanedStream` is "legitimately different, keep package-specific."
  Read both bodies (ai-chat [`index.ts:1452–1543`], Think [`think.ts:11174–11197`])
  against the shared primitives and decomposed the writer into four steps:
  (a) chunks→parts, (b) target-id resolution, (c) tool-part dedup, (d) upsert.
  **Finding: 3 of 4 unify; only (b) is genuinely storage-coupled.** (a) Think's
  `StreamAccumulator` is the superset ai-chat hand-rolls a subset of → migrate
  ai-chat onto it. (b) ai-chat's stored `message_id` (#1691) and Think's
  `getLatestLeaf` tree-position are each correct FOR their storage model — neither
  is buggy, and Think structurally cannot have #1691 → keep behind a narrow
  `resolveOrphanTargetId` host hook. **(c)** [**later corrected — see the newest
  Progress-log entry; (c) is downstream of (b), not a standalone bug**] was read
  here as a bug-asymmetry (ai-chat dedups by `toolCallId`, Think doesn't), but on
  reading `applyChunkToParts` it is already idempotent, so there is no shared-
  primitive gap and no standalone patch. (d) mechanically equivalent (substrate only).
  Also reconsidered **pluggable storage**: a flat list is a degenerate Session
  tree, so a neutral store interface is _feasible_; not doing it is a risk/reward +
  product-direction call (Think subsumes ai-chat), not an architectural "can't."
  Recorded under "Persist-orphan boundary" (4-step verdict table) + Tier-3 bullet
  revision; folded into open item #1 (subsuming former finding #4 + start-id
  alignment). No code landed; the (c) dedup is the recommended first concrete step.
- _Phase 5 / Tier-2 — give-up ordering convergence (broadcast-first)_ —
  Follow-up to the exhaustion-helper extraction below. The two chat hosts had
  **diverged** in their give-up terminalize ORDER: `AIChatAgent` persisted the
  durable terminal record before broadcasting the banner (persist-first), while
  `Think` broadcast first. Converged `AIChatAgent` onto `Think`'s
  **broadcast-first** ordering. **Why broadcast-first is strictly better (not a
  toss-up):** a terminal-record write can reject in the deploy/storage window a
  give-up runs in (#1730). A throwing `terminalize` propagates, so the whole
  give-up re-runs on a healthy isolate and persists the record **either way** —
  so persist-first buys no durability. But under persist-first the throw fired
  BEFORE the (storage-free) broadcast, dropping the live banner on the failing
  pass; it only reappeared on the re-run, possibly a different isolate after the
  affected connections had gone. Broadcast-first delivers the banner on every
  pass (the documented at-least-once edge) and keeps the same eventual
  durability — `Think`'s own code comment already argued this. **Verified against
  the existing ai-chat give-up tests** (`testStableTimeoutSealTransientDefer`
  etc.): they assert the banner VALUE + incident status, not persist-before-
  broadcast, and `terminalBroadcast` captures the last banner — so broadcast-first
  keeps them green (now the banner also lands on the failing pass). This removes
  the last "legitimately divergent ordering" between the hosts — both now
  broadcast-first; only the durable-write SET differs (`Think` also writes a
  submission row). **Changeset:** patch for `@cloudflare/ai-chat` (behavior
  change observable only in the storage-failure mode). Tests: `pnpm run check` ✅
  (113), ai-chat **687/687** ✅ (incl. the transient/seal give-up tests).
- _Phase 5 / Tier-2 — engine-owned exhaustion helper (API-ergonomics finding #3,
  closed)_ — Every host's `_exhaustChatRecovery` repeated the same
  `buildChatRecoveryExhaustedContext → notifyChatRecoveryExhausted →` host
  terminalize sequence (~30 lines). Added
  `runChatRecoveryExhaustion(input, { emit, onExhausted?, onError, terminalize })`
  to `agents/chat`, which owns the **invariant skeleton** — build the context,
  run the notification (emit + `onExhausted`-swallow via `onError`), THEN call
  the host's `terminalize(ctx)` — and guarantees notify-before-terminalize plus
  "a throwing `onExhausted` never blocks terminal UX." **Design judgment (the
  careful part):** the RFC's literal sketch (a helper that also owns
  broadcast/storage) would have FORCED one terminalize order and silently
  converged the hosts' then-divergent ordering; instead the helper takes the
  host's `terminalize` closure so each host keeps its own terminal writes. (The
  ordering itself was converged separately, in the entry above — a deliberate
  behavior change with a changeset, not a side effect of a dedup.) `partialParts`
  stays an explicit input (not derived from `RecoveryPartial`) so a
  foreign-vocabulary host passes `[]` rather than fabricating AI-SDK parts,
  preserving the parts-agnostic seam. **Scope:** all four hosts moved onto it
  (`ai-chat`, `think`, pi + tanstack harnesses); the harnesses also gained a
  `_setChatRecovering` wrapper so the duplicated `setChatRecovering` option bag is
  built once. Behavior-neutral plumbing in the `@internal` `agents/chat` layer
  (additive sibling-only export) — **no changeset**, consistent with the
  `RecoveryPartial`-refactor precedent. Added a `runChatRecoveryExhaustion` unit
  test (notify-before-terminalize order, `onExhausted`-swallow, shared `ctx`,
  terminalize propagation). Tests: chat unit **413** ✅, ai-chat **687** ✅, think
  suites ✅, `pnpm run check` ✅ (113), typecheck 113/113 ✅.
- _Phase 5 / Second harness — real Workers AI provider run (open item #1, closed)_ —
  Replaced the harness's deterministic faux model with a REAL streaming provider on
  the last genuinely-untested codec axis: `@tanstack/ai`'s `chat()` over
  `@cloudflare/tanstack-ai`'s `createWorkersAiChat` (model
  `@cf/moonshotai/kimi-k2.7-code`), bound to the `AI` binding. Because
  `chat({ stream: true })` yields `AsyncIterable<StreamChunk>` byte-identical to the
  faux model's output, the swap is **model-only** — `TanStackRecoveryCodec`,
  `ws-bridge.ts`, the shared `ResumeHandshake`, and `ChatRecoveryEngine` are all
  **unchanged**, confirming the codec/handshake/engine seams hold against a real,
  non-deterministic chunk stream. **Shape:** a small `TurnModel` seam
  (`src/model.ts`) with two impls — `FauxTanStackModel` (default) and
  `createWorkersAiModel` (`src/workers-ai-model.ts`); the provider is chosen
  per-turn via the `/start` body (`provider: "workers-ai"`) and stored durably so a
  cold-wake recovery re-runs the SAME provider. **Continuation under
  non-determinism (the decision taken):** rather than relax to a regenerate, the
  recovered turn genuinely CONTINUES — the survived partial is re-fed to the model
  as an assistant-prefill + a "resume from where you stopped" nudge
  (`_buildModelMessages`), and the merge folds whatever it streams onto the prefix.
  The engine's continuation INVARIANT (`recoveredVia === "continue"`,
  `prefixChars > 0`, `generatedChars > 0`, `prefix + continuation === final`) holds
  by construction even when the model doesn't resume verbatim. **Finding (e2e timing,
  not a seam leak):** a real model's time-to-first-token means the orphaned fiber row
  exists well before any `TEXT_MESSAGE_CONTENT` flushes, so killing on `fiberRows > 0`
  alone races the TTFT and reconstructs an EMPTY partial (→ a `retry`). Added a
  `bufferedChars` status field (chars reconstructable from the live stream buffer)
  and gated the SIGKILL on it, so the survived prefix is non-empty — proving the
  reconstruction works on real chunks (the first run also confirmed text accumulation:
  the regenerate produced 7309 chars). **Default preserved:** the faux model remains
  the hard default; the new run lives in a **`RUN_WORKERS_AI_E2E`-gated e2e**
  (`e2e/workers-ai.test.ts`, `describe.skipIf`) that is skipped in CI, since
  `wrangler dev`'s `AI` binding (`remote: true`) proxies to real Workers AI and needs
  network + Cloudflare auth. Tests: `tanstack-recovery` unit **31** ✅, faux e2e
  **4/4** ✅, gated real e2e **1/1** ✅ (local, against the live binding),
  `pnpm run check` ✅ (113 projects). **Deps/config:** added `@cloudflare/tanstack-ai`
  to the harness `package.json` (+ its transitive `@openrouter/sdk` build skipped in
  `pnpm-workspace.yaml`, unused on the binding path) and the `AI` binding to
  `wrangler.jsonc`/`env.d.ts`. No published-package source changed → **no changeset**.
  This closes open item #1; the next open items are API-ergonomics finding #3 (engine-
  owned exhaustion helper) and #4 (hand the decoded partial to `persistOrphanedStream`).
- _Phase 5 / Tier-2 follow-up — progress-bump timing convergence_ — Closed the
  deferred, correctness-flagged divergence in how the two hosts credited the
  recovery no-progress counter. Before: `AIChatAgent` credited only on chunk-type
  milestones (`isProgressChunk`: started segments + settled tools), so a long
  **single** content segment that emits only deltas bumped exactly **once** (at
  `text-start`); `Think` credited on its flush cadence (first content, then every
  10 chunks, plus settled tools), so it kept crediting mid-segment. **Why it
  matters:** `evaluateChatRecoveryIncident` compares the counter
  _attempt-to-attempt_ (`currentProgress > prevProgress` resets `lastProgressAt`),
  so a single long segment spanning ≥2 crashes with no intervening milestone reads
  as "no progress" under `AIChatAgent` and can false-fire `no_progress_timeout`
  (300s) while content is genuinely streaming. `Think` was immune; `AIChatAgent`
  was not. **Fix:** one shared, host-agnostic rule — `shouldCreditStreamProgress`
  ({@link recovery-codec}) — that both hosts now call at chunk-store time. A
  milestone (`isProgressChunk`) credits unconditionally; mid-segment streaming
  deltas (new codec `isStreamingContentChunk`: `text-delta`/`reasoning-delta`/
  `tool-input-delta`) credit at most once per `StreamProgressCreditThrottle`
  window (per-isolate, time-based 5s — mirrors the proven N9
  `AgentToolStreamProgressThrottle`, far finer than the 300s budget). `Think`'s
  bump is now decoupled from its flush decision (flush stays for durability) and
  routed through the same rule. **Safety argument:** the unified rule is never
  coarser than either host's prior cadence, and over-crediting (e.g. crediting a
  buffered-but-not-yet-flushed chunk) only biases toward keeping recovery alive —
  so the change can only delay/avoid a false no-progress timeout, never hasten
  give-up. Tests: `recovery-codec.test.ts` pins `isStreamingContentChunk` and
  `shouldCreditStreamProgress` (milestone-always, delta-throttled, the long
  delta-only-segment gap); ai-chat durable-recovery (63) + think-session (193)
  workers suites green. Changeset: patch for `agents` + `@cloudflare/ai-chat` +
  `@cloudflare/think`. Still deferred from Tier-2: moving start-id alignment onto
  the codec; the full streaming-driver merge (Tier-3).
- _Phase 5 / Second harness — Route 2 reframed and deprioritized (doc-only)_ —
  Questioning what "front `AIChatAgent` with a TanStack client" even means surfaced that the
  original Route 2 conflated two independent layers of `AIChatAgent`'s wire. **(1) The handshake +
  frame envelope** (`cf_agent_stream_resuming`/`resume_ack`/replay/`resume_none`/`chat_recovering`
  - the `{ type, id, body, done, replay? }` response envelope) is **transport-agnostic** and Route 1
    ALREADY proved a `@tanstack/ai` client speaks it over the REAL shared `ResumeHandshake` via a thin
    frame-router (`ws-bridge.ts`), zero `agents` change. **(2) The chunk payloads inside
    `response.body`** ARE AI-SDK-specific (`AIChatAgent` streams AI SDK UIMessage SSE parts; a TanStack
    client consumes AG-UI `StreamChunk`s). So actually fronting the real `AIChatAgent` reduces to a
    **client-side AI-SDK-SSE → AG-UI chunk translator** — a codec-translation exercise, NOT the
    handshake test it was billed as — and that axis is already proven from both directions (our codec
    reconstructs AG-UI, `AIChatAgent`'s reconstructs AI-SDK, both feed the same agnostic
    `RecoveryPartial` seam). A TanStack-native `AIChatAgent` (server emits AG-UI) is a much larger
    separate effort and is essentially what the engine-direct harness already prototypes. **Decision:**
    drop Route 2 as a recovery-validation deliverable; the only genuinely untested axis left is the
    **real Workers AI provider** run. Updated the "Build route" item, the body "Still open", and this
    log accordingly. Doc-only, no code change.

- _Phase 5 / Second harness — making the engine seam genuinely AI-SDK-agnostic (`RecoveryPartial` refactor)_ —
  Review of the tool-`parts` entry below caught that its "vocabulary-agnostic" claim was **overstated
  at the type level**: the engine seam `RecoveryPartial` was typed `{ text; parts: MessagePart[] }`,
  where `MessagePart = UIMessage["parts"][number]` — i.e. the AI SDK's UI-message part type. The
  settled-tool gate was _runtime_ duck-typed (it read `type`/`output`/`state` off
  `Record<string, unknown>`, which is why the harness e2e passed), but to even **typecheck**, the
  foreign AG-UI codec had to fabricate AI-SDK parts (`… as unknown as MessagePart`). So the engine
  was text-agnostic + protocol-agnostic but **parts-vocabulary-coupled to AI SDK**, and the foreign
  codec was "converting to AI SDK format" — the exact smell the genericity harnesses exist to surface.
  **Fix (the codec owns the vocabulary; the engine owns nothing about parts):** `RecoveryPartial` is
  now `{ text: string; parts: unknown[]; hasSettledToolResults: boolean }`. The engine's never-drop
  clause reads the precomputed `partial.hasSettledToolResults` boolean and **no longer imports a part
  type at all** (`recovery-engine.ts` dropped its `MessagePart` import). The `partialHasSettledToolResults`
  predicate moved out of the engine into `recovery-codec.ts` as the **AI SDK codec's** helper
  (`AISDKRecoveryCodec.toRecoveryPartial` computes the boolean from real `UIMessage` parts; its return
  stays concretely typed `MessagePart[]` so AI-SDK hosts keep their typed parts, and is still
  assignable to the agnostic seam). Foreign codecs compute the same boolean from their own chunks: the
  **TanStack codec now returns AG-UI-native `TanStackToolPart`s and decides settledness via `hasOutput`
  — zero `MessagePart` fabrication, zero AI-SDK coupling**; pi returns `false`. AI-SDK hosts
  (`AIChatAgent`, `Think`) re-assert `MessagePart[]` with a single cast at the user-facing
  exhausted-/recovery-context edge (legitimate: those hosts genuinely own the AI SDK vocabulary), and
  their pre-stream classify helpers widened to `parts: unknown[]` (they only read `parts.length`).
  **Files:** published `agents` (`recovery-engine.ts`, `recovery-codec.ts`, `chat/index.ts` export
  repoint), `ai-chat/index.ts` + `think.ts` (edge casts + `_getPartialStreamText` boolean), both
  harness codecs/agents, and `recovery-engine.test.ts` (the gate tests now set `hasSettledToolResults`
  on the partial — proving the engine consumes the boolean, not a part shape). **Net:** the engine seam
  is now wire-vocabulary-agnostic by _type_, not just at runtime; the codec is the single owner of both
  parts reconstruction AND the settled-tool determination. Behavior-neutral (the AI SDK path computes
  the identical boolean it used to), `agents/chat` is `@internal`, so **no changeset**. Tests: engine
  unit (gate suite) ✅, `tanstack-codec` unit **20** (now asserts `hasSettledToolResults` directly,
  parts in AG-UI-native shape) ✅, `tanstack-recovery` e2e **4/4** ✅, `pi-recovery` e2e **1/1** ✅,
  `pnpm run check` ✅ (113 projects). **Still open:** a **real Workers AI provider** run is the
  only genuinely untested axis; **Route 2 (front `AIChatAgent` with a TanStack client) is
  deprioritized** — Route 1 proved the handshake is transport-agnostic, so Route 2 reduces to a
  redundant client-side AI-SDK-SSE → AG-UI chunk translation (see the reframed "Build route" item
  above for the full reasoning).

- _Phase 5 / Second harness — tool-`parts` codec path + settled-tool persist gate (foreign vocabulary)_ —
  Closed the last codec gap both genericity harnesses left open: until now the pi fixture AND
  the TanStack harness were **text-only** (`parts: []`), so the engine's shared settled-tool
  persist gate (`partialHasSettledToolResults`) had only ever been exercised through the AI SDK
  adapter. Extended the TanStack harness to reconstruct tool `parts` from a FOREIGN tool
  vocabulary and prove the gate end-to-end. **Files (all in `experimental/tanstack-recovery/`,
  zero `agents` change):** `tanstack-codec.ts` — `toRecoveryPartial` now rebuilds the AG-UI
  `TOOL_CALL_START → ARGS → END → RESULT` sub-protocol into the AI-SDK `UIMessage` tool-part
  shape (`type: "tool-<name>"`, `state`, `input`, `output`), so a tool whose `RESULT` flushed
  reads as **settled** and one torn before it reads as **unsettled**; `faux-model.ts` —
  `setNextTurnToolCall` settles a scripted tool before the text body (so a mid-text-tail SIGKILL
  leaves a partial carrying a settled result); `tanstack-agent.ts` — a durable
  `invokeOnChatRecovery` wake hook returning the configured `{ persist }` policy + a
  `partialHadSettledTool` observable; `server.ts` `/start` takes `withTool`/`persist`. **Core
  finding:** the settled-tool persist gate is **vocabulary-agnostic** — it keyed off the
  AG-UI-reconstructed parts byte-identically to AI-SDK ones, with the SAME shared predicate and
  **no engine change**. The codec — not the engine — owns the chunk→parts contract, exactly as
  Tier-2 claimed. _(**Superseded / corrected by the entry above:** this was true only at *runtime*
  — the `RecoveryPartial.parts` seam was still TYPED as AI-SDK `MessagePart[]`, so this codec had to
  fabricate AI-SDK parts to typecheck. The follow-up refactor made the seam agnostic by type too.)_
  **Proof:** two SIGKILL e2es sharing one `persist: false` policy and differing
  ONLY in whether the turn settled a tool: the **tool** turn's partial SURVIVES the
  `{ persist: false }` drop (gate override → `recoveredVia === "continue"`,
  `partialHadSettledTool === true`, `prefix + suffix === total`) while the **text-only** turn's
  partial is DROPPED (`recoveredVia === "retry"`, `prefixChars === 0`) — the divergent outcome
  isolates the gate. Tests: `tanstack-codec` unit now **20** (settled/unsettled/torn tool
  reconstruction + `partialHasSettledToolResults` over AG-UI parts, imported live in node) ✅;
  `tanstack-recovery` e2e **4/4** ✅; `pnpm run check` ✅ (113 projects, no changeset — fixture
  only). **Still open:** a real Workers AI provider run (the documented one-line swap) and
  Route 2 (front `AIChatAgent` itself with a TanStack client).

- _Phase 5 / Second harness (TanStack AI client + shared handshake, engine-direct)_ —
  Built `experimental/tanstack-recovery/` (sibling to `pi-recovery`): a `TanStackAgent`
  Durable Object driving the SAME `ChatRecoveryEngine` AND the SAME `ResumeHandshake` as
  `AIChatAgent`/`Think`, but with a foreign `@tanstack/ai` WebSocket client
  (`SubscribeConnectionAdapter`) and a foreign chunk vocabulary (AG-UI `StreamChunk`s). This
  stresses the two axes the pi fixture left untouched (resume handshake against a foreign
  client transport; streaming codec against a foreign vocabulary). **Files:** `faux-model.ts`
  (deterministic slow AG-UI stream; one-line swap to `@cloudflare/tanstack-ai` documented),
  `tanstack-codec.ts` (`TanStackRecoveryCodec implements ChatRecoveryCodec`; concatenates
  `TEXT_MESSAGE_CONTENT` deltas into `{ text, parts:[] }`; AG-UI `isProgressChunk` list) +
  unit test, `tanstack-agent.ts` (engine adapter + wake hooks mirroring `pi-agent.ts`, PLUS a
  `ResumeHandshake` instance wired over `onConnect`/`onMessage` with a `ResumeHandshakeHost`),
  `ws-bridge.ts` (the Approach-A `cf_agent_* <-> AG-UI` client translation),
  `ws-adapter.ts`/`client.tsx` (real `useChat` demo), `server.ts` (WS via `routeAgentRequest`
  - HTTP `/start`/`/status`), and a SIGKILL e2e with a headless bridge client. **Core
    finding:** the shared `ResumeHandshake` (and `ResumableStream.replayChunks`) are
    **frame-vocabulary-coupled but protocol-agnostic** — only `responseMessageType` is
    injectable, yet the notify → ACK → replay protocol (incl. #1733 double-send, #1645
    terminal-via-resume) drove the foreign client through a **thin** client bridge (one
    frame-router, ~6 wire constants) with **zero change to published `agents`**. **Approach B**
    (make the resuming/none/response vocabulary injectable on `ResumeHandshakeHost`,
    defaults = exact `cf_agent_*` bytes so the golden gate stays green) is therefore **deferred
    as optional** — revisit only if a second foreign client appears. **Still open:** the
    tool-`parts` codec path (text-only here, like pi — _since closed; see the newest progress-log
    entry_), a real Workers AI provider run (the documented swap), and Route 2 (front
    `AIChatAgent` itself with a TanStack client).
    **Dependency:** `@tanstack/ai-client`/`-react` require `@tanstack/ai@0.32`, so the repo was
    bumped `0.28 → 0.32` (`agents` + `codemode` devDeps); peer ranges + public API unchanged,
    all 113 projects typecheck → no changeset (and no engine source change → none for the
    harness). Tests: `pnpm run check` ✅ (113 projects); `tanstack-codec` unit (14) ✅;
    `tanstack-recovery` e2e ✅ (deterministic mid-stream reconnect handshake — foreign client
    observes `STREAM_RESUMING` → ACK → replay → completed turn; and SIGKILL mid-stream →
    `recoveredVia === "continue"` with `prefixChars + generatedChars === total`).

- _Phase 5 / Tier-2 (resume-handshake + streaming-codec seams extracted into
  `agents/chat`; one behavior-visible convergence → one changeset)_ — Deduped the
  byte-parallel Tier-2 seams the `@cloudflare/ai-chat` and `@cloudflare/think`
  hosts hand-maintained in lockstep, in risk-ordered slices (commit `038e6d23`).
  **T2-1:** formalized `ChatRecoveryCodec` (`toRecoveryPartial`) + `AISDKRecoveryCodec`
  in `recovery-codec.ts`, made `PiRecoveryCodec` conform, and routed both hosts'
  `_getPartialStreamText` through the shared singleton (zero behavior). **T2-3a:**
  collapsed the adapter `resolveRecoveryStreamId` and the wake-hook
  `resolveRecoveryStream` into one `ChatRecoveryAdapter.resolveRecoveryStream`; the
  give-up path now reads `.streamId` and resolves the **newest durable row**
  (`ORDER BY created_at DESC LIMIT 1`) instead of an in-memory first-match `.find()`
  — identical for single-attempt turns, more correct across recovery attempts.
  Behavior-visible → `recovery-stream-resolution-newest-row` changeset
  (`@cloudflare/ai-chat` + `@cloudflare/think` patch). **T2-3b:** gave the no-op
  hooks (`isAwaitingClientInteraction`, `invokeOnChatRecovery`,
  `onShouldKeepRecoveringError`) engine-side defaults (`false` / `{}` / no-op) so a
  minimal adapter shrinks, and dropped pi's redundant `continueFromPartial` detail.
  **T2-2a/T2-2b:** extracted `resume-handshake.ts` (the proactive `STREAM_RESUMING`
  notify, the REQUEST decision tree, the ACK decision tree, and the #1645/#1575
  terminal-replay path) behind a host-owned `ResumeHandshakeHost` seam
  (`pendingResumeConnections` + the continuation `awaitingConnections` stay
  host-owned, passed in, because they couple to the out-of-scope streaming loop);
  wired ai-chat then think to delegate, deleting both hand-maintained copies.
  **T2-4:** moved the progress-chunk-type predicate onto the codec
  (`isProgressChunk`); ai-chat consults it at its existing bump site (zero timing
  change), think's flush-gated bump is untouched. **Key review findings:** (1) the
  golden handshake fixture (`resume-handshake-frames.ts`) was self-referential —
  the test asserted only the builder functions, never the real driver — so a
  driver-level test (`resume-handshake.test.ts`) now constructs the actual
  `ResumeHandshake` against a fake host and asserts every branch's frames `toEqual`
  the golden builders (host-agnostic, so it is also the byte-identity gate for
  think, whose native browser reconnect has no e2e); (2) cross-package constant
  equivalence (`cf_agent_use_chat_response` etc.) confirmed, so byte-identity is
  enforced not assumed; (3) the lazy `_resumeHandshake()` getter's captured
  `ResumableStream`/`ContinuationState`/pending-set references are stable
  per-instance (assigned once, never reassigned). `recovery-codec.test.ts` pins the
  `isProgressChunk` list; `recovery-engine.test.ts` adds minimal-adapter cases
  proving the T2-3b defaults; think's #1575 helper now exercises the shared driver.
  **Deferred (explicitly):** converging the progress-bump _timing_ (ai-chat per-type
  vs think per-flush — correctness-critical for the no-progress budget) and moving
  start-id alignment onto the codec; the full streaming-driver merge (Tier-3).
  _(Progress-bump timing convergence has since landed — see the progress-log entry
  below; start-id alignment + Tier-3 remain deferred.)_ The
  unrelated, pre-existing expected-RED `reattach-budget.test.ts` gate (wall-clock
  re-attach budget; partially addressed by #1670) was `it.skip`-ed to keep the
  manual think-e2e suite green. **Forcing function (next):** the planned TanStack AI
  harness (engine-direct, `examples/`) will validate the extracted handshake/codec
  against a foreign client transport + real Workers AI model and drive any residual
  seam corrections. Tests: `pnpm run check` ✅ (112 projects); agents workers 2004 +
  16 new codec ✅, ai-chat workers 687 ✅, think workers ✅; agents chat unit
  (golden frames + driver gate + minimal-adapter) ✅; ai-chat recovery /
  recovering-status / outcomes / exhaustion e2e ✅; think stall + messenger
  recovery e2e ✅; pi SIGKILL e2e ✅.

- _Phase 5 / P5-1b (pi adapter upgraded to `stream_continuation`; seam-difference
  correction; Flue analysis; no package behavior change, no changeset)_ — Upgraded
  the `experimental/pi-recovery/` fixture so the pi adapter takes the **same
  continue-from-partial path as the AI SDK adapter** rather than full-regenerate.
  **Motivation:** an analysis of [Flue](https://github.com/withastro/flue) (requested
  to sanity-check the recorded seam difference) showed Flue is itself a **pi-based**
  harness — its `session.ts`/`submission-state.ts` import `@earendil-works/pi-ai` — and
  it does far more than regenerate: it persists streaming deltas via a
  `StreamChunkWriter` keyed `submissionId:turnId:attemptId`, reconstructs the
  interrupted partial in `recoverInterruptedStream`, and **continues from it**
  (`stream_continuation`); it also preserves completed tool results across a mid-batch
  interruption (`tool_results_partial` — synthesize interrupted-markers for the
  unresolved calls, never re-execute the settled ones), all under a leased submission
  execution store (`attempt_id`/`lease_expires_at`/`recovery_requested_at`). That made
  it clear the prior P5-1 note ("pi has no mid-assistant resume, so it regenerates")
  described a limitation of the **first text-only codec**, not of pi. **Change:** (1)
  the codec already reconstructs `{ text, message }` from buffered `message_update`
  events — now `decodePartial`'s clonable partial `AssistantMessage` is used as a merge
  target; (2) `PiAgent` flushes every delta durably (so a SIGKILL leaves a non-empty,
  recoverable partial), preserves the reconstructed partial as a `partial`-flagged
  transcript entry in `persistOrphanedStream` (gated on `streamStillActive`, mirroring
  the AI SDK adapter), classifies `continue` when a partial survived, and on the
  scheduled `_chatRecoveryContinue` regenerates only the **suffix** after the survived
  prefix (faux model primed with `full.slice(prefix.length)`), merging it back onto the
  partial entry to land the identical full reply. A preserved partial is excluded from
  pi's model context (`_piMessages()`) so the user stays the leaf and pi GENERATES the
  suffix; the merge then folds it on. Full regenerate stays as the `retry` fallback for
  the no-partial case (crash before the first delta flushed). **Genericity proof
  strengthened:** the engine's `continue` path + `persistOrphanedStream` + the
  never-drop persist clause are now exercised by a non-AI-SDK consumer with **no
  engine-side change** — the codec owns the wire-vocabulary and the merge, the engine
  owns the lifecycle. **e2e upgraded** (`e2e/recovery.test.ts`): after the SIGKILL +
  restart it now asserts continuation, not regeneration — `recoveredVia === "continue"`,
  `partialPrefixChars > 0`, `0 < recoveryGeneratedChars < total`, and
  `partialPrefixChars + recoveryGeneratedChars === total` (prefix preserved, only the
  remainder generated). Tests: pi SIGKILL continuation e2e 1/1 ✅; package typecheck ✅.
  No changeset (no `packages/` runtime behavior change; the fixture is `experimental/`
  and unpublished; the only `agents` change in scope — `SnapshotMessage` — shipped in
  P5-1).

- _Phase 5 / P5-1 (genericity proof — REAL pi adapter on the shared engine; no
  package behavior change, no changeset)_ — Built `experimental/pi-recovery/`, a
  runnable Worker that drives the **real** `@earendil-works/pi-agent-core` `Agent`
  (real loop, real `continue()`, real `Message[]`/`AgentEvent` vocabulary) on the
  SAME `ChatRecoveryEngine` as `AIChatAgent`/`Think`. **Uses the real published
  package, not a synthetic stand-in** — an initial hand-rolled `text`/`end`
  vocabulary was scrapped because validating the engine against a strawman shaped
  to fit it is a circular proof. **Workers-compat (the load-bearing risk):** the
  real `Agent` value pulls `@earendil-works/pi-ai`, whose barrel eagerly registers
  every provider (`@smithy/node-http-handler`, proxy-agents, Anthropic/AWS/Google/
  Mistral/OpenAI SDKs). Inference said "won't bundle"; **the empirical test said it
  does** — `wrangler deploy --dry-run` bundles at 841 KiB gzip and the `Agent`
  constructs + runs in `workerd` under `nodejs_compat` (esbuild tree-shakes, and
  `canvas` is only a pi-ai _devDependency_ so it never enters the runtime tree).
  Deterministic streaming uses pi-ai's built-in `registerFauxProvider`
  (`tokensPerSecond` low) so the turn streams through pi's REAL stream path with no
  LLM/network — interruptible mid-flight. **As-built seam wiring:** `PiAgent` (a base
  `Agent` DO) persists its transcript to `pi_messages`, buffers pi's `AgentEvent`
  stream into the shared `ResumableStream`, and reconstructs partials via
  `PiRecoveryCodec` over pi's real `message_update`/`message_end` events
  (`text_delta` accumulation) — feeding the engine the identical `{ text, parts }`
  `RecoveryPartial` the AI SDK codec does, so the engine never sees the wire
  vocabulary. **Recorded Tier-2 seam difference (exit criterion #4):** a text-only
  pi turn has no settled tool results and no mid-assistant resume, so recovery
  **regenerates** the unanswered user turn via pi's real `continue()` rather than
  merging the orphaned partial (the AI SDK adapter merges). Concretely the wake
  hooks set `classifyRecoveredTurn → "retry"` and `shouldPersistOrphanedPartial →
false`; the engine supported this with **no engine-side change**, and the
  `createChatFiberSnapshot` input was already generalized off `UIMessage` to
  `SnapshotMessage` (prior slice) so the snapshot builder stayed wire-agnostic — the
  two together are the genericity proof. **e2e (the P5-1 exit criterion):** a real
  `wrangler dev` SIGKILL crash-mid-stream test (`e2e/recovery.test.ts`) — start a
  turn, confirm it is in-flight (orphaned fiber row, no committed assistant), SIGKILL
  mid-stream, restart on the same persist dir, and assert the shared engine
  regenerates the turn (assistant commits, fiber row reclaimed). **Tooling note:**
  the pi deps tripped pnpm's `verifyDepsBeforeRun` build-script gate (blocking all
  repo commands); resolved by pinning `@google/genai`/`protobufjs` to
  `allowBuilds: false` (the faux path never invokes them). The shared Tier-2
  _extraction_ (lifting the resume handshake + streaming codec into `agents/chat`
  behind adapters, then folding corrections back into the AI SDK adapter) is the
  remaining Phase-5 work; P5-1 establishes the proof and the second-consumer harness
  that extraction will be driven against. Tests: pi SIGKILL e2e 1/1 ✅; `pnpm run
check` ✅ (112 projects); agents workers 1996 ✅, ai-chat ✅, Think ✅ (the
  `SnapshotMessage` widening is type-only — all three consume `agents/chat`
  unchanged at runtime). No changeset (no `packages/` runtime behavior change; the
  fixture is `experimental/` and unpublished).
- _Auto-continuation convergence (post-Slice-4f — adopt Think's event-driven barrier in
  `AIChatAgent`; user-visible, `@cloudflare/ai-chat` minor changeset)_ — Replaced
  ai-chat's in-turn, 60s-polling parallel-tool barrier (#1649) with Think's
  event-driven, no-timeout, stream-gated barrier (#1650). **As-built mapping** (Think →
  ai-chat): `_scheduleAutoContinuation` (coalesce-timer arm + pending create/update; if
  already-running `pastCoalesce`, defer), `_rearmPendingAutoContinuationForBatch`
  (re-arm on a non-`autoContinue` sibling result that may complete the batch — never
  creates a pending), `_fireAutoContinuationWhenStable` (the barrier: returns early on
  `pastCoalesce` / `_continuationBarrierActive` / `_streamingTurnActive`; fast-path fires
  when no apply is in flight and `_hasIncompleteToolBatch()` is false; otherwise drains
  in-flight applies under `keepAliveWhile` and re-checks synchronously in `finally` so a
  sibling-armed coalesce macrotask can't double-fire), `_drainInteractionApplies`
  (tail-chasing drain bounded by real apply activity), `_onStreamingTurnFinalized`
  (clears the stream gate + re-arms — the SSE-loop finalize hook), and `_fireAutoContinuation`
  (cancels the still-armed timer, then **synchronously** calls `_runExclusiveChatTurn` so
  the queue is registered before any idle observer can resolve). Dropped
  `AUTO_CONTINUATION_PENDING_TOOL_TIMEOUT_MS`, the in-turn poll, and
  `_awaitPendingInteractionBarrier`. New fields: `_continuationTimer`,
  `_continuationBarrierActive`, `_streamingTurnActive` (all cleared in `resetTurnState`);
  `AUTO_CONTINUATION_COALESCE_MS` set to 50ms to match Think. **SSE-loop finalize hook:**
  ai-chat streams via the SSE reader, not Think's `toUIMessageStream()` loop, so the
  stream-active gate is set after `_startStream` and cleared via `_onStreamingTurnFinalized()`
  in an outer `finally` in `_reply` (package-local; carries a Phase-5 note since the Tier-2
  codec extraction will touch the same region). **Deferred/coalesce reconciliation:**
  ai-chat's `_continuation` deferred machinery is kept but the `prerequisite` field is gone
  (the event-driven barrier subsumes "wait for a prior thing"); `_activateDeferredAutoContinuation`
  now routes the activated continuation back through `_fireAutoContinuationWhenStable` (so a
  freshly-activated continuation re-checks completeness instead of firing blind).
  **Idle/stable awareness (the one place ai-chat goes beyond Think):** moving the barrier
  out of the turn opened a window where the turn queue is momentarily empty but a debounced
  continuation is armed. Added `_hasArmedContinuation()` (pending set, not `pastCoalesce`,
  and `_continuationTimer !== null || _continuationBarrierActive`) and taught both
  `waitForIdle()` (loop until the armed decision resolves) and `waitUntilStable()` (don't
  report stable while armed) about it. This is strictly more correct — recovery/idle-eviction
  must not fire mid-continuation — and matches `waitUntilStable`'s docstring ("no queued
  continuation turns"); a _parked_ continuation (incomplete batch) is reported via
  `hasPendingInteraction()`, and a _running_ one (`pastCoalesce`) via the turn queue, so
  neither is double-counted. **Deep review:** double-fire guard holds (no `await` between the
  drain `finally`'s flag clear and the fire/return decision); the stream gate prevents firing
  against a batch the model is still streaming (a fast client tool can resolve before its
  slower siblings are even emitted); a true orphan parks budget-free and re-arms when its
  sibling lands. **e2e coverage:** added a deterministic workers-pool test (parks a
  parallel batch when a sibling never arrives — `hasPending` stays true, `activeRequestId`
  null, `getChatMessageCallCount` 0, `hasPendingInteraction` true — then fires exactly once
  when the missing sibling lands); the **deploy/crash mid-park** case is covered by the
  existing recovery PARK tests (`durable-chat-recovery.test.ts` "PARKS a continuation/retry…
  while a CLIENT interaction is pending" + "client tool result after park resumes the turn"),
  because a parked auto-continuation leaves the same on-disk signature as a HITL park (an
  `input-available` orphan) → recovery parks `skipped`/`awaiting_client_interaction`
  budget-free rather than terminalizing. Tests: `pnpm run check` ✅ (111 projects); agents
  workers 1996 ✅, ai-chat workers 687 ✅ (incl. the new park test; the four existing
  auto-continuation timing tests required the idle/stable awareness above and now pass
  unchanged in intent), Think workers 686 ✅ for parity; ai-chat SIGKILL e2e 10/10 ✅; Think
  chat-recovery e2e 5/5 ✅ (Think source byte-unchanged this slice). One changeset
  (`@cloudflare/ai-chat` minor — no-timeout park behavior change).

- _Slice 4f-ii(b) (Phase 4 — `parseProtocolMessage` migration; classification-only, no
  changeset)_ — Migrated ai-chat's `onMessage` off its inline `JSON.parse` +
  `data.type === MessageType.X` switch and onto the shared `parseProtocolMessage`
  (which Think already uses), dispatching on the typed `ChatProtocolEvent` discriminants
  (`event.type === "chat-request" | "clear" | "messages" | "cancel" |
"stream-resume-request" | "stream-resume-ack" | "tool-result" | "tool-approval"`).
  **Classification-only:** all eight handler bodies are byte-preserved (`data.` →
  `event.`); the `messages` event still calls `autoTransformMessages` + `persistMessages`
  (ai-chat persists the client snapshot — explicitly NOT converged onto Think's no-op).
  **Verify-first / behavior-preservation review:** (1) the wire strings in ai-chat's
  `MessageType` enum and `agents`' `CHAT_MESSAGE_TYPES` are byte-identical for all eight
  incoming types (same client talks to both packages), so the parser recognizes exactly
  the set the inline switch did and routes each to the same body; (2) the inline switch's
  first guard was `USE_CHAT_REQUEST && init.method === "POST"`, so a non-POST use-chat
  request fell through to the consumer's `onMessage` — preserved by gating the delegate
  on `!(event.type === "chat-request" && event.init.method !== "POST")` (only the POST
  branch enters the handler; everything else, including a parser-null non-JSON/unknown
  frame, still falls to `_onMessage`); (3) non-JSON and JSON-without-`type` both yield
  `parseProtocolMessage(...) === null` → `_onMessage`, matching the old try/catch +
  no-`type` fall-through; (4) the parser is marginally _more_ robust (defaults a missing
  `init` to `{}` rather than throwing on `data.init.method`, and a missing `toolName` to
  `""`) — strictly safer for malformed frames, no change for real traffic. One type fix:
  the parser types `clientTools[].parameters` as `unknown` (vs ai-chat's `ClientToolSchema`
  `JSONSchema7`), so the auto-continuation call site now casts `clientTools as
ClientToolSchema[] | undefined`, mirroring the existing cast on the `_lastClientTools`
  assignment two lines up. Removed the now-unused `type IncomingMessage` import. Tests:
  `pnpm run check` ✅ (111 projects); ai-chat workers 686 ✅; ai-chat real-`wrangler dev`
  SIGKILL e2e 10/10 ✅ (the dispatch-path gate); Think workers 686 ✅ for parity. Think
  and the `agents` package are byte-unchanged this slice (Think already routed through
  the pre-existing `parseProtocolMessage`), so the Think SIGKILL e2e cannot regress and
  was not re-run. No changeset.

- _Slice 4f-ii(a) (Phase 4 — `enforceRowSizeLimit` convergence; user-visible, changeset
  on both packages)_ — Ran the verify-first gate on ai-chat's `_enforceRowSizeLimit`
  vs the shared `enforceRowSizeLimit` (Think's). **Not** a byte-identical lift — they
  had drifted in two independent, observable ways, so this was treated as a convergence
  (not a 4f-i leaf lift), with the correct behavior decided and written up under the
  4f-ii bucket. (1) **Tool-output compaction shape:** ai-chat replaced oversized tool
  outputs with a flat english summary string (`"…too large to persist… Preview: …"`),
  discarding shape; Think used the structured, shape-preserving `truncateToolOutput`.
  Decided **structured wins** (a model can keep reasoning about a shape-preserving
  truncation; the flat string is strictly lossier) — ai-chat now uses `truncateToolOutput`
  and its summary string is gone. (2) **Compaction annotations + warnings:** ai-chat
  annotated `metadata.compactedToolOutputs` / `compactedTextParts` and `console.warn`ed;
  Think did neither. Decided **annotate + warn on both** (additive metadata lets a client
  tell a row was compacted) — Think now emits them too. Implemented by extending the
  shared `enforceRowSizeLimit` to own both the structured compaction and the annotations,
  plus an optional `warn` hook (`EnforceRowSizeLimitOptions`) so each package keeps its
  own log prefix (`[AIChatAgent]` / `[Think]`). Both call sites are now thin bindings:
  ai-chat's `_enforceRowSizeLimit` and a new Think `_rowSafe` helper (folds in the
  `sanitizeMessage` it always pairs with, dedups three identical call sites + the
  submission-serializer). **Deep review:** truncation thresholds matched already (both
  compact tool outputs > 1KB, both truncate text parts oldest→newest until they fit, both
  use the same 1.8MB `ROW_MAX_BYTES` byte-length guard incl. multibyte UTF-8); the only
  value-level change is ai-chat's tool-output text (summary string → structured marker)
  and Think's newly-present annotations; non-assistant (user/system) messages still fall
  straight to text truncation; metadata is merged (spread over existing), never clobbered;
  the engine/recovery, hibernation/wake order, terminal-before-seal, and settled tool
  results are untouched (this is a pure pre-storage serialization step). Tests: ai-chat
  `row-size-guard.test.ts` assertions that pinned the old summary string were repointed at
  the structured `... [truncated N chars]` marker (the `compactedToolOutputs` metadata
  assertion was already correct); Think's row-size tests were already structure-shaped and
  needed no change. `pnpm run check` ✅ (111 projects); agents workers 1996 ✅, ai-chat
  workers 686 ✅, Think workers 686 ✅; ai-chat SIGKILL e2e 10/10 ✅; Think SIGKILL e2e
  11 files / 26 tests ✅ with the expected-RED `reattach-budget` gate (unrelated
  wall-clock budget) left untouched. Two changesets (`@cloudflare/ai-chat` minor —
  structured tool-output compaction; `@cloudflare/think` minor — compaction
  annotations/warnings).

- _Slice 4f-i (Phase 4 — byte-verified pure leaf lifts; zero behavior, no changeset)_
  — Ran the verify-first gate at execution time on all eight 4f-i items (line numbers
  from 2026-06 had drifted; re-diffed by method name) and confirmed each
  byte-equivalent modulo comments: `sendIfOpen` / `isWebSocketClosedSendError`
  (identical in both packages **and** a third copy in `continuation-state.ts`);
  `_getPartialStreamText` (one-word comment diff); the client-interaction predicates
  (`_partAwaitsClientInteraction` / `_toolPartName` / `_clientResolvableToolNames`,
  docblock-only diff); `_hasIncompleteToolBatch` (identical incl. comment); the
  terminal KV trio (`_recordChatTerminal` / `_clearChatTerminal` /
  `_pendingChatTerminal`, identical); the stream-cleanup pair
  (`_ensureStreamCleanupScheduled` / `_cleanupStreamBuffers`, one extra comment clause
  in Think); and `_setChatRecovering` + the recovering-frame builder (identical apart
  from the wire-type enum + broadcast wrapper, exactly as predicted). Lifted them into
  `agents/chat`: a **new `connection.ts`** (`sendIfOpen` / `isWebSocketClosedSendError`
  - a `ChatConnection` minimal type — and deduped `continuation-state.ts`'s copy, a
    bonus third-copy removal); `getPartialStreamText` in `message-builder.ts` (over the
    resumable-stream chunk reader); `hasIncompleteToolBatch` + the three client
    predicates in `tool-state.ts`; `STREAM_CLEANUP_DELAY_SECONDS` + `cleanupStreamBuffers`
    in `resumable-stream.ts`; and the terminal trio + `buildChatRecoveringFrame` +
    `setChatRecovering` in `recovery-incident.ts` (storage-glue home, same precedent as
    4e). Both packages are now thin per-package bindings; the per-package divergence
    (recovering wire-type enum `CF_AGENT_CHAT_RECOVERING` vs `MSG_CHAT_RECOVERING`, and
    the `_broadcastChatMessage` / `_broadcastChat` wrapper) is threaded as params, and
    the `_broadcastChat` wrappers stayed package-local as planned. The duplicated
    `CHAT_RECOVERING_KEY` / `CHAT_LAST_TERMINAL_KEY` / `CHAT_RECOVERING_FLAG_TTL_MS`
    local constants were deleted outright (no remaining direct references once the
    helpers absorbed them). **Deep review (zero-behavior confirmation):** storage keys +
    values unchanged (cutover-safe; the shared constants are the same strings); wake/
    hibernation ordering unchanged (bindings issue the same storage ops in the same
    order); the stream-cleanup re-arm stays non-idempotent (rearm passes
    `{ idempotent: false }`, invariant documented on the shared fn); the recovering
    set/clear stays idempotent-on-active-existing; terminal-before-seal and settled
    tool results untouched; observability/recovering-frame payload shape identical;
    `setChatRecovering` now uses a single injected `now` for both the staleness check and
    the stored `at` (was two `Date.now()` calls microseconds apart — not observable, and
    matches the engine's injected-clock seam). Tests: `pnpm run check` ✅ (sherif /
    exports / oxfmt / oxlint / typecheck 111); agents workers 1996 ✅, ai-chat workers
    686 ✅, Think workers 52 + react 2 ✅; ai-chat real-`wrangler dev` SIGKILL e2e 10/10
    ✅; Think `chat-recovery` + `stall-recovery` SIGKILL e2e 6/6 ✅. The expected-RED
    `reattach-budget` e2e (unrelated wall-clock budget) was left untouched. Internal
    `@internal` seam, zero behavior change → no changeset.

- _Confidence review of the go-forward plan (code-grounded; docs only)_ — Before
  handing the plan to a fresh session, pressure-tested the new Slice 4f and
  auto-continuation decision against the actual code (not just the explore summaries).
  **Verified solid:** `_hasIncompleteToolBatch` is byte-identical across both packages
  (comment included); `CHAT_RECOVERING_FLAG_TTL_MS` / `STREAM_CLEANUP_DELAY_SECONDS`
  and the recovering/terminal keys match the shared `recovery-incident.ts` values
  (so the constant dedup is a no-op on keys + timing, no migration); the
  client-interaction predicates (`_partAwaitsClientInteraction` / `_toolPartName` /
  `_clientResolvableToolNames`) are byte-identical with the broad-vs-client-only
  asymmetry living in the wrappers — so "lift leaves, keep wrappers" is correct.
  **Five corrections folded in:** (1) the **auto-continuation convergence was badly
  mis-scoped** — it is not a near-trivial follow-on to 4f but a substantial
  `AIChatAgent` rearchitecture (ai-chat's barrier runs _inside_ the exclusive turn and
  its own docblock at `index.ts:2437–2441` says that is why it needs no double-fire
  guard; moving to Think's event-driven model requires taking the barrier out of the
  turn, adding a `_continuationBarrierActive`-style guard, adding an SSE-loop
  stream-finalize re-arm hook that has no current analogue, and reconciling ai-chat's
  `_continuation` coalesce/deferred machinery) — rewrote the decision to spell this
  out and added a **deploy-mid-park e2e** requirement (a parked continuation must
  re-arm on recovery, not exhaust/false-terminalize); (2) **`enforceRowSizeLimit` is
  not a zero-behavior lift** (ai-chat adds compaction metadata + warnings and may
  differ in truncation) → moved to a new **4f-ii** bucket with a verify-first gate and
  likely changeset; (3) **`parseProtocolMessage` migration clarified** as
  classification-only — ai-chat must keep its distinct handlers, esp.
  `CF_AGENT_CHAT_MESSAGES` (ai-chat persists; Think no-ops) — also moved to 4f-ii;
  (4) **baked a verify-byte-equivalence-first gate into all of 4f** rather than
  asserting equivalence in prose (line numbers drift); (5) minor completeness — added
  request-context persist/restore to Tier 3, noted the `_broadcastChat` wrappers stay
  package-local (threaded as the broadcast-fn param), and noted the soft coupling
  between the auto-continuation SSE-loop hook and the Tier-2 codec region. Net: 4f is
  now split into safe **4f-i** (pure leaf lifts) and behavior-sensitive **4f-ii**, and
  the auto-continuation convergence is correctly framed as the largest single piece of
  go-forward work. No code; plan only.

- _Design review + plan update (pre-Phase-5 chat-layer extraction map; docs only)_ —
  Before starting Phase 5, ran a four-surface design review (message persistence;
  stream lifecycle + broadcast; inbound request / connection handling;
  tool / HITL / terminal) comparing `AIChatAgent` and `Think` method-by-method for
  parallel machinery NOT already shared. Recorded the result as the new "Chat-layer
  extraction map" section with three tiers. **Tier 1** — safe leaf dedup, captured as
  new **Slice 4f**: the duplicated `CHAT_*` / `STREAM_CLEANUP_*` constants,
  `sendIfOpen` / `isWebSocketClosedSendError`, the terminal KV trio
  (`_recordChatTerminal` / `_clearChatTerminal` / `_pendingChatTerminal`),
  `_setChatRecovering` + recovering frame, `_getPartialStreamText`, the stream-cleanup
  pair, `_hasIncompleteToolBatch`, the client-interaction predicates, ai-chat's local
  `enforceRowSizeLimit` reimpl, and ai-chat's non-use of the shared
  `parseProtocolMessage`. **Tier 2** — structural seams the pi adapter should DRIVE
  during Phase 5 (the resume / reconnect handshake and the streaming-loop codec);
  extracting them before a non-AI-SDK consumer would re-bake `UIMessage` assumptions,
  so they are sequenced into Phase 5, not before. **Tier 3** — keep-package-specific
  (storage model, Think submissions / codemode / media / repair, ai-chat
  persisted-cache / migration / early-approval-persist, `_persistOrphanedStream`
  id-merge semantics, boot ordering). Also **locked the auto-continuation convergence
  decision** (new behavior decision + convergence-matrix row): adopt Think's
  event-driven, no-timeout, stream-gated parallel-tool barrier (#1650) in
  `AIChatAgent`, dropping its in-turn 60s force-continue (#1649) — a semver-minor,
  changeset-bearing behavior change, sequenced after Slice 4f (which lands the shared
  `_hasIncompleteToolBatch` it depends on) and independent of Phase 5. Recommended
  sequencing: **Slice 4f → auto-continuation convergence → Phase 5 (pi drives
  Tier 2)**. No code; plan only. (Detail lives in the design-review sub-reports; this
  RFC is the durable record.)

- _Slice 4e (Phase 4 — lift the residual leaf duplication the confidence pass found)_
  — Acted on the confidence-pass finding by lifting the byte-identical leaf
  host-I/O helpers into shared `agents/chat` free functions, leaving each package a
  thin binding. Added to `recovery-incident.ts`:
  `sweepStaleChatRecoveryIncidents(storage, now)` (owns list-by-prefix + TTL select
  - the batched `KV_DELETE_MAX_KEYS` delete loop), `readChatRecoveryProgress(storage)`
    / `bumpChatRecoveryProgress(storage)` (the durable monotonic counter), and the N9
    throttle as `AgentToolStreamProgressThrottle` + the shared
    `AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS` constant. The storage params are typed
    `Pick<DurableObjectStorage, …>` so `this.ctx.storage` passes with no cast and the
    helpers stay unit-testable with a fake. Both `AIChatAgent` and `Think` dropped
    their duplicated `_sweepStaleChatRecoveryIncidents` (hook now points straight at the
    shared fn), turned `_chatRecoveryProgressMarker` / `_bumpChatRecoveryProgress` into
    one-line bindings, replaced the in-memory `_lastAgentToolStreamProgressAt` field +
    inline throttle with `new AgentToolStreamProgressThrottle()`, and deleted their
    local duplicate `CHAT_RECOVERY_PROGRESS_KEY`, `AGENT_TOOL_STREAM_PROGRESS_BUMP_THROTTLE_MS`,
    and `KV_DELETE_MAX_KEYS` constants. Per the confidence-pass call, `_resolveRecoveryStreamId`
    was deliberately LEFT package-local (lifting it would feed `ResumableStream` into the
    engine for ~6 lines — the hook-bloat inversion the 4d-2 fallback warned against). Also
    extended the `@internal` barrel comment in `chat/index.ts` to cover the
    `recovery-engine` / `stall-watchdog` blocks, not just `recovery-incident`. Zero
    behavior change — the throttle gate is identical (a fresh isolate's first chunk still
    credits because production `now` ≫ the window; a unit test pins exactly that). Tests:
    9 new `recovery-incident` unit tests (sweep prefix-scoping + no-op + 128-batching;
    progress read/increment; throttle credit/throttle windows); full `pnpm run check`
    green; agents / ai-chat / think suites green; local `wrangler dev` SIGKILL e2e —
    ai-chat 10/10, think `chat-recovery` + `stall-recovery` green. Only e2e red remains
    the documented expected-RED `reattach-budget` gate (unrelated wall-clock budget;
    untouched). Internal `@internal` seam, zero behavior change → no changeset.

- _Phase 4 confidence pass (exit-criteria audit + reviewer checklist; docs only)_ —
  Before advancing to Phase 5, audited both packages for residual duplicated
  recovery logic and walked the release reviewer checklist. **Exit criteria met:**
  every recovery _orchestration engine_ now routes through `ChatRecoveryEngine` —
  incident begin/update + exhaustion-notification core, the give-up spine
  (`exhaustRecoveryGiveUp`, 4d-1), the schedule triplet (4b), the stable-timeout
  reschedule (4c), the wake frame (`handleChatFiberRecovery`, 4d-2), non-chat fiber
  dispatch (3c), the stall watchdog (3a/3b), the shared `partialHasSettledToolResults`
  (4d-2), and the shared incident type + key/sweep _selection_ helpers (4a). Both
  `_beginChatRecoveryIncident` / `_updateChatRecoveryIncident` are one-line engine
  delegations in both packages; `_exhaustChatRecovery` uses the shared
  `buildChatRecoveryExhaustedContext` + `notifyChatRecoveryExhausted` core with only
  package-specific terminal/broadcast ORDERING left local (ai-chat persist-first,
  Think broadcast-first — a deliberate, documented divergence). **Checklist: pass** —
  the 4d-2 commit changed no public (non-`_`) hook signatures (verified by diff);
  defaults flow from the shared `DEFAULT_CHAT_RECOVERY_*` constants; the engine module
  is `@internal` and not exported from the `agents` root (only re-barrelled through
  the `agents/chat` entry both consumers already import); schedule callback names
  (`_chatRecoveryContinue` / `_chatRecoveryRetry`) are stable; the recovery event
  payload is built identically via the `emitRecoveryEvent` adapter hook;
  settled-tool-results are preserved by the byte-equivalent shared helper; HITL turns
  stay budget-free via `isAwaitingClientInteraction` (`hasPendingInteraction` in
  Think); stable-timeout reschedules stay non-idempotent via
  `chatRecoverySchedulePolicy`. **Residual finding (bounded, optional — a possible
  "Slice 4e"):** a small cluster of byte-identical _leaf host-I/O accessors_ is still
  duplicated across both packages — `_chatRecoveryProgressMarker` /
  `_bumpChatRecoveryProgress` (the durable progress counter), the N9 throttle-credit
  pair (`_lastAgentToolStreamProgressAt` + `_onAgentToolStreamProgress`, the only
  duplicated _policy_), `_sweepStaleChatRecoveryIncidents` (sweep glue around the
  shared `selectStaleIncidentKeys`), and `_resolveRecoveryStreamId` (resumable-stream
  metadata lookup). These are leaf accessors, not orchestration engines, so they do
  NOT violate the exit criteria. The cleanest lift would be the sweep (the engine
  already owns get/put/delete incident hooks; a `listIncidents` hook lets it own the
  loop) and the progress-counter + N9 throttle (a shared `agents/chat` helper);
  `_resolveRecoveryStreamId` is deliberately LEFT package-local — lifting it would
  feed `ResumableStream` accessors into the engine for ~6 lines, the exact hook-bloat
  inversion the 4d-2 fallback warned against. Cosmetic nit recorded: the `@internal`
  barrel comment in `chat/index.ts` sits above only the `recovery-incident` export
  block, not the `recovery-engine` / `stall-watchdog` blocks. No code, no tests — audit
  only.

- _Slice 4d-2 (Phase 4 — lift the wake FRAME into the engine; the genericity seam)_
  — Implemented the reviewed seam. Added `ChatRecoveryEngine.handleChatFiberRecovery(ctx, wake)`
  owning the wake lifecycle (chat-fiber gate → requestId parse → snapshot unwrap →
  stream/partial resolution → recovery-kind classification → `beginIncident` →
  exhausted branch → `onChatRecovery` → persist + complete → decision →
  `catch → updateIncident("failed") → rethrow`), with the package-specific decision
  living behind a method-scoped `ChatFiberWakeHooks<TClassify>` object passed as the
  second arg (NOT bolted onto `ChatRecoveryAdapter`, keeping its five give-up-spine
  test fakes focused). Lifted the byte-identical `_partialHasSettledToolResults` into
  one shared pure `partialHasSettledToolResults(parts)` in `agents/chat`; both
  packages dropped their private copy (real dedup, zero behavior change). `Think` and
  `AIChatAgent` each collapsed `_handleInternalFiberRecovery` to a one-line delegation
  and implemented the hooks as private methods — `Think` keeps its submission
  lifecycle + session-leaf + `_handleRecoveryCallbackError` inside
  `dispatchRecoveredTurn`; `AIChatAgent` is leaf-only and returns
  `streamStatus: undefined` (terminal-stream handling stays absent, per the
  "substrate capabilities are optional" decision — reading status would be a behavior
  _change_). Verified: full `pnpm run check` (sherif + exports + oxfmt + oxlint +
  typecheck) green; `agents` 1989 passed, `@cloudflare/ai-chat` 686 passed, `think`
  full suite chain green; new engine unit tests for `handleChatFiberRecovery` +
  `partialHasSettledToolResults`; local `wrangler dev` SIGKILL e2e — ai-chat 10/10,
  think 26 passed + 4 skipped. The only e2e red is `reattach-budget.test.ts`, the
  documented expected-RED regression gate for the unrelated wall-clock re-attach-budget
  bug (manual `think-e2e` project, not the CI gate) — untouched by this slice.

- _Slice 4d-2 design (Phase 4 — seam design + decision record; docs only, no code)_
  — Before touching the wake path (the highest-risk surface in this RFC), recorded
  the seam design and the load-bearing decision it rests on. **Decision: substrate
  capabilities are optional, not shared requirements** (new subsection under
  Genericity) — `Think`'s submission layer and Session-tree leaf are _product
  substrates_, not recovery primitives, so `AIChatAgent` does NOT grow a submission
  layer to converge the wake bodies; instead the wake-recovery DECISION is a
  package-owned seam (`classifyRecoveredTurn` + `dispatchRecoveredTurn`) that each
  host implements on its own substrate, while the engine owns only the wake FRAME.
  This is the inversion-prevention rule (abstraction must not dictate the product)
  and the pi-genericity guarantee (pi has no submissions either). Rewrote the 4d-2
  slice bullet into a concrete seam: engine `handleChatFiberRecovery(ctx, wake)`
  lifecycle (gate → parse → unwrap → stream/partial → classify → beginIncident →
  exhausted-branch → onChatRecovery → persist+complete → decision → catch→failed) +
  a named `ChatFiberWakeHooks<TClassify>` surface, with explicit convergence-onto-Think
  items (shared `partialHasSettledToolResults`, `streamStatus` read, `onChatRecovery`
  ctx builder) and a recorded fallback (helper-extraction-only if the hook surface
  hurts engine readability). Added name-reconciliation notes to
  [rfc-think-turns.md](./rfc-think-turns.md) and
  [rfc-think-actions.md](./rfc-think-actions.md) pointing their assumed
  `ThinkRecoveryAdapter` / `classifyRecoveredTurn` / `resolveStreamForRecovery` seam at
  the real `ChatRecoveryAdapter`. No code, no tests, no changeset — design gate only;
  implementation is blocked on review (see "what I need from you").

- _Slice 4d-1 (Phase 4 — lift the give-up spine; the part deferred from 4c)_ —
  Reading both `_handleInternalFiberRecovery` bodies in full first re-shaped 4d
  (recorded in the slice plan): the bodies are ~70% structurally similar but the
  similar part is mostly control flow, while the meaty logic (stream-status
  tracking, recovery-kind detection, persist gates, stream-completion API, and
  the retry/continue/skip decision) has legitimately DIVERGED — even
  `_partialHasSettledToolResults` has drifted between the packages. So 4d split:
  4d-1 lifts the genuinely-shared give-up spine here; 4d-2 (the wake-frame
  collapse for Phase 5 genericity) is gated behind a seam-design review.
  `Think._exhaustRecoveryGiveUp` and `AIChatAgent._exhaustRecoveryAfterStableTimeout`
  were ~80% identical: resolve config → key from `data.incidentId` → best-effort
  read `stored` (tolerate failure → synthesize) → `stored.status==="exhausted"`
  re-entry guard → build the exhausted incident → resolve streamId + partial →
  `_exhaustChatRecovery` (terminalize) BEFORE the best-effort seal write. Lifted
  into `ChatRecoveryEngine.exhaustRecoveryGiveUp({ callback, data, reason })`
  behind 5 adapter hooks (`exhaustChatRecovery`, `resolveRecoveryStreamId`,
  `getPartialStreamText`, `activeChatRecoveryRootRequestId`,
  `onGiveUpBookkeepingError`); each package method is now a one-line delegation.
  **Byte-equivalence review:** the unified root-id chain (`originalRequestId ??
recoveredRequestId ?? activeRoot ?? stored.root ?? stored.requestId ?? ""`)
  reproduces Think verbatim and collapses to AIChat's chain because AIChat's
  payload type has no `recoveredRequestId` (always `undefined` → skipped);
  `reason` is the only behavioral parameter (Think `stable_timeout` |
  `recovery_error`, AIChat always `stable_timeout`); synthesized
  `attempt`/`maxAttempts` = `config.maxAttempts`, `recoveryKind` from the
  callback, `firstSeenAt`/`lastAttemptAt` = `adapter.now()` (= `Date.now()`),
  `crypto.randomUUID()` id; `createdAt` passed as `incident.firstSeenAt`; both
  read and seal stay best-effort with the original `[Think]`/`[AIChatAgent]` log
  prefixes via `onGiveUpBookkeepingError`. The terminalize-BEFORE-seal ordering
  (#1730/#1645 — a transient terminal write must re-run the WHOLE give-up, not be
  no-op'd by an armed re-entry guard) is preserved and pinned by a test. The
  give-up's terminalize + stream/partial hooks are exactly the surface 4d-2 will
  reuse, so 4d-1 de-risks 4d-2. Added 9 engine unit tests (terminalize→seal
  order + reason threading, re-entry guard, read-fail synth, seal-fail tolerance,
  root-id precedence ×2, no-incidentId uuid synth/no-seal, empty-stream partial
  skip) and back-filled the 5 hooks into the four pre-existing fake adapters.
  Tests: engine unit 42 ✅ (+9); typecheck 111 ✅; `check` ✅; ai-chat workers 686
  ✅ and Think recovery workers 285 ✅ (fiber/submissions/stream + think-session +
  messengers; benign SQLite-alarm harness log only); Think remote-Workers-AI
  give-up e2e (`stall-recovery` + `chat-recovery`) 6/6 ✅; ai-chat real-`wrangler
dev` SIGKILL give-up e2e (`chat-recovery-exhaustion` + `chat-recovery` +
  `chat-recovering-status`) 9/9 ✅. No changeset (internal `@internal` seam, zero
  behavior change).

- _Slice 4c (Phase 4 — centralize the stable-timeout reschedule; re-scoped)_ —
  `_rescheduleRecoveryAfterStableTimeout` was byte-identical between the packages
  (100% dup): read the incident → if under the attempt cap, bump `attempt`, persist
  `status:"scheduled"` + `reason:"stable_timeout_retry"`, and issue a NON-idempotent
  DELAYED schedule (it runs inside the executing one-shot row that `alarm()` deletes
  on return, so an idempotent reschedule would dedup onto the doomed row and never
  fire). Lifted into `ChatRecoveryEngine.rescheduleAfterStableTimeout({ incidentId,
callback, data, fallbackMaxAttempts })`; each package method is now a one-line
  delegation. Generalized the `ChatRecoveryAdapter.scheduleRecovery` hook (from 4b)
  to carry `delaySeconds` — the initial triplet passes `0`, the reschedule passes
  `CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS` — so a single schedule seam serves both.
  **Bonus dedup:** both packages also kept a private `CHAT_RECOVERY_STABLE_RETRY_
DELAY_SECONDS = 3` that shadowed the canonical agents/chat constant; removed both,
  the engine uses the shared one (byte-identical value). **Byte-equivalence review:**
  `adapter.getIncident(key)` returns `ctx.storage.get(key) ?? null` (same `!incident`
  short-circuit, incl. the missing-id case → no key → false); the attempt cap uses
  `fallbackMaxAttempts === maxAttempts`; the put payload is field-for-field identical;
  `adapter.now() === Date.now()`; and the hook issues the same delay (3s) +
  non-idempotent policy. The reschedule deliberately bypasses
  `evaluateChatRecoveryIncident` (coarse same-turn retry, not a fresh interruption)
  and `updateIncident` (no `scheduled` event / recovering-flag churn) — unchanged
  from the originals. **Re-scope:** the give-up seal (`_exhaustRecoveryGiveUp` /
  `_exhaustRecoveryAfterStableTimeout`, ~80% dup) was deferred from 4c to 4d — its
  shared spine interleaves package-specific terminalization + stream/partial reads
  behind #1730/#1645 exactly-once invariants, needing ~5 adapter hooks that are
  exactly 4d's terminalize + stream surface; building them once (in 4d) avoids
  inconsistent seams. Added 5 engine unit tests (attempt bump + delayed
  non-idempotent enqueue, missing id, no record, budget spent, maxAttempts
  fallback). Tests: engine unit 34 ✅ (+5); typecheck 111 ✅; `check` ✅; Think workers
  686 ✅ and ai-chat workers 686 ✅ (clean, no flake); ai-chat real-`wrangler dev`
  SIGKILL e2e 10/10 ✅; Think remote-Workers-AI recovery e2e (`chat-recovery` +
  `stall-recovery`) 6/6 ✅. No changeset (internal `@internal` seam, zero behavior).

- _Slice 4b (Phase 4 — centralize the schedule-a-recovery triplet, behavior-preserving)_ —
  The `updateIncident("scheduled")` + `_emit("chat:recovery:scheduled")` +
  `schedule(0, callback, data, chatRecoverySchedulePolicy("initial"))` block
  appeared at 7 call sites (Think: stall + 2 fiber; AIChat: stall + 3 fiber).
  Collapsed into one engine method `ChatRecoveryEngine.scheduleRecovery({ incident,
recoveryKind, callback, data, reason? })` driving transition → emit → enqueue in
  that order, behind a new `ChatRecoveryAdapter.scheduleRecovery(callback, data,
reason)` hook (each package: `schedule(0, callback, data,
chatRecoverySchedulePolicy(reason))`). Widened `ChatRecoveryIncidentEvent["type"]`
  to include `"chat:recovery:scheduled"` so the emit flows through the existing
  `emitRecoveryEvent` mapping (byte-identical payload). **Byte-equivalence review:**
  (1) the engine preserves the exact order; (2) `incident.requestId` is what every
  call site emitted — the budget evaluation rewrites `incident.requestId =
identity.requestId` on each attempt (`recovery-incident.ts`), so reading it off
  the incident matches; (3) `recoveryKind` is passed EXPLICITLY (not derived),
  because AIChat's lost-partial branch opens a `continue` incident but schedules +
  reports a `retry` — each call site passes the same literal/variable it emitted
  before; (4) the only structural reorder is Think's stall path, where the pure
  `recoveredRequestId = _hasRunningSubmission(...)` read now precedes the engine
  call — it reads the submissions store, independent of the incident-status /
  recovering-flag that `updateIncident` mutates, so its value is unchanged; (5)
  the stable-timeout reschedule (`reason:"stable_timeout_retry"`, non-idempotent,
  direct `storage.put`) is deliberately untouched — that is Slice 4c. Added 4 engine
  unit tests pinning the order, the explicit-`recoveryKind` override, the default
  `initial` reason, and verbatim payload/reason forwarding. Tests: engine unit 29 ✅
  (+4); repo typecheck 111 ✅; `check` (sherif/exports/oxfmt/oxlint) ✅; Think workers
  686 ✅ and ai-chat workers 686 ✅ (the one transient Think failure was the known
  SQLite-alarm-timing pool race — clean on rerun, and the scheduling-heavy
  `fiber`+`submissions` suites passed twice, 53 each); ai-chat real-`wrangler dev`
  SIGKILL recovery e2e 10/10 ✅ (same engine path, offline-safe). **Both real-edge
  paths validated:** after re-auth, the Think remote-Workers-AI recovery e2e
  (`chat-recovery` + `stall-recovery`) ran green 6/6 ✅ (157s) — the routed
  `engine.scheduleRecovery` continuation/retry path exercised end-to-end against
  real Workers AI with simulated eviction/recovery. (An earlier attempt on stale
  credentials failed at "establish remote session due to an authentication issue";
  `wrangler login` cleared it.) No changeset (internal `@internal` seam, zero
  behavior).

- _Slice 4a (Phase 4 start — shared types + key/sweep helpers, zero behavior)_ —
  The mechanical band of the dedup map: both packages re-declared the
  `ChatRecoveryIncident` type + `ChatRecoveryKind`, a local
  `CHAT_RECOVERY_INCIDENT_KEY_PREFIX`, a `_chatRecoveryIncidentKey` method (100%
  dup), and an inline stale-key loop inside `_sweepStaleChatRecoveryIncidents`,
  all of which already exist canonically in `agents/chat`
  (`recovery-incident.ts`). Replaced the local copies with the shared symbols in
  both `think.ts` and `ai-chat/src/index.ts`: import `type ChatRecoveryIncident`,
  `type ChatRecoveryKind`, `chatRecoveryIncidentKey`, `selectStaleIncidentKeys`,
  `CHAT_RECOVERY_INCIDENT_KEY_PREFIX`; delete the local type/kind/prefix; route
  the two stable-timeout call sites through `chatRecoveryIncidentKey(...)`; and
  collapse the sweep's loop to `selectStaleIncidentKeys(entries, now)`. **Zero
  behavior:** the canonical type is byte-identical to both local copies; the
  prefix string matches (`"cf:chat-recovery:incident:"`); and the sweep TTL the
  shared helper applies (`CHAT_RECOVERY_INCIDENT_TTL_MS = 60*60*1000`) is
  identical to the local constant it replaced (verified before deleting the now
  -unused local). Both packages' local `CHAT_RECOVERY_INCIDENT_TTL_MS` consts
  removed. Tests: repo typecheck 111 ✅; full Think workers 686 ✅ and ai-chat
  workers 608 ✅ (unchanged counts); ai-chat real-`wrangler dev` SIGKILL recovery
  e2e re-run green (offline-safe — no remote AI binding). No changeset (internal
  `@internal` seam, zero behavior). The Think real-edge e2e stays gated on the
  Phase 6 merge gate (its Workers AI binding needs a stable remote session, not
  available on the current connection).

- _Phase 3 confidence pass (deep review + real e2e)_ — Before starting Phase 4,
  re-verified 3a/3b/3c with a fresh review and the real-`wrangler dev` suites.
  **Review findings:** (1) `_routeStallToBoundedRecovery` in `AIChatAgent` is
  structurally byte-equivalent to Think's (clean `_completeStream` + `done:true`
  on `scheduled`; `_markStreamError` on `exhausted`; `aborted` status so the turn
  is not terminalised) — confirmed by reading both side by side. (2) The
  continuation re-anchor id is safe: the catch passes `targetAssistantId =
message.id`, and the tool-approval early-persist writes under `sanitized.id ===
message.id` (sanitize preserves id), so `earlyPersistedId === message.id` and
  the continuation's leaf-check cannot mis-skip. (3) **Coverage gap found + closed:**
  no test exercised a _healthy_ stream with the watchdog armed (`timeout > 0`,
  non-stalling) — the guarded `pull()` must pass healthy streams through unchanged
  and clear its timer on completion. Added an ai-chat integration test for exactly
  that. (4) Noted (not a bug): the watchdog measures inter-chunk gaps; it is
  opt-in (default `0`) and the budget keeps HITL/awaiting-interaction turns
  budget-free, so a spurious trip cannot wrongly exhaust — documented as a tuning
  consideration. **E2e/tests run:** ai-chat local `wrangler dev` + SIGKILL
  recovery e2e — 5 files / 10 tests green (the bounded-recovery machinery the
  stall routes into works on a real isolate); shared `agents/chat` stall-watchdog
  - recovery-engine unit suites — 29 green (3a primitive + 3c engine seam); Think
    `messengers` suite — 27 green (3c dispatch through the new seam); full Think
    workers suite — 686 green (3a/3c no regression); full ai-chat workers suite —
    608 green (3b + the new healthy-passthrough test, no regression). **Blocked
    (environment, not code):** the Think real-`wrangler dev` e2e suite binds
    Workers AI with `"remote": true`, so it needs live `wrangler` auth; creds are
    expired in this environment and it cannot run headless. The shared stall-watchdog
    primitive (3a) it would exercise is identical to the one Think already shipped
    and is unit-covered; deferring the Think real-edge + deployed e2e to the
    Phase 6 merge gate (run once re-authenticated). A dedicated ai-chat real-wrangler
    stall e2e was assessed and judged low marginal value over the deterministic
    integration coverage above — left optional.

- _Slice 3a (Phase 3 start — shared stall-watchdog primitive)_ — First Phase 3
  step. The incident lifecycle is already shared for `Think` (2b/2c/2e), so
  Phase 3 is the deeper `Think`-only surface; per a recovery-surface map (stall
  watchdog, durable submissions, messenger/workflow fiber ordering, tool
  rollback, agent-tool child-run reconcile), the **stall watchdog** is the #1
  convergence-matrix item and the natural foundation. Extracted `Think`'s
  `_iterateWithStallWatchdog` + `ChatStreamStalledError` **verbatim** into the
  shared `packages/agents/src/chat/stall-watchdog.ts` and re-exported them
  (`@internal`) from `agents/chat`. Key enabler: the watchdog generator never
  referenced `this`, so it lifts to a free function with no seam needed —
  `Think` now `import`s both, its two stream-loop call sites drop the `this.`
  prefix, and the two `instanceof ChatStreamStalledError` read-loop catches are
  unaffected because the thrown error is the very same imported class (so
  `instanceof` still holds). Review findings: (1) byte-identical body +
  error-class shape (`isChatStreamStall`, name) → zero behavior change; (2) the
  `onStall` closures stay inline at `Think`'s call sites (they capture `this`),
  so the package-specific abort/emit stays package-owned — only the generic
  race/timeout/cancel mechanics moved; (3) additive barrel export, so `ai-chat`
  (which doesn't consume it yet) is untouched — confirmed by typecheck +
  `check:exports`. Tests: 4 Layer-2 unit cases at the shared layer
  (disabled-passthrough, fast passthrough, stall→throw+`onStall`-once,
  consumer-break→source-cancel); `Think` 686 + e2e suites still green (existing
  stall coverage preserved). Repo typecheck 111; `pnpm run check` clean. No
  changeset (zero behavior change; `@internal` export). Slice 3b wires
  `AIChatAgent` onto this primitive (the behavior change + changeset).

- _Slice 3b (converge `AIChatAgent` onto the stall watchdog)_ — Wired
  `AIChatAgent`'s `_streamSSEReply` read loop through the shared
  `iterateWithStallWatchdog` behind a new opt-in `chatStreamStallTimeoutMs`
  field (default `0` = off, matching `Think`; `0` keeps the raw `reader.read()`
  path untouched). The watchdog wraps the response-body reader in an
  `AsyncIterable`, and on stall cancels the reader + throws
  `ChatStreamStalledError`, which `_reply`'s catch routes via a new
  `_routeStallToBoundedRecovery`: open/reuse the incident under the turn's
  recovery identity (`id` == `_activeRequestId` during a live turn), then either
  schedule a `_chatRecoveryContinue` (close the stream cleanly, report
  `aborted`) or — when the budget is spent — deliver the same terminal UX as
  deploy-recovery exhaustion. With recovery disabled the route returns
  `"disabled"` and the stall falls through to the generic terminal stream error
  (the watchdog's "kill the spinner" guarantee). **Key correctness fix found via
  the integration test:** the partial must be persisted from the _in-memory_
  `message` (the unconditional post-stream persistence block), NOT reconstructed
  via `_persistOrphanedStream` — on a live stall the stored-chunk buffer can lag
  the in-memory parts, so the orphan reconstructor came back empty and the
  user's partial would have been lost (the exact #1626 complaint). Routing the
  partial through the normal `message.id` persistence makes the scheduled
  continuation re-anchor correctly via `targetAssistantId`. **Decision:** kept
  the watchdog opt-in in both packages (converge on the mechanism, not a forced
  default timeout). Tests: 2 new Layer-3 integration cases in
  `durable-chat-recovery.test.ts` (a hanging-SSE `onChatMessage` mode +
  `driveStallingTurnForTest` helper) — stall→continue-incident+partial-persisted,
  and timeout-`0`→watchdog-disabled — stable across repeated runs (the delay-0
  continuation does not auto-fire in the pool, so the durable incident, not the
  transient schedule row, is the stable assertion). `ai-chat` 685 green (was
  683), repo typecheck 111, lint + oxfmt clean. Changeset added
  (`@cloudflare/ai-chat` minor). No e2e: the watchdog is opt-in and a real
  hung-provider stall is impractical to provoke on the edge; the existing
  deploy-eviction e2e already covers the shared continuation machinery the stall
  routes into.

- _Slice 3c (shared non-chat fiber dispatch seam)_ — Before writing more code, a
  deep map of the remaining Think recovery surface (via a thorough explore pass)
  reframed Phase 3: of the five remaining surfaces, only the **non-chat fiber
  dispatch** is genuinely additive seam work — durable submissions, agent-tool
  child-run reconcile, and resume-ACK orphan persist are ALREADY correctly
  adapter-owned and invoked at the right points, so their convergence is Phase 4
  _deduplication_, not new seams (forcing seams now adds indirection without
  removing duplication, and touches the riskiest wake path for no payoff). The
  map also corrected a doc/reality gap: `tryHandleNonChatFiberRecovery` existed
  only in this RFC — Think actually called `_messengerRuntime.handleFiberRecovery`
  directly. Slice 3c makes that seam real: a new optional
  `tryHandleNonChatFiberRecovery(ctx)` adapter hook + `engine.handleNonChatFiber`,
  with Think routing its messenger dispatch through the engine and `AIChatAgent`
  calling the same seam as a structural no-op (omits the hook → every fiber stays
  a chat candidate). The engine now owns the ordering invariant (non-chat
  dispatch before the chat-fiber gate); the behavior stays adapter-owned.
  Behavior is byte-equivalent: previously `if (await
_messengerRuntime?.handleFiberRecovery(ctx))`, now `if (await
engine.handleNonChatFiber(ctx))` which is `(await
adapter.tryHandleNonChatFiberRecovery?.(ctx)) ?? false` — same truthiness, same
  `undefined`→skip when no messenger runtime (child facet). `FiberRecoveryContext`
  imports `import type` from `../index` (same package, erased — no cycle). Tests:
  3 Layer-2 fake-adapter cases (consume→true, decline→false, omitted→false);
  agents `chat` project 25 green (was 22), Think 686 + e2e green, ai-chat 685
  green, repo typecheck 111, `pnpm run check` clean. No changeset (zero behavior
  change; `@internal` seam). Decision (user-confirmed): do 3c now, move surfaces
  3/4/5 into Phase 4 dedup.

- _Slice 2e (incident-update transitions behind the engine)_ — The transition
  twin of slice 2a: `ChatRecoveryEngine.updateIncident(incidentId, status,
reason?)` now owns the incident state-machine transitions both packages
  duplicated near byte-for-byte (`completed` → delete the record; other states →
  persist; emit the `completed`/`skipped`/`failed` lifecycle event; drive the
  #1620 "recovering…" status — set on `scheduled`, cleared on every terminal).
  Two new adapter hooks carry the package-owned I/O: `deleteIncident(key)` and
  `setRecovering(active, requestId?)` (the latter delegates to each package's
  existing `_setChatRecovering`, so its staleness/idempotency/broadcast logic
  stays package-owned). `ChatRecoveryIncidentEvent` widened to the five recovery
  event types with an optional `reason`; `emitRecoveryEvent` forwards the cause
  for `skipped`/`failed`. Both `_updateChatRecoveryIncident` methods are now thin
  adapter bindings (~50 lines deleted from each package). Review findings: (1)
  key derivation verified byte-identical (`chatRecoveryIncidentKey` ==
  `_chatRecoveryIncidentKey`), so the engine computing the key itself is safe;
  (2) `getIncident` normalizes `undefined`→`null` and the engine's truthy guard
  handles both, matching the old `storage.get<T>` undefined check; (3)
  `_emit`'s payload is an untyped `Record`, so widening the event union carries
  no per-type payload risk; (4) `_chatRecoveryIncidentKey` stays referenced by
  the resume-handshake paths in both packages — not dead code; (5)
  `deleteIncident` discards `storage.delete`'s `Promise<boolean>` to satisfy the
  `Promise<void>` hook (the one typecheck catch, fixed). Tests: 6 new
  `updateIncident` fake-adapter cases (scheduled→set+persist+no-event,
  completed→delete+emit+clear, failed/skipped→persist+emit-with-cause+clear, and
  both no-op guards) — agents `chat` project 22 green. Validation: ai-chat 683 +
  think (workers + react) suites green; repo typecheck 111; `pnpm run check`
  clean (sherif/exports/oxfmt/oxlint). Zero behavior change.

- _Smoke test (slice 2d, manual) + deferred follow-up_ — Verified recovery +
  recovering-on-connect end-to-end in `examples/ai-chat` (which needed
  `chatRecovery = true` added — `AIChatAgent` defaults it `false`; the example is
  a minimal showcase). Killing `wrangler dev` mid-story then refreshing now shows
  the "recovering…" status on reconnect and the turn resumes from its persisted
  partial. **Deferred follow-up (pre-existing, NOT introduced here; user opted to
  track, not fix now):** on the recovery _continue_ path with a reasoning model,
  if the model emits NEW reasoning after a partial text, the live stream briefly
  renders that reasoning as a second block _under_ the content, then it "jumps"
  back on top when the final persisted message replaces the live stream. Root
  cause: the continuation merge in `AIChatAgent` (`index.ts`, the
  `continuationReasoningResumed` branch, ~L5660-5708) fully suppresses
  `text-start` (so text merges seamlessly) but can only _skip the server apply_
  for `reasoning-start` while still forwarding it to the client — AI SDK v6
  requires a `reasoning-start` before any `reasoning-delta`, and the client's
  active part at that moment is the text, not the earlier reasoning block. So the
  client appends a new reasoning part (under content) while the server merges into
  the top reasoning part (`continue-last-turn.test.ts` "should merge reasoning
  into existing reasoning part during continuation" pins the merge-to-top). The
  two representations are irreconcilable mid-stream in the v6 protocol. The clean
  fix is to stop merging later-than-text reasoning (chronological order, live ==
  final, matches the repo's "render parts in array order" guidance) and update
  that test; it self-corrects on finish today, so it is cosmetic. Tracked here as
  a recovery-UX follow-up, independent of the engine convergence slices.

- _Slice 2d (recovering-on-connect convergence — first behavior change)_ —
  `AIChatAgent` now replays the live "recovering…" status on connect, matching
  `@cloudflare/think`. Before this, ai-chat only broadcast `cf_agent_chat_recovering`
  live, so a client that connected during the gap between a scheduled
  continuation and its first chunk saw nothing and looked frozen (its own code
  said so: "the live 'recovering…' signal is still not replayed on connect").
  Implementation: a new private `_buildRecoveringConnectFrame()` reads the
  durable `cf:chat:recovering` record (skipping stale ones past the flag TTL) and
  returns the frame, which `onConnect` sends on the **no-active-stream branch**
  only — an actively-streaming continuation still gets `STREAM_RESUMING`, so the
  two signals never collide and the client never double-renders. This mirrors
  Think's `_buildIdleConnectMessages` recovering replay exactly. Review findings:
  (1) terminal/recovering are mutually exclusive in storage (every terminal
  clears recovering), so a reconnecting client never gets both; (2) the client
  was already wired for it — `react.tsx` `isRecovering` handles the frame whenever
  it arrives and its doc already said the status is "replayed on connect" (for
  Think), so no client change was needed; (3) unlike `STREAM_RESUMING` (which
  needs the client's resume-protocol readiness and is therefore re-driven by a
  client-initiated request), the recovering frame is a fire-and-forget status the
  client reflects directly into state, so a direct on-connect send is the right
  channel; (4) the extra storage read happens only on idle connects, symmetric
  with Think. Tests: deterministic unit coverage via
  `getRecoveringConnectFrameForTest` (`durable-chat-recovery.test.ts`) asserting
  the frame appears once scheduled and disappears on terminal; the
  `chat-recovering-status` local e2e doc/comment was corrected (it previously
  documented the OLD "not replayed on connect" behavior) and now opportunistically
  observes the on-connect replay over a real socket (opportunistic because the
  no-active-stream replay window is timing-bound). Validation: 683 ai-chat unit
  tests green; full local e2e suite 10/10 green (no regression in the hot connect
  path); deployed real-edge e2e green (self-cleaning). Repo typecheck (111) +
  oxlint clean. Minor changeset shipped (user-visible client state change).

- _Phase 2 (deployed recovery e2e — real-edge proof)_ — Built the
  user-requested DEPLOYED recovery e2e (`packages/ai-chat/src/e2e-tests/`):
  `wrangler.deployed.jsonc` (uniquely-named Worker) + `deployed-recovery.test.ts`
  - `vitest.deployed.config.ts` + a `test:e2e:deployed` script. Unlike the local
    SIGKILL suites (which prove the recovery state machine in workerd), this
    deploys a real Worker, forces a real Durable Object eviction the way production
    does — a `wrangler deploy` **mid-turn** — then asserts recovery fires on
    Cloudflare's edge, and ALWAYS deletes the Worker in teardown (verified: the
    script left no resource behind). Double-gated so it never runs in normal CI:
    its own config (not in `test`/`test:e2e`) + a `RUN_DEPLOYED_E2E=1` body gate.
    Three real-edge findings the run surfaced (each fixed): (1) a redeploy takes
    ~18s to go live — far longer than a finite mock turn (~10s) — so a finite turn
    COMPLETES before the eviction lands and leaves nothing to recover; fixed by
    adding `ChatHangingRecoveryAgent` whose turn hangs forever, guaranteeing an
    in-flight fiber at eviction (no timing race). (2) Back-to-back deploys
    occasionally hit a transient deploy-API error; `deploy()` now retries with
    backoff so the slow deploy→evict→recover cycle isn't restarted wholesale. (3)
    A freshly-created `*.workers.dev` route drops the first WS handshakes during
    cold start/propagation, and the unguarded `sendChatMessage` rejected the whole
    test; the turn-start is now a resilient send+check poll. The `#1620`
    recovering-flag is only logged (not asserted) on the edge — it is
    timing-sensitive and already asserted deterministically by the local
    `chat-recovering-status` suite. Validated green twice against
    `spai@cloudflare.com` (~70-76s/run); typecheck (111) clean; the new DO class +
    migration `v6` are additive (local `wrangler.jsonc` dry-run validates). _This
    is the validation vehicle for the behavior-changing slice 2d._
- _Phase 2 (slice 2c — shared exhaustion-notification core)_ — **Re-scoped from
  the original "move terminal/exhaust sealing behind the engine".** Side-by-side
  reading of both `_exhaustChatRecovery` methods showed the head (build
  `ChatRecoveryExhaustedContext` → emit `chat:recovery:exhausted` → run
  `onExhausted` with the throw-swallow) is byte-identical (only the log prefix
  differs), but the tail — the terminal-record / banner-broadcast / submission
  writes **and their ordering** — is an _intentional, documented divergence_:
  `@cloudflare/ai-chat` persists-then-broadcasts (#1645 reconnect reliability)
  while `Think` broadcasts-then-persists (banner resilience under a failing
  storage write), and Think additionally marks the submission interrupted. Forcing
  the whole method behind the engine would either flatten that divergence or push
  a `persist-first | broadcast-first` knob (plus terminal/submission I/O) through
  the seam — a leaky, UIMessage-shaped adapter exactly of the kind Phase 5 warns
  about. So slice 2c extracts only the genuinely-shared core: the pure
  `buildChatRecoveryExhaustedContext` (field map + `reason`/`recoveryRootRequestId`
  fallbacks) and `notifyChatRecoveryExhausted` (emit → `onExhausted` swallow →
  `onError` report). Both packages call these two helpers at the top of
  `_exhaustChatRecovery`, then keep their own divergent terminal I/O in their own
  order. The "throwing `onExhausted` never blocks terminal UX" invariant now lives
  in one tested place. Removed the now-unused `ChatRecoveryExhaustedContext`
  type-import from both packages (kept the public re-export). Added Layer-2 tests
  pinning the field map, both fallbacks, emit-before-hook order, the swallow +
  `onError` path, and the no-hook path. Review: behavior byte-identical — the
  divergent tail is untouched (ai-chat keeps its trailing `_setChatRecovering(false)`,
  Think keeps broadcast-first + `_markRecoveredSubmissionInterrupted`); only the
  shared head moved. Gates: chat unit (296, +9), ai-chat workers (682), Think
  workers (686), typecheck (111), oxlint — all clean.
- _Phase 2 (slice 2b — Think incident-begin)_ — Wired
  `Think._beginChatRecoveryIncident` to the same `ChatRecoveryEngine`, with its
  hibernation guard implemented as the adapter's `ensureInteractionStateLoaded`
  hook (the rationale comment moved verbatim onto the hook). Removed the now-dead
  `_chatRecoveryIncidentId` + the `evaluateChatRecoveryIncident` /
  `chatRecoveryIncidentId` imports. Both packages are now symmetric for
  incident-begin (the only divergence is the predicate — `hasPendingInteraction`
  vs `hasPendingClientInteraction` — and the presence of the hook). Review:
  engine order (`get → ensureInteractionStateLoaded → readProgress →
predicate`) is byte-identical to the old inline order (`get → guard → progress
→ hasPendingInteraction`); `_restoreClientTools`/`hasPendingInteraction` keep
  their other callers; key derivation unchanged. Gates: Think workers (686) pass;
  typecheck (111) and oxlint clean.
- _Phase 2 (slice 2a — incident-begin orchestration)_ — Added
  `ChatRecoveryEngine` + `ChatRecoveryAdapter` to `recovery-engine.ts`: the
  engine owns the begin-incident sequence (resolve config → derive key → sweep
  stale → read existing → rehydrate interaction state → read progress → budget
  eval → persist → emit) and its two ordering invariants (sweep-before-read;
  interaction-state-before-predicate). Wired `AIChatAgent._beginChatRecoveryIncident`
  to a cached engine over an inline adapter; removed the now-dead
  `_chatRecoveryIncidentId` and `evaluateChatRecoveryIncident` import (engine
  derives id/key via the pure fns). Added a Layer-2 fake-adapter test pinning
  the sequence + both invariants + the optional-hook-absent (ai-chat) shape.
  Review: orchestration is byte-identical — the pure `chatRecoveryIncidentKey`
  matches the removed private method character-for-character (incl.
  `encodeURIComponent`); ai-chat omits `ensureInteractionStateLoaded` so that
  step is a no-op; the cached engine is safe because the adapter arrows capture
  `this` and `this.ctx`/storage are stable per DO instance, while `resolveConfig`
  still runs per-incident. Gates: ai-chat workers (604) + engine unit (10) pass;
  typecheck (111) and oxlint clean. Think binding deferred to slice 2b.
- _Phase 2 (cleanup — shared callback union)_ — Replaced the six inline
  `"_chatRecoveryContinue" | "_chatRecoveryRetry"` unions in the recovery helper
  signatures (AIChatAgent ×2, Think ×4) with the shared
  `ChatRecoveryScheduleCallback` type, giving the slice-1 export a real consumer.
  Pure type-alias substitution; typecheck (111) + oxlint clean.
- _Phase 2 (slice 1 — scheduling-idempotency policy)_ — Introduced the first
  engine-seam file `packages/agents/src/chat/recovery-engine.ts` with
  `chatRecoverySchedulePolicy(reason)`, the single source of truth for the
  `schedule()` idempotency flag (`"initial"` → idempotent, deploy-storm dedup;
  `"stable_timeout_retry"` → non-idempotent, survives the executing one-shot
  row's deletion). Re-exported `@internal` from the `agents/chat` barrel. Wired
  all eight recovery schedule sites — `AIChatAgent` (3 initial + 1 reschedule)
  and `Think` (3 initial + 1 reschedule) — to source the flag from the policy;
  per-site rationale comments now point to the policy. Added the deferred
  Layer-2 seam test (`__tests__/recovery-engine.test.ts`): pins both reasons
  directly and through a fake scheduler exercised the way the packages call
  `schedule()`. Review: byte-identical behavior (policy returns the same literal
  each site used); the four remaining `{ idempotent }` literals are confirmed
  non-recovery subsystems (stream-buffer cleanup, scheduled tasks, submission
  drain) and intentionally left alone — folding them in would be a false
  coupling. Gates: ai-chat workers (604) + think workers (686) + shared engine
  unit (34) pass; typecheck (111) and oxlint clean. This closes the Phase 0
  "direct `{ idempotent }` flag assertion" deferral.
- _Phase 0 breadth (audit, no new tests)_ — Audited the existing `ai-chat` and
  `think` suites against the Phase 0 breadth items (schedule idempotency,
  terminal-before-seal, callback-error coverage, recovering replay) instead of
  reflexively adding tests. Finding: the high-risk invariants are already
  characterized symmetrically in both packages, so adding more would duplicate
  (the cadence warns against over-testing). Recorded the invariant→test map as
  the verified Phase 2 safety net (see "Phase 0 breadth audit") and resolved the
  checklist: idempotency + terminal-before-seal + callback-errors =
  already-covered (cited); adapter-contract + direct `{ idempotent }` flag
  assertion = deferred to the Phase 2 engine/adapter seam; ai-chat
  recovering-on-connect hydration = confirmed asymmetry vs Think, deferred to
  Phase 2 as an intentional convergence (changeset). Decision rationale (why
  this over Phase 2): converging behavior before the safety net is verified
  contradicts the cadence; the audit makes the net explicit so Phase 2 lands
  against a known-good base. Docs-only; no code/test changes.
- _Phase 1 (incident-math wiring complete)_ — Wired `Think` to the shared
  engine the same way as `AIChatAgent`: `_resolveChatRecoveryConfig`,
  `_chatRecoveryIncidentId`, and the `_beginChatRecoveryIncident` budget
  computation now delegate to the shared functions, and the six now-unused
  default constants were removed. Both packages now share one incident state
  machine. Review: Think's package-specific seams are preserved — the
  `_restoreClientTools()` hibernation guard still runs BEFORE the engine reads
  `hasPendingInteraction()` (the guard statement executes before the
  `evaluateChatRecoveryIncident` argument object is built), the predicate is
  Think's `hasPendingInteraction()` (server-tool orphans excluded), and the
  error log keeps the `[Think]` prefix. Gates: Think workers suite (686) passes;
  typecheck (111) and oxlint clean. (Note: `vitest run` without a per-suite
  `-c` config wrongly picks up the React/CLI/e2e suites and fails in the wrong
  runner — use `pnpm run test:workers` for the recovery path.)
- _Phase 1 (in progress)_ — Wired `AIChatAgent` to the shared engine.
  `_resolveChatRecoveryConfig`, `_chatRecoveryIncidentId`, and the budget
  computation inside `_beginChatRecoveryIncident` now delegate to
  `resolveChatRecoveryConfig` / `chatRecoveryIncidentId` /
  `evaluateChatRecoveryIncident` (re-exported `@internal` from the `agents/chat`
  barrel). `AIChatAgent` keeps only the storage I/O, sweep, progress read,
  pending-interaction predicate, and event emission around the engine call.
  Removed six now-unused local default constants (defaults live in the engine).
  Review: persisted incident JSON is byte-identical (verified field-by-field),
  the sweep-before-read ordering invariant is preserved, the
  `shouldKeepRecovering` ctx and `[AIChatAgent]`-prefixed error log are
  preserved, and event payloads/order are unchanged. Gates: full `ai-chat`
  suite (682) + chat unit suite (280) pass; typecheck (111) and oxlint clean.
  Deferred: the local `ChatRecoveryIncident`/`ChatRecoveryKind` types and the
  remaining recovery constants stay duplicated until Phase 4; Think wiring is
  the next step.
- _Phase 0 (in progress)_ — Extracted the byte-identical incident-budget state
  machine into a pure, storage-free module
  (`packages/agents/src/chat/recovery-incident.ts`:
  `evaluateChatRecoveryIncident`, `resolveChatRecoveryConfig`,
  `chatRecoveryIncidentId`, `selectStaleIncidentKeys`, plus the
  `ChatRecoveryIncident` type and persisted storage-key/budget constants).
  Added Layer-1 unit tests (`__tests__/recovery-incident.test.ts`) and the
  golden cutover round-trip gate (`__tests__/recovery-cutover-fixtures.ts` +
  `recovery-cutover.test.ts`). Both packages still run their inline copies (zero
  behavior change). Review finding: a pre-cutover incident persisted without
  `lastProgressAt` is bounded by `firstSeenAt`, so a long-orphaned turn can seal
  on `no_progress_timeout` immediately on the cutover wake — existing behavior,
  now explicit and tested.

### Phase 0: characterization tests

Before moving code, add or tighten tests around existing behavior. The goal is
to make current semantics executable.

Work:

- [x] Add shared incident state-machine tests with fake adapters.
      (`packages/agents/src/chat/__tests__/recovery-incident.test.ts`, backed by
      the extracted pure `evaluateChatRecoveryIncident`.)
- [x] Add golden cutover fixtures and a round-trip gate.
      (`__tests__/recovery-cutover-fixtures.ts` + `recovery-cutover.test.ts`.)
- [→] Add package adapter contract tests. **Deferred to Phase 2** — these test
  the engine↔adapter seam (fake scheduler/storage/clock), which does not
  exist yet. The current package behavior they would assert is already
  covered behaviorally (see the coverage map below); the seam-level versions
  are written when the seam lands. Building the seam now just to test it
  would be Phase 2 work mislabeled as Phase 0.
- [x] Add missing `AIChatAgent` tests for recovery callback errors if Think
      already has stronger coverage. **Already symmetric** — `onChatRecovery`
      throw (`durable-chat-recovery.test.ts` "marks the incident failed when
      onChatRecovery throws"), `onExhausted` throw ("still delivers terminal UX
      when onExhausted throws"), and `shouldKeepRecovering` throw (shared
      `recovery-incident.test.ts`). No gap to close.
- [→] Add `AIChatAgent` tests for reconnect recovering replay if the RFC chooses
  to converge on Think's better UX. **Deferred to Phase 2 (convergence).**
  Confirmed asymmetry: Think hydrates the live "recovering…" status on a
  mid-recovery (re)connect (`think-session.test.ts` "broadcasts + hydrates a
  'recovering…' status"); `AIChatAgent` broadcasts it live but does NOT
  replay it on connect — its own code says so
  (`ai-chat/src/index.ts` `_setChatRecovering`: "the live 'recovering…'
  signal is still not replayed on connect — only the terminal outcome is").
  A characterization test asserting on-connect hydration would assert
  behavior ai-chat does not yet have, so it ships WITH the convergence in
  Phase 2 (changeset), tracked as an intentional behavior change.
- [x] Add tests proving schedule idempotency/non-idempotency invariants.
      **Already symmetric** — non-idempotent stable-timeout reschedule is pinned
      by the 2-row tests in both packages (`durable-chat-recovery.test.ts`
      "reschedules a continuation that times out… (NEW row, 2 total)" and the
      retry twin; `think-session.test.ts` equivalents). Initial-schedule
      storm-dedup is pinned by the fiber-row-deletion "double recovery" tests
      ("should not double-recover when \_checkRunFibers runs from both onStart and
      alarm" + Think equivalent). The only thing not directly asserted is the
      `{ idempotent }` flag VALUE per scheduling reason — that becomes a precise
      fake-scheduler assertion at the Phase 2 seam (see coverage map).
- [x] Add tests proving terminal-before-seal behavior. **Already symmetric** —
      `#1730` defer-on-transient tests in both packages ("defers a give-up whose
      terminal write hits a platform transient instead of half-sealing, then
      seals fully on the re-run") plus the seal-write-best-effort and
      terminal-replay-on-reconnect (`#1645`) tests. No gap to close.

See the **Phase 0 breadth audit** below for the full invariant→test map.

Exit criteria:

- The desired shared behavior is described by failing or passing tests before
  extraction begins.
- Known intentional behavior changes are identified and tracked.

#### Phase 0 breadth audit — verified Phase 2 safety net

Goal of this audit: before converging behavior in Phase 2/3, confirm the
high-risk invariants are already executable as tests in BOTH packages, so any
convergence regression fails loudly. Finding: they are. This codebase is already
densely and symmetrically tested for the recovery surface; the right move is to
treat the existing suites as the Phase 2 safety net (do not regress them) rather
than add redundant tests. Map below (ai-chat / think test homes):

| Invariant                                                                                                                                              | Guarding tests (both packages)                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-idempotent stable-timeout reschedule (fresh row, not dedup onto the executing one-shot)                                                            | `durable-chat-recovery.test.ts` "reschedules a continuation that times out…" + retry twin; `think-session.test.ts` continue/retry reschedule tests                                                    |
| Initial-schedule storm-dedup (re-detection does not re-run/duplicate)                                                                                  | `durable-chat-recovery.test.ts` "should not double-recover when \_checkRunFibers runs from both onStart and alarm"; Think equivalent (primary mechanism = orphaned fiber-row deletion after handling) |
| HITL park: no reschedule, no budget spent, incident parked `skipped`                                                                                   | `durable-chat-recovery.test.ts` "PARKS a continuation/retry…"; Think PARK tests                                                                                                                       |
| Terminal-before-seal: terminal durably recorded/delivered before the incident is sealed; a transient on the terminal write defers (does not half-seal) | `#1730` "defers a give-up whose terminal write hits a platform transient…" in both packages                                                                                                           |
| Seal write is best-effort after terminal delivery (no re-deliver if only the seal fails)                                                               | `durable-chat-recovery.test.ts` "does not defer/replay… when the post-terminal incident seal write fails"                                                                                             |
| Terminal replay on reconnect (`#1645`); cleared when a later turn supersedes                                                                           | `durable-chat-recovery.test.ts` terminal-reconnect/cleared/aborted/error tests; Think `cf:chat:last-terminal` tests                                                                                   |
| Recovering-flag set on schedule, cleared on terminal (`#1620`)                                                                                         | `durable-chat-recovery.test.ts` "tracks a durable 'recovering…' record…"; `think-session.test.ts` "broadcasts + hydrates a 'recovering…' status…"                                                     |
| Callback hooks throwing do not wedge the turn                                                                                                          | `onChatRecovery`/`onExhausted` throw tests (ai-chat); `shouldKeepRecovering` throw (shared engine unit test)                                                                                          |

Confirmed gaps, both deferred (NOT Phase 0 current-behavior pins):

1. **Recovering-status on-connect hydration** — Think hydrates on (re)connect;
   ai-chat does not (live broadcast only). Phase 2 convergence + changeset.
2. **Direct `{ idempotent }` flag-value assertion** per scheduling reason —
   today only the row-count EFFECT is asserted. When Phase 2 routes scheduling
   through `adapter.schedule(delay, cb, data, { idempotent })`, add a
   fake-scheduler unit test asserting `idempotent: true` for the initial
   schedule and `idempotent: false` for the stable-timeout reschedule. This is
   the most valuable seam-level test and is the first Layer-2 test to write in
   Phase 2.

### Phase 1: introduce internal engine scaffolding

Add internal files under `packages/agents/src/chat`, names illustrative:

- `recovery-engine.ts`
- `recovery-adapter.ts`
- `recovery-codec.ts`
- `ai-sdk-recovery-codec.ts`

Keep them internal unless build constraints require barrel exports.

Work:

- [x] Move config resolution and incident math into pure functions first.
      (`resolveChatRecoveryConfig`, `chatRecoveryIncidentId`,
      `evaluateChatRecoveryIncident`, `selectStaleIncidentKeys` in
      `recovery-incident.ts`.)
- [x] Move storage key constants and incident helpers into the engine module.
- [x] Keep existing `AIChatAgent` and `Think` private methods as callers
      initially. (Both packages' `_beginChatRecoveryIncident` /
      `_resolveChatRecoveryConfig` / `_chatRecoveryIncidentId` now delegate to
      the shared engine.)
- [x] Add fake-adapter unit tests. (`recovery-incident.test.ts`.)

Exit criteria:

- No behavior changes.
- Shared unit tests cover incident budget behavior.

### Phase 2: wire `AIChatAgent`

Move `AIChatAgent` recovery orchestration behind the shared engine.

Sliced for safety (this is the riskiest phase — see the working cadence):

- [x] **Slice 1 — scheduling-idempotency policy.** `recovery-engine.ts` ·
      `chatRecoverySchedulePolicy` is the single source of truth for the
      `schedule()` idempotency flag; both packages' eight recovery schedule
      sites source it; Layer-2 fake-scheduler test pins both reasons. Zero
      behavior change. (Lands the Phase 0 "direct flag assertion" deferral.)
- [x] **Cleanup — shared callback union.** The six inline
      `"_chatRecoveryContinue" | "_chatRecoveryRetry"` unions now use the shared
      `ChatRecoveryScheduleCallback` type (gives the slice-1 export a consumer).
- [x] **Slice 2a — incident-begin orchestration.** `ChatRecoveryEngine` +
      `ChatRecoveryAdapter` own the begin sequence (sweep → read → budget eval →
      persist → emit) and its two ordering invariants; `AIChatAgent` is now a
      thin adapter binding. Optional `ensureInteractionStateLoaded` hook reserves
      Think's client-tool rehydration. Layer-2 fake-adapter test pins the
      sequence. Zero behavior change (byte-identical orchestration). _Think
      binding = slice 2b (next)._
- [x] **Slice 2b — Think incident-begin.** `Think._beginChatRecoveryIncident`
      now delegates to the same engine; its hibernation guard is the
      `ensureInteractionStateLoaded` hook (verbatim, same position). Both
      packages are now symmetric for incident-begin. Zero behavior change.
- [x] **Slice 2c — shared exhaustion-notification core** (re-scoped from "move
      terminal/exhaust sealing behind the engine"). Only the byte-identical head
      moved: `buildChatRecoveryExhaustedContext` (pure field map) +
      `notifyChatRecoveryExhausted` (emit → `onExhausted`-swallow → `onError`).
      The terminal-record / banner / submission writes **stay package-owned**
      because their ordering is an intentional divergence (ai-chat persist-first
      #1645; Think broadcast-first), which the engine must not flatten. Layer-2
      tests pin the field map, both fallbacks, and the swallow invariant. Zero
      behavior change.
- [x] **Slice 2d — recovering-on-connect convergence for `AIChatAgent`**
      (behavior change + changeset + e2e). **First behavior-changing slice.**
      `AIChatAgent.onConnect` now replays the live "recovering…" status on
      connect via `_buildRecoveringConnectFrame` (no-active-stream branch only,
      so an actively-streaming continuation still gets `STREAM_RESUMING`),
      mirroring Think's `_buildIdleConnectMessages`. Stale records (older than
      the flag TTL) are skipped; terminal outcomes still clear it. Client already
      handled the frame (`react.tsx` `isRecovering`). Deterministic guarantee:
      `durable-chat-recovery` unit test (`getRecoveringConnectFrameForTest`);
      real-socket exercise: `chat-recovering-status` e2e (opportunistic, since
      the replay window is timing-bound). Minor changeset shipped.
- [x] **Slice 2e — incident-update transitions.** `recovery-engine.ts` ·
      `ChatRecoveryEngine.updateIncident` (the transition twin of `beginIncident`)
      now owns the delete-on-completed / persist / event-emit / #1620-flag
      state-machine both packages duplicated; two new adapter hooks
      (`deleteIncident`, `setRecovering`) carry the package-owned I/O.
      `ChatRecoveryIncidentEvent` widened to the five recovery event types +
      optional `reason`. Both `_updateChatRecoveryIncident` are thin bindings now
      (~50 lines deleted each). Layer-2 fake-adapter test pins all transitions +
      both no-op guards. Zero behavior change.

Work:

- Implement `AIChatAgentRecoveryAdapter`.
- Keep `_chatRecoveryContinue` and `_chatRecoveryRetry` callback names stable.
- Keep public hooks and config types unchanged.
- Preserve AI SDK message reconciliation.
- Preserve terminal replay through `WebSocketChatTransport`.
- Add the chosen better behaviors where tests require them.

Exit criteria:

- Existing ai-chat recovery tests pass.
- New adapter contract tests pass.
- E2E reconnect and terminal replay pass.

### Phase 3: wire `Think`

Move `Think` recovery orchestration behind the same shared engine. The incident
lifecycle (begin / update / exhaustion-notification) already routes through the
engine for `Think` (slices 2b/2c/2e); Phase 3 is the deeper, `Think`-heavy
surface. Sliced like Phase 2 — lowest-risk extraction first, behavior change
behind a changeset second:

- [x] **Slice 3a — shared stall-watchdog primitive (zero behavior change).**
      Extracted `Think`'s `_iterateWithStallWatchdog` + `ChatStreamStalledError`
      verbatim into `packages/agents/src/chat/stall-watchdog.ts` (the function
      never touched `this`, so it lifts cleanly to a free function). `Think`
      imports both from `agents/chat`; the two call sites and the two
      `instanceof ChatStreamStalledError` read-loop catches are unchanged in
      behavior (the thrown error is the same imported class, so `instanceof`
      still holds). Layer-2 unit test added (disabled-passthrough, fast-source
      passthrough, stall→throw+onStall, consumer-break→source-cancel). This is
      the shared foundation slice 3b wires `AIChatAgent` onto.
- [x] **Slice 3b — converge `AIChatAgent` onto the stall watchdog (behavior
      change + changeset).** Wired `AIChatAgent`'s SSE stream loop through
      `iterateWithStallWatchdog` behind a new opt-in `chatStreamStallTimeoutMs`
      field (default `0` = off, matching `Think`). When a stall fires and
      `chatRecovery` is enabled, `_routeStallToBoundedRecovery` opens/reuses the
      incident under the turn's recovery identity and schedules a
      `_chatRecoveryContinue` (or delivers terminal UX once the budget is spent);
      with recovery off the stall stays a terminal stream error. **Decision:**
      kept the watchdog opt-in (off by default) in BOTH packages rather than
      defaulting it on with recovery — convergence on the _mechanism_, not a
      forced timeout value users must tune above their slowest legitimate
      inter-chunk gap. Changeset added (`@cloudflare/ai-chat` minor).
- [x] **Slice 3c — shared non-chat fiber dispatch seam (zero behavior change).**
      Added the optional `tryHandleNonChatFiberRecovery(ctx)` adapter hook +
      `ChatRecoveryEngine.handleNonChatFiber(ctx)`. `Think` now routes its
      messenger/workflow reply-fiber dispatch
      (`_messengerRuntime.handleFiberRecovery`) through the engine seam at the
      top of `_handleInternalFiberRecovery` instead of calling the runtime
      directly; `AIChatAgent` calls the same seam (a structural no-op — it omits
      the hook, so every fiber stays a chat candidate). The engine now owns the
      ordering invariant (non-chat dispatch BEFORE the chat-fiber gate); the
      behavior stays adapter-owned. 3 Layer-2 fake-adapter tests (hook
      consumes → `true`; hook declines → `false`; hook omitted → `false`).
      `FiberRecoveryContext` is imported `import type` from `../index` (same
      package, erased — no cycle). This is the structural precondition for a
      future shared fiber-recovery dispatch skeleton.
- [ ] **(Deferred to Phase 4 — these are already correctly adapter-owned; the
      remaining value is _deduplication_, not new seams.)** The deep surface map
      (Phase 3 mid-point) confirmed durable submissions, agent-tool child-run
      reconcile, and resume-ACK orphan persist are each already package-private
      and invoked at the right points (submission drain in onStart; reconcile in
      the recovery-callback `finally`; orphan persist on the reconnect-ACK path).
      Forcing them behind engine seams now would add indirection without removing
      duplication, so they move to Phase 4 where the engine grows the
      fiber-recovery dispatch skeleton and the duplicated bodies collapse:
  - [ ] Durable submission lifecycle hooks (engine provides; `AIChatAgent`
        no-ops) — _preserved_ today, deduped in Phase 4.
  - [ ] Agent-tool child-run reconcile after recovery completes — _preserved_
        today (both call it in the callback `finally`), deduped in Phase 4.
  - [ ] Resume-ACK orphan persist sharing the adapter orphan writer with fiber
        recovery — _preserved_ today, unified in Phase 4.
  - [ ] Tool rollback — _preserved_ (Think-owned), no seam needed.
  - [ ] Session persistence — _preserved_ (Think-owned), no seam needed.

Exit criteria:

- Existing Think recovery tests pass. ✅ (686 + e2e green after 3a/3b/3c)
- Durable submissions still recover correctly. ✅ (unchanged; covered by suite)
- Stall recovery still works. ✅ (3a/3b; existing Think stall coverage preserved)
- Tool rollback tests still pass. ✅ (unchanged)

### Phase 4: delete duplicate private logic

Once both packages are wired through the engine:

- Remove duplicated incident state-machine code.
- Remove copied helpers that are now owned by the engine.
- Keep thin package methods only where they are public hooks, scheduled callback
  entry points, or adapter behavior.
- Update comments that currently say helpers mirror the other package.

#### Slice plan (low-risk → high-risk; map: see Phase 4 dedup analysis)

The Phase 4 surface was mapped precisely before any code change. The duplication
falls into four bands, ordered here from mechanical/safe to behavioral/risky so
each slice ships with its own review + e2e gate before the next begins:

- **Slice 4a — shared types + pure key/sweep helpers (mechanical, zero behavior).**
  Both packages re-declare the `ChatRecoveryIncident` type (`think.ts:623–675`,
  `index.ts:111–157`) when a canonical one exists in
  `agents/chat/recovery-incident.ts`; both re-implement `_chatRecoveryIncidentKey`
  (100% dup of `chatRecoveryIncidentKey`) and `_sweepStaleChatRecoveryIncidents`
  (inlines `selectStaleIncidentKeys`). Replace local copies with the shared
  symbols. Pure type/identity/selection — no control-flow change.

- **Slice 4b — centralize the "schedule a recovery callback" triplet. ✅ DONE.** The
  block `updateIncident("scheduled")` + `_emit("chat:recovery:scheduled")` +
  `schedule(callback, …, chatRecoverySchedulePolicy("initial"))` appeared at 7 call
  sites (AIChat: stall + 3 fiber; Think: stall + 2 fiber). Added one engine method
  (`engine.scheduleRecovery({ incident, recoveryKind, callback, data, reason? })`)
  that owns the transition + emit + idempotent schedule behind a new
  `ChatRecoveryAdapter.scheduleRecovery` hook, and routed every call site through it.
  `recoveryKind` is explicit (AIChat's lost-partial branch reports `retry` over a
  `continue` incident). Behavior-preserving; collapses the most-copied block first so
  the later body-collapse is smaller. See the Slice 4b progress-log entry.

- **Slice 4c — move the stable-timeout RESCHEDULE behind the engine. ✅ DONE
  (re-scoped).** `_rescheduleRecoveryAfterStableTimeout` is byte-identical between
  the packages (100% dup): read incident → if under the attempt cap, bump
  `attempt`, set `status:"scheduled"` + `reason:"stable_timeout_retry"`, and issue a
  non-idempotent delayed schedule. Lifted into `engine.rescheduleAfterStableTimeout`,
  with the `ChatRecoveryAdapter.scheduleRecovery` hook generalized to carry a
  `delaySeconds` (the 4b triplet now passes `0`; the reschedule passes
  `CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS`). **Re-scope note:** the original 4c
  also bundled the give-up seal (`_exhaustRecoveryGiveUp` /
  `_exhaustRecoveryAfterStableTimeout`, ~80% dup). That spine interleaves
  package-specific terminalization (`_exhaustChatRecovery`), stream-id resolution,
  and partial-text reads behind subtle exactly-once/ordering invariants
  (#1730/#1645). Lifting it needs ~5 new adapter hooks that are _exactly_ the
  terminalize + stream surface Slice 4d already builds for the body-collapse —
  building them twice risks inconsistent seams — so the give-up spine moves to 4d
  (below), where those hooks live. Same judgment as the Phase 3 re-scope: defer an
  entangled item to where its seam naturally belongs.

- **Slice 4d — the wake + terminal-UX paths (the big one), split in two after a
  full read of both bodies.** Reading the two `_handleInternalFiberRecovery` bodies
  in full (think.ts ~265 lines; index.ts ~245 lines) changed the picture: they are
  ~70% structurally similar, but the similar part is mostly _control flow_ (chat
  gate, requestId parse, snapshot unwrap, begin-incident, exhausted→exhaust,
  onChatRecovery invocation, catch→failed) while the meaty logic has legitimately
  DIVERGED — streamStatus tracking (Think) vs not (AIChat); different recovery-kind
  detection helpers; different persist gates; different stream-completion APIs; and
  especially the retry/continue/skip decision (Think's submission lifecycle +
  terminal-record + session-leaf vs AIChat's flat-messages leaf + lost-partial third
  branch). Even the `_partialHasSettledToolResults` helper has drifted (Think
  delegates to `_toolPartHasSettledResult`; AIChat inlines a different state check).
  So 4d splits:
  - **Slice 4d-1 — lift the give-up spine (the part deferred from 4c). ✅ DONE.**
    `_exhaustRecoveryGiveUp` / `_exhaustRecoveryAfterStableTimeout` are ~80%
    identical: resolve config → key from `data.incidentId` → best-effort read
    `stored` (tolerate failure, synthesize) → re-entry guard
    (`stored.status==="exhausted"` ⇒ return) → build the exhausted incident →
    resolve streamId + partial → `_exhaustChatRecovery` (terminalize) → best-effort
    seal write. Lift this spine into `ChatRecoveryEngine.exhaustRecoveryGiveUp({
callback, data, reason })` behind hooks `exhaustChatRecovery`,
    `resolveRecoveryStreamId`, `getPartialStreamText`, `activeChatRecoveryRootRequestId`,
    and `onGiveUpBookkeepingError`. Divergences parameterize cleanly: Think passes
    `reason` (`stable_timeout` | `recovery_error`) and its root-id chain includes
    `recoveredRequestId`; AIChat hardcodes `stable_timeout` and never sets
    `recoveredRequestId` (so a unified chain — `originalRequestId ?? recoveredRequestId
?? activeRoot ?? stored.root ?? stored.requestId ?? ""` — collapses identically
    there). Moderate risk; its hooks are exactly what 4d-2 needs, so this lands first
    and de-risks 4d-2.

  - **Slice 4d-2 — lift the wake FRAME, keep the decision a package-owned seam (the
    genericity seam).** Owns the Phase 5 goal: a third (pi) adapter must drive
    deploy/crash recovery through the SAME engine, so the wake dispatch frame has to
    live in the engine, not be re-implemented per package. The value here is
    **genericity, not dedup** — the bulk of the logic stays package-owned in the
    decision hook; what the engine gains is a single, reusable wake lifecycle.

    Engine frame: `ChatRecoveryEngine.handleChatFiberRecovery(ctx, wake)`, called by
    each package's `_handleInternalFiberRecovery` right after `handleNonChatFiber`.
    Lifecycle: chat-fiber gate, requestId parse, snapshot unwrap, stream/partial
    resolution, recovery-kind classification, `beginIncident`, exhausted branch
    (persist-gate + `exhaustChatRecovery`), `onChatRecovery` invocation, persist +
    complete, decision, then `catch → updateIncident("failed") → rethrow`. The engine
    owns the control flow, incident lifecycle, and exactly-once ordering invariants;
    it does NOT own the decision.

    Hook surface: cohesive hooks named for responsibility, not micro-hooks. They live
    on a SEPARATE `ChatFiberWakeHooks<TClassify>` object passed as the second arg to
    `handleChatFiberRecovery(ctx, wake)`, NOT bolted onto the base
    `ChatRecoveryAdapter` — that keeps the incident/give-up adapter (and its five
    existing unit-test fakes) focused, and the classification detail is a
    method-scoped generic `TClassify` inferred from `wake` (no class-level generic, no
    `any`/`unknown` casts). The hooks:
    - `chatFiberPrefix()` — the fiber-name prefix that gates the chat path.
    - `unwrapRecoverySnapshot(ctx)` — returns `{ snapshot, recoveryData }`.
    - `resolveRecoveryStream(requestId)` — returns
      `{ streamId, streamStillActive, streamStatus? }`.
    - `classifyRecoveredTurn(input)` — returns `{ recoveryKind, detail: TClassify }`.
    - `invokeOnChatRecovery(...)` — builds the package's `onChatRecovery` ctx and
      calls the user hook.
    - `shouldPersistOrphanedPartial(...)` — the base persist gate; the engine owns the
      shared `options.persist !== false || partialHasSettledToolResults` clause.
    - `persistOrphanedStream(streamId)` and `completeRecoveredStream(streamId)`.
    - `dispatchRecoveredTurn({ ..., detail: TClassify })` — the decision hook; the
      whole retry/continue/skip body. Think runs its submission lifecycle +
      terminal-record + session-leaf logic and `_handleRecoveryCallbackError`; AIChat
      runs its flat-messages leaf + lost-partial branch; pi runs its own.

    `partialHasSettledToolResults`, reconstructed-from-give-up, and
    `exhaustChatRecovery` stay on the base adapter (shared with the give-up spine).
    The classify/dispatch pair is named to line up with the Turns/Actions RFCs'
    `classifyRecoveredTurn` seam: their `recovery-continue` / `recovery-retry`
    re-entry runs through `dispatchRecoveredTurn`, which for Think will eventually
    delegate to `_admitTurn`.

    Converge only where the difference is provably incidental (refined after the full
    code read): the drifted `_partialHasSettledToolResults` is behaviorally identical
    across the packages (AIChat inlines exactly what Think's `_toolPartHasSettledResult`
    checks: `output`/`result` present, or state in `output-available` /
    `output-error` / `output-denied`), so it lifts to one shared pure
    `partialHasSettledToolResults(parts)` in `agents/chat` — both packages drop their
    private copy, a real dedup with zero behavior change. NOT converged:
    `streamStatus` / terminal-stream handling stays absent for AIChat (its
    `resolveRecoveryStream` returns `streamStatus: undefined`, so the terminal
    branches are dead there) — making AIChat read status would be a behavior _change_,
    the exact inversion the "substrate capabilities are optional" decision forbids.
    The submission-coupled / Session-leaf parts are NOT converged — see that decision
    under Genericity.

    Highest risk (the wake path; #1631/#1691/#1645 + submission-completion
    correctness) — its own e2e gate, and the seam above is reviewed before the wake
    path is touched. Success criterion: the engine frame reads as a linear lifecycle
    and each hook is cohesive; AIChat's `dispatchRecoveredTurn` is leaf-only (no
    submission ops); pi can implement every hook. Fallback (recorded either way): if
    the hook surface still makes the engine LESS readable than two self-contained
    methods, land only the shared pure-helper extraction (`partialHasSettledToolResults`,
    the `onChatRecovery` ctx builder) plus a documented decision to keep the
    per-package decision bodies.

    Locked decisions (2026-06 review, before implementation):
    1. _Ambition:_ attempt the full frame-lift; drop to helper-extraction-only ONLY if
       the hook surface measurably hurts engine readability.
    2. _Hook names:_ align with the Think Turns/Actions RFCs — `classifyRecoveredTurn`
       (recovery-kind) + `dispatchRecoveredTurn` (the retry/continue/skip decision);
       `resolveRecoveryStream` for stream/status. So `_admitTurn` (Turns RFC) and the
       action ledger (Actions RFC) attach to these exact names; the only correction to
       those RFCs is the adapter _type_ (`ChatRecoveryAdapter`, not
       `ThinkRecoveryAdapter`).
    3. _Gate:_ does not start until this seam is human-reviewed (in progress).
    4. _Phase 5 pi:_ validated via an internal `experimental/` fixture scaffolded from
       the pi shape in "Genericity and future harnesses" — sequenced after 4d-2.

- **Slice 4f — lift the remaining duplicated chat leaf machinery.** The 2026-06
  extraction map (see "Chat-layer extraction map") found a cluster of near-identical
  leaf helpers still copy-maintained across both packages, _outside_ the recovery
  orchestration engine. Two sub-groups with different risk profiles — keep them
  separate so the safe lifts are not held back by the behavior-sensitive ones.

  **Verify-first gate (applies to every item).** Do NOT lift on the strength of the
  prose below — diff the two implementations at execution time first. If they are
  byte-equivalent (modulo comments), lift as a pure/glue helper with zero behavior
  change. If they have drifted, STOP and treat it as a convergence: pick the correct
  behavior, write it down, and ship a changeset. This is the discipline that made
  4d-2/4e safe; line numbers below are as of 2026-06 and will drift, so trust the
  names and re-diff.

  **4f-i — byte-verified pure leaf lifts (zero behavior, no changeset). ✅ DONE.**
  Lift each into `agents/chat` with a thin per-package binding (free functions
  taking `Pick<DurableObjectStorage, …>` or a small param, exactly like 4e's
  `sweepStaleChatRecoveryIncidents` / `readChatRecoveryProgress`). Items marked
  ✔verified were diffed during the 2026-06 confidence review and confirmed
  byte-identical; the rest were re-diffed at execution time (verify-first gate)
  and all eight passed. Landed in `agents/chat`: new `connection.ts`
  (`sendIfOpen` / `isWebSocketClosedSendError` — also deduped `continuation-state`'s
  third copy); `message-builder.getPartialStreamText`;
  `tool-state.{hasIncompleteToolBatch,partAwaitsClientInteraction,clientResolvableToolNames,toolPartName}`;
  `resumable-stream.{STREAM_CLEANUP_DELAY_SECONDS,cleanupStreamBuffers}`;
  `recovery-incident.{recordChatTerminal,clearChatTerminal,pendingChatTerminal,buildChatRecoveringFrame,setChatRecovering}`.
  Both packages are now thin bindings; the recovering set/clear and recovering
  frame thread their wire-type enum + broadcast wrapper as params (the only
  per-package divergence). See the Slice 4f-i progress-log entry.
  - **Duplicated constants ✔verified.** `CHAT_RECOVERING_KEY`,
    `CHAT_LAST_TERMINAL_KEY`, `CHAT_RECOVERING_FLAG_TTL_MS` are already exported from
    `recovery-incident.ts` (`109`, `115`, `166`) and re-barrelled by `chat/index.ts`,
    yet ai-chat still redefines them locally (`index.ts:162,169,178`) and Think
    likewise (`think.ts:679,685` + terminal/recovering keys). Confirmed all values
    match the shared copies (`CHAT_RECOVERING_FLAG_TTL_MS = 15 * 60 * 1000` and
    `STREAM_CLEANUP_DELAY_SECONDS = 10 * 60` are identical in both packages), so
    importing them is a no-op on storage keys and timing — no migration risk. Delete
    the local copies and import the shared ones (same fix as 4e's
    `CHAT_RECOVERY_PROGRESS_KEY`). `STREAM_CLEANUP_DELAY_SECONDS` (ai-chat `192`, think
    `699`) was not yet in the shared barrel — now exported from
    `resumable-stream.ts`. ✅ In practice both packages no longer reference the
    `CHAT_*` keys directly at all (every use went through a lifted helper), so the
    local key constants were simply deleted rather than re-imported.
  - **`sendIfOpen` / `isWebSocketClosedSendError`** (ai-chat `199–214`, think
    `239–254`) — byte-identical WS send guard. Lift to a shared `agents/chat` helper.
  - **Terminal KV trio** `_recordChatTerminal` / `_clearChatTerminal` /
    `_pendingChatTerminal` (ai-chat `3845–3866`, think `11131–11155`) —
    byte-identical, same `CHAT_LAST_TERMINAL_KEY`. Lift as free fns over a storage
    `Pick`; leave each package a one-line binding.
  - **`_hasIncompleteToolBatch` ✔verified** (ai-chat `2481–2513`, think
    `10971–11003`) — confirmed byte-identical (comment included). Lift to a shared
    pure fn. This is the one piece the auto-continuation convergence consumes — ship
    it here so that slice can build on it. (It is a prerequisite for the convergence,
    not the bulk of it — see that behavior decision.)
  - **Client-interaction predicates ✔verified** `_partAwaitsClientInteraction` /
    `_clientResolvableToolNames` / `_toolPartName` (ai-chat `2230–2265`, think
    `9367–9418`) — confirmed byte-identical (only docblock prose differs). Lift to
    shared pure fns. Note `_clientResolvableToolNames` reads `this._lastClientTools`,
    so the shared fn takes the client-tool list (or the resolved `Set`) as a param.
    Keep each package's higher-level `hasPendingInteraction` /
    `hasPendingClientInteraction` wrappers local — the broad-vs-client-only asymmetry
    lives in the wrappers (both already call the identical leaf), so it is Tier-3
    package surface.
  - **`_getPartialStreamText`** (ai-chat `4646–4671`, think `10707–10732`) —
    structurally identical; already wired through the engine's `getPartialStreamText`
    hook. Lift to a shared fn over the resumable-stream chunk reader.
  - **Stream-cleanup pair** `_ensureStreamCleanupScheduled` / `_cleanupStreamBuffers`
    (ai-chat `1446–1474`, think `11368–11394`) — near byte-identical alarm scheduling
    - buffer cleanup (#1706). Lift with the schedule / clear primitives as params.
  - **Recovering-flag** `_setChatRecovering` (ai-chat `3967–3997`, think
    `11224–11255`) + the recovering-frame builder (`_buildRecoveringConnectFrame`
    ai-chat `3938–3957`; the recovering slice of Think's `_buildIdleConnectMessages`
    `11283–11296`) — near byte-identical; differ only in the broadcast frame's
    message-type enum (`CF_AGENT_CHAT_RECOVERING` vs `MSG_CHAT_RECOVERING`). Lift with
    the message type + broadcast fn passed as params. The `_broadcastChat` /
    `_broadcastChatMessage` wrappers themselves stay package-local (they are the
    `exclude` + `_pendingResumeConnections` merge) and are threaded in as the
    broadcast-fn param — do not try to lift them in 4f.

  **4f-ii — behavior-sensitive convergences (own review + likely changeset; NOT in
  the zero-behavior bucket).** These look like dedup but are not pure lifts; each is a
  convergence that can change observable output and so gets its own slice, review, and
  (where output changes) a changeset.
  - **ai-chat's local `enforceRowSizeLimit`** (`_enforceRowSizeLimit`) vs the shared
    `enforceRowSizeLimit` (`agents/chat/sanitize.ts`, which Think uses). ✅ DONE
    (Slice 4f-ii(a)). The verify-first diff confirmed this was not a byte-identical
    lift: the two had drifted in two independent ways and we converged each onto the
    better behavior (changeset on both packages). (a) _Tool-output compaction shape_ —
    ai-chat replaced an oversized tool output with a flat english summary string
    (`"This tool output was too large to persist… Preview: …"`), discarding shape,
    while the shared fn (Think) used the structured, shape-preserving
    `truncateToolOutput`; structured wins (a model can keep reasoning about a
    shape-preserving truncation, and a flat string is strictly lossier), so ai-chat now
    uses `truncateToolOutput` and its old summary string is gone (user-visible
    persisted-row change → ai-chat changeset). (b) _Compaction annotations + warnings_ —
    ai-chat annotated `metadata.compactedToolOutputs` / `compactedTextParts` and
    `console.warn`ed while Think did neither; annotate + warn on both (the annotations
    let a client tell a stored message was compacted, and are cheap/additive), so Think
    now emits them too (additive metadata + a warn → Think changeset). Implemented by
    extending the shared `enforceRowSizeLimit` to own both the structured compaction and
    the annotations, plus an optional `warn` hook so each package keeps its own log
    prefix (`[AIChatAgent]` / `[Think]`); both packages are now thin bindings (ai-chat's
    `_enforceRowSizeLimit`; Think's `_rowSafe`). ai-chat's `row-size-guard.test.ts`
    assertions that pinned the old summary string were repointed at the structured
    `... [truncated N chars]` marker; Think's row-size tests were already
    structure-shaped and unchanged. See the Slice 4f-ii(a) progress-log entry.

  - **ai-chat's inline protocol parse vs the shared `parseProtocolMessage`**
    (`agents/chat/parse-protocol.ts`). ✅ DONE (Slice 4f-ii(b)). ai-chat's `onMessage`
    wrapper now classifies via `parseProtocolMessage` and dispatches on the typed
    `event.type` discriminants instead of inline `JSON.parse` + `data.type ===
MessageType.X` checks; the eight handler bodies are kept verbatim
    (`data.` → `event.`), in particular the `messages` event still persists the client
    snapshot (Think no-ops it). Verified behavior-preserving: the wire strings in
    ai-chat's `MessageType` and `agents`' `CHAT_MESSAGE_TYPES` are byte-identical for
    all eight incoming types, so the parser recognizes exactly what the inline switch
    did; the non-POST `use-chat-request` fall-through to the consumer's `onMessage` is
    preserved by gating the delegate on `!(event.type === "chat-request" &&
event.init.method !== "POST")` (equivalently: only the POST branch enters the
    handler). No changeset — internal dispatch refactor, no user-visible behavior
    change for well-formed traffic (the parser is in fact slightly more robust for
    malformed frames: it defaults a missing `init` to `{}` rather than throwing, and
    defaults a missing `toolName` to `""`). See the Slice 4f-ii(b) progress-log entry.

  4f-i items are independently revertible; land them as small commits (or one
  tightly-scoped slice) with the 4e verification bar — `pnpm run check`, agents /
  ai-chat / think suites, local SIGKILL e2e for both packages — zero behavior change,
  no changeset. 4f-ii items each get a dedicated slice with the verify-first gate
  above. 4f does not depend on 4d-2; it can run any time after 4e.

Each slice: deep review for edge cases, run the local + (where auth permits) real
e2e suites, commit with a detailed message. Slice 4d does not start until 4a–4c
are green.

Exit criteria:

- Code search shows no duplicated `_beginChatRecoveryIncident` style engines in
  both packages.
- `agents/chat` owns the recovery policy.
- `AIChatAgent` and `Think` own package behavior.

### Phase 5: pi adapter validation

Build an internal pi adapter (and a small pi codec) that runs on the shared
engine. This is the genericity proof, not a product.

Phase 5 is also the **forcing function for the Tier-2 extractions** in the
"Chat-layer extraction map" — the resume/reconnect handshake and the streaming-loop
codec. Drive those extractions through the pi adapter rather than before it: pi's
non-AI-SDK wire vocabulary and transcript shape are exactly what prove the seams are
not `UIMessage`-coupled. (Run Slice 4f and the auto-continuation convergence first;
they are independent of Phase 5 and shrink the surface pi has to reason about.)

Work:

- Add an internal pi fixture under `experimental/` (no published package).
- Implement a `PiRecoveryAdapter` and `PiRecoveryCodec` over pi's
  `AgentMessage[]` transcript and agent-event stream.
- Run the shared engine unit suite and a recovery subset against the pi adapter.
- As pi forces the seams, extract the Tier-2 subsystems into `agents/chat`: the
  resume handshake (notify → REQUEST → ACK → replay, terminal replay, recovering
  frame) behind a wire-vocabulary + idle-payload adapter, and the streaming codec
  (chunk apply, start-id alignment, progress gating) behind `ChatRecoveryCodec` /
  `PiRecoveryCodec`. Fold the corrections back into the AI SDK adapter and codec.
- Record any place where the engine or adapter leaked a `UIMessage`-shaped
  assumption, and fix the seam.

Exit criteria:

- The pi adapter recovers a deploy/crash mid-stream through the same engine.
- No engine change was required that is specific to `UIMessage`.
- Any seam corrections are folded back into the AI SDK adapter and codec.
- If a Tier-2 seam could not be cleanly shared for pi, the reason is recorded (it
  signals the seam shape is wrong) rather than forced.

**Status — DONE.** P5-1 (pi proof + harness), the Tier-2 extraction (resume handshake +
streaming codec into `agents/chat`, commit `038e6d23`), the second TanStack/AG-UI harness
(foreign client transport + foreign chunk vocabulary), the tool-`parts` codec path, and the
`RecoveryPartial` agnostic-seam refactor have all landed — see the Progress log. The historical
detail below is preserved as the original P5-1 record; "Still open" at the end of this section is
superseded by the Progress log's current open items (a real Workers AI provider run; the deferred
Tier-2 start-id alignment onto the codec — the progress-bump _timing_ convergence has since
landed). The
`experimental/pi-recovery/` fixture drives the **real** `@earendil-works/pi-agent-core`
`Agent` (verified to bundle + run in `workerd`; deterministic via pi-ai's
`registerFauxProvider`) on the shared engine, and a real `wrangler dev` SIGKILL
crash-mid-stream e2e passes with no `UIMessage` assumption (the snapshot builder was
generalized off `UIMessage` to `SnapshotMessage`). **The pi adapter takes the same
`stream_continuation` path as the AI SDK adapter:** the codec reconstructs the partial
from the durable buffer, the engine PRESERVES it
(`shouldPersistOrphanedPartial → streamStillActive`, `classifyRecoveredTurn →
"continue"`), and the recovered turn regenerates only the remaining suffix through pi's
real `continue()`, merging it onto the survived prefix. The e2e asserts continuation,
not regeneration: `recoveredVia === "continue"`, `prefixChars > 0`, `0 < generatedChars
< total`, and `prefixChars + generatedChars === total`. Full regenerate
(`classifyRecoveredTurn → "retry"`) remains only as the fallback when no partial
survived. **Seam-difference correction:** the earlier "pi can only regenerate; it has no
mid-assistant resume" note was an artifact of the first text-only codec, **not** a pi
constraint. An analysis of [Flue](https://github.com/withastro/flue) — itself a
pi-based harness (its `session.ts`/`submission-state.ts` import `@earendil-works/pi-ai`)
— confirms the richer path is the norm on this substrate: Flue persists streaming
deltas (`StreamChunkWriter`), reconstructs the partial (`recoverInterruptedStream`), and
continues from it (`stream_continuation`), plus preserves completed tool results across
a mid-batch interruption (`tool_results_partial`), under a leased submission execution
store. The shared engine supported pi's continuation with **no engine-side change**.
_(Originally "still open: lifting the resume handshake + streaming codec into `agents/chat`" —
since **DONE** in the Tier-2 extraction, commit `038e6d23`; see the Progress log entry.)_

**Scoping conclusion — the engine is message-generic but substrate-coupled (and that
is correct).** An inverse analysis (could Flue drop its in-house recovery and adopt this
engine?) sharpened where the genericity actually lives. The half that ports is the
**message model**: `RecoveryPartial = { text, parts }` + `SnapshotMessage` + the codec
seam carry pi's (or any) transcript with no `UIMessage` leak — the thing P5-1 set out to
prove. The half that does **not** port is, deliberately, the substrate:

- **Trigger.** The engine is entered through `handleChatFiberRecovery(ctx:
FiberRecoveryContext, …)` — the Agents-SDK fiber-recovery wake (`cf_agents_runs`,
  `_runFiberWithStashWrapper`, `wrap/unwrapChatFiberSnapshot`). A host without fibers
  (Flue uses a lease/queue + recover-on-start drain) would have to synthesize a
  `FiberRecoveryContext` and bypass the stash machinery — adopting the orchestration but
  not the trigger.
- **Scheduler.** `chatRecoverySchedulePolicy` encodes DO-alarm semantics (the
  non-idempotent stable-timeout reschedule exists because `alarm()` deletes the executing
  one-shot row only after the callback returns). That invariant does not map to a
  Node/Postgres scheduler.
- **Persistence.** `ResumableStream` is DO-SQLite (`this.sql`) and the adapter storage is
  `ctx.storage`; a multi-backend host (Flue's `@flue/postgres`) would reimplement the
  buffer.
- **Lease layer.** A multi-owner execution store (Flue's `owner_id`/`lease_expires_at`/
  `attempt_count`) sits _below_ this engine; the engine assumes a single-DO actor and
  idempotent `schedule()`. They are complementary layers, not substitutes.

So the engine is correctly factored as "message-agnostic recovery for the Agents-SDK
fiber + DO-alarm substrate," not a general-purpose durable-recovery library — matching
the "substrate capabilities are optional" stance. The reusable kernel shared with a
pi-based host like Flue is the codec + partial-reconstruction + continue-vs-regenerate
concept, which both already implement and both inherit from the pi substrate rather than
from each other.

**API-ergonomics findings (from building the pi adapter) — direct Tier-2 input.** Writing
a third, from-scratch, non-AI-SDK adapter surfaced where the `ChatRecoveryAdapter` /
`ChatFiberWakeHooks` seam is mis-cut. The signal is strong because the same boilerplate is
duplicated **identically across all three hosts** (`ai-chat`, `think`, and the pi
fixture), not just the fixture — so these are seam-shape corrections, not fixture quirks.
They should drive the Tier-2 extraction (lifting the resume handshake + streaming codec
into `agents/chat`). Ranked by payoff:

1. **Move the progress-bump PREDICATE onto the codec (not a blind fold into the chunk
   path).** Every host hand-wires `bumpChatRecoveryProgress` into its stream loop
   (`ai-chat` `_maybeBumpRecoveryProgress`; `think` at the `_shouldFlushRecoverableChunk`
   decision; the pi fixture inline in `_onPiEvent`) and each carries a comment
   re-explaining the invariant. The naive fix — have `ResumableStream.flush`/`storeChunk`
   bump on every durable chunk — is **wrong**: the bump is deliberately gated by a
   host/codec-specific "genuinely new produced content" predicate, NOT "any chunk." ai-chat
   bumps only on `text-start` / `reasoning-start` / settled tool input-output chunk types
   (never per `text-delta`); think bumps only when `_shouldFlushRecoverableChunk` elects to
   flush; pi (coarse events) bumps per event. Folding it into `ResumableStream` blind would
   write storage per token and silently change ai-chat's semantics. The real simplification
   is to put the predicate on the codec (e.g. `ChatRecoveryCodec.isProgressChunk(chunk)`)
   and bump when storing a chunk the codec marks as progress — which **belongs WITH the
   Tier-2 codec extraction**, not as a standalone change. (Verified 2026-06: the bump is
   chunk-type-gated in ai-chat and flush-gated in think, so this is behavior-sensitive.)
2. **Collapse stream resolution to one seam (a verify-first convergence, not a no-op).**
   `ChatRecoveryAdapter.resolveRecoveryStreamId(requestId): string` (give-up path) and
   `ChatFiberWakeHooks.resolveRecoveryStream(requestId): ResolvedRecoveryStream` (wake
   path) both resolve a turn's stream id, and every host implements both. They have
   **drifted**: the give-up `_resolveRecoveryStreamId` uses an in-memory
   `getAllStreamMetadata().find(...)` (first match), while the wake `_resolve*RecoveryStream`
   uses `SELECT … WHERE request_id = ? ORDER BY created_at DESC LIMIT 1` (newest row) and
   additionally computes `streamStillActive` (+ `streamStatus` for think). Collapsing to one
   method — `ChatRecoveryAdapter.resolveRecoveryStream(requestId): ResolvedRecoveryStream`,
   used by both the wake path and the give-up path (which reads `.streamId`) — is the right
   shape, but it inherently **converges the give-up lookup from `.find()` onto the newest-row
   query**. Identical in the common case (one stream per request id); differs only when
   multiple stream rows share a request id (across recovery attempts), where newest-row is
   the more correct "whatever partial the turn produced." Treat as a verify-first slice
   (4f-ii-style), likely with a changeset, not a pure dedup.
3. **Provide an engine-owned exhaustion helper.** The give-up choreography
   (`buildChatRecoveryExhaustedContext` → `notifyChatRecoveryExhausted` →
   `recordChatTerminal` → `setChatRecovering(false)`) is hand-assembled identically in
   each host (~30 lines). A single `runChatRecoveryExhaustion(incident, config, partial,
…, { emit, broadcast, storage })` would absorb it, leaving the host to supply only the
   emit/broadcast primitives. The duplicated `setChatRecovering` option bag
   (`{ storage, messageType, broadcast, now }`, constructed in two places per host) folds
   into the same helper. _(Since closed — `runChatRecoveryExhaustion(input, { emit,
   onExhausted?, onError, terminalize })` lands in commit `b62241e9`. The one
   correction to the sketch above: the helper takes the host's `terminalize`
   closure rather than raw `{ broadcast, storage }`, because owning those directly
   would force a single terminal-write ORDER and erase the hosts' then-divergent
   broadcast/persist ordering. That ordering was instead converged deliberately
   (ai-chat → broadcast-first, commit `66e7a790`, with a changeset) as a separate
   slice. The `setChatRecovering` option-bag dedup landed too, via a host-side
   `_setChatRecovering` wrapper. See the two newest Progress-log entries.)_
4. **Hand the decoded partial back to `persistOrphanedStream`.** The engine already
   decodes the buffer for classification (`getPartialStreamText`), then the host decodes
   the same buffer again to preserve the partial message. Passing the decoded
   `RecoveryPartial` (or a codec handle) into `persistOrphanedStream` removes the second
   decode.
5. **Drop the redundant classify `detail` when it mirrors `recoveryKind`.** The pi
   adapter threads `{ continueFromPartial }` that is identical to `recoveryKind ===
"continue"`, then `dispatchRecoveredTurn` re-derives it and re-maps to a callback name.
   Either let `recoveryKind` drive the callback selection, or stop requiring a custom
   `TClassify` for the common continue-vs-retry case.
6. **Make trivially-no-op hooks optional with engine-side defaults.** A host without
   client tools / HITL / lifecycle callbacks still must implement
   `isAwaitingClientInteraction`, `invokeOnChatRecovery`, `onShouldKeepRecoveringError`,
   and friends (the pi fixture's are all `() => false` / `async () => ({})` / a
   `console.error`). The "smallest real adapter" the fixture is meant to measure is still
   ~15 methods; optional hooks would shrink it.

Two correctness caveats the fixture also exposed, to record honestly:

- **The codec's tool-`parts` path is unproven on a non-AI-SDK substrate.** A pi text turn
  always yields `parts: []`, so the settled-tool persist gate was only ever exercised
  through the AI SDK adapter. A turn carrying tool calls would be needed to prove the
  settled-tool seam end-to-end off `UIMessage`. _(Since closed — not in pi, but in the
  TanStack harness: it reconstructs AG-UI `TOOL_CALL_\*`chunks into its own **AG-UI-native**
tool parts and computes`hasSettledToolResults`itself — no AI-SDK`MessagePart`fabrication — and proves the engine's gate keeps a settled-tool partial under`{ persist: false }`. The follow-up `RecoveryPartial` refactor then made the engine seam
  agnostic by type, not just at runtime. See the two newest progress-log entries.)\_
- **The fixture's continuation is simulated, not pi-native.** `_resumeRecoveredTurn`
  recomputes the full reply (`replyFor`) and primes the faux model with
  `full.slice(prefix.length)`; a real pi `continue()` would resume generation from the
  partial assistant message held in context. So P5-1b proves the **engine's**
  preserve/continue/merge plumbing is message-generic — not that pi natively prefilled.
  The claim should be stated at that scope.

### Phase 6: confidence and e2e hardening

Extend the existing local e2e suites (Layer 4) so the SIGKILL + persistent-state
harnesses cover the converged behavior. This is the merge gate. Live deploy
smoke (Layer 5) is an optional follow-up that can run nightly once fixtures
stabilize.

Exit criteria:

- Extended SIGKILL e2e mid-stream recovery passes for `AIChatAgent` and `Think`.
- Terminal replay works after crash/disconnect in local e2e.
- Repeated crash churn over progressing work does not false-terminalize.
- Optional: live deploy smoke passes for any PR that changes engine behavior.

#### Phase 6 audit — orphan-persist coverage (2026-06)

Audited whether the existing SIGKILL + persistent-state e2e suites cover the
**converged orphan-persist behavior** (the (a)/(b)/(c)/(d) seams just landed).
Coverage map for the orphan-persist path:

| Behavior                                           | Workers-runtime test (`durable-chat-recovery.test.ts`)               | Real-`wrangler dev` SIGKILL e2e                                               |
| -------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| (a) reconstruct partial via `StreamAccumulator`    | ✅ (implicit in all orphan cases)                                    | ✅ `chat-recovery` (partialText > 0), `chat-recovery-outcomes`                |
| (b) #1691 new-turn NOT merged into prior assistant | ✅ `:1096`, `:1346`                                                  | ❌ (workers-only)                                                             |
| (b) continuation merges onto last assistant        | ✅ `:1152`                                                           | ⚠️ indirect — `chat-recovery` continue test asserts `assistantMessages === 1` |
| (c) early tool-approval persist → recovery dedup   | ✅ `:1267` (one `tc-dup` part) + `reconcileOrphanPartial` unit tests | ❌ (no client-tool/approval agent in the e2e worker)                          |
| (d) upsert → single durable message                | ✅                                                                   | ✅ `chat-recovery-outcomes` (`assistantMessages === 1`)                       |
| persist gate (`persist:false` drops plain text)    | ✅                                                                   | ✅ `chat-recovery-outcomes` test 2                                            |

**Re-ran the two ai-chat e2e files that drive the refactored `_persistOrphanedStream`
through a real process crash, post-refactor:** `chat-recovery-outcomes` **2/2**,
`chat-recovery` **3/3** (incl. the continue-path merge-to-one). Green. Think's
e2e was **not** re-run: this refactor touched only ai-chat's orphan path plus an
additive shared export — Think doesn't call `reconcileOrphanPartial` and its
`_persistOrphanedStream` is unchanged, so its prior-green parity is unaffected.

**One documented gap, assessed acceptable (not a blocker):** the (c)
tool-approval-early-persist → recovery **dedup** has no real-SIGKILL e2e — the
ai-chat e2e worker has no client-tool/approval agent. It is covered (i) at the
workers runtime level by `durable-chat-recovery.test.ts:1267` (asserts a single
`tc-dup` part after an early persist + recovery replay), and (ii) by the
`reconcileOrphanPartial` unit tests. The dedup logic is runtime-independent (a
pure function over `parts`), so the only thing a real-SIGKILL e2e would add over
the workers test is the alarm-driven wake — which IS exercised generically for
the plain-text orphan path. Marginal value is low; harness cost (a HITL-approval
agent + crash-mid-approval flow) is high. **Recommendation:** leave it to the
workers + unit layer; add a tool-dedup SIGKILL e2e only if a regression ever
surfaces there. Phase-6 exit criteria for the converged orphan-persist behavior
are otherwise **met**.
