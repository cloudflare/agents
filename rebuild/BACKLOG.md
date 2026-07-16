# Migration completion backlog — claimable, parallel

Everything required for the rebuild to be **complete**: all functionality at
parity (or documented-divergence), every original test accounted for on the
ported board, and the package publish-ready as the new Think. Written for
**parallel execution by independent agents** — each task below is sized for
one agent (one wrapper + codex where noted), with explicit collision domains
so concurrent claims can't trample each other.

Sources of truth this doc INDEXES (never duplicates): `ISSUES.md` (issue
detail), `test-workers/ported/COVERAGE.md` (per-test triage + drop reasons —
the acceptance criteria live there), `docs/adr/` (design decisions),
`PROGRESS.md` (history), `audit/` (specs). `HANDOFF.md` §Suggested-next-moves
is superseded by this file.

## How to claim

1. Edit this file: flip the task's `[OPEN]` to `[CLAIMED <agent-id> <date>]`.
2. Commit that one-line edit FIRST (`claim: B-xxx <agent-id>`), push, then
   work in a **worktree pinned at that commit** (`git worktree add
   .claude/worktrees/<task-id> -b work/<task-id> HEAD`).
3. On completion flip to `[DONE <date> <commit>]` in your final merge commit.
   Abandoning a task: flip back to `[OPEN]` with a note.
4. Two tasks may run concurrently iff their **collision domains** (the `CD:`
   line) don't intersect. `test-workers/ported/*` shared files
   (wrangler.jsonc, fixtures/index.ts, compat.ts, worker.ts, env.d.ts) are
   ALWAYS additive-only; the merger resolves.
5. New issue numbers: check ISSUES.md's tail AND any open claims before
   numbering (047 is next-free as of this writing). When in doubt, describe
   the gap in your report and let the merger number it.

## Global rules (non-negotiable, learned this session)

- **Clean-room:** original TEST files are readable
  (`packages/think/src/tests/`, `packages/agents/src/tests/`,
  `agents/**/__tests__/`); original IMPLEMENTATION is never readable
  (`packages/think/src/**` non-test, `packages/agents/src/index.ts`,
  `packages/agents/src/chat/*`) — except tasks explicitly marked
  **[consumption]**, which vendor a named standalone module.
- **Verification economy:** gate on typecheck + your own files/suites only.
  Emit vitest `--reporter=json` artifacts to a fixed path; the merger reads
  artifacts, never re-runs. Full board runs are periodic checkpoints owned by
  the merger. Regression gate = `BOARD-SNAPSHOT.txt` diff (no PASSED line may
  flip away).
- **Integrity:** audit generated tests/fixtures for rigged passes (fabricated
  expected values, wrong-path delegation). Honest fails > fake greens —
  failing ported tests are acceptance suites for future tasks.
- **Wrapper ops:** codex/long suites as explicit background jobs; a wrapper
  parked >~10 min dies — keep a NOTES.md in the worktree so any resume is one
  turn; artifacts at fixed paths; commit as the last cheap step.
- **Behavioral changes:** fixing a divergence may update native tests that
  encoded it — justify each. Never weaken an unrelated assertion.

## Collision domains (CD)

`tools` = src/domain/tools · `turn` = src/domain/turn + domain/conversation ·
`msgs` = src/domain/messages · `session` = src/domain/session ·
`rel` = src/domain/reliability/* · `deleg` = src/domain/delegation ·
`runtime` = src/domain/runtime/* · `chan` = src/domain/channels ·
`app` = src/app/* · `cf` = src/adapters/cloudflare · `ws` =
src/adapters/websocket-chat · `mcp` = src/adapters/mcp · `kernel` =
src/kernel · `ports` = src/ports · `board` = test-workers/ported (own files
only) · `e2e` = rebuild/e2e · `docs` = docs/audit/README

---

# A. Real-bug fixes (small, high-confidence — do these first, any order)

### B-001 [OPEN] ISSUE-038: fiber recovery scan gaps
CD: runtime. Size S. Fix `checkInterrupted()`: don't fire `onFiberRecovered`
for terminally-settled ledgers; scan managed ledger rows lacking run rows.
Acceptance: 3 named run-fiber.test.ts fails flip; native fibers suite green.

### B-002 [OPEN] ISSUE-039: onStart failures brick the DO
CD: app+cf. Size M. Catch/degrade activation-path throws (documented degraded
mode; agent reachable, error surfaced, retry). Acceptance: onstart-degraded
0/5 → 5/5.

### B-003 [OPEN] ISSUE-042: __destroy durable teardown
CD: cf. Size M. Durable "condemned" marker + self-alarm re-drive so
mid-teardown cancellation converges on next wake (original #1625). Add native
tests from the deferred-destroy quarry checklist (COVERAGE row).
Acceptance: new native tests; deferred-destroy row's checklist items covered.

### B-004 [OPEN] ISSUE-045: state hooks trio
CD: runtime. Size S. onStateChanged throw → onError + still broadcast (the
persisted-but-unannounced bug); "State update rejected" text; both-hooks
guard. Acceptance: 3 state.test.ts fails flip.

### B-005 [OPEN] Sub-agent name validation (P10 finds)
CD: deleg. Size S. Reject `\0` in names; fix `Sub_` escaping the reserved-sub
kebab guard. Acceptance: 2 sub-agent.test.ts fails flip. Also confirm-or-fix
parentAgent() undefined-vs-throw divergence (maintainer sign-off; note in
COVERAGE row).

### B-006 [OPEN] ISSUE-041: schedule DSL singular counted forms
CD: runtime. Size S. Accept "every 1 minute"/"every 1 hour". Acceptance:
majority of scheduled-tasks.test.ts fails flip (~8-10 of 11 remaining).

### B-007 [OPEN] eventCounters pruning (P9 find)
CD: deleg. Size S. Prune in-memory map on settle in runs.ts. Native test.

# B. Feature parity — conversation/turn layer

### B-010 [OPEN] ISSUE-044: scheduler idempotent option + onStart warning
CD: runtime. Size S/M. Acceptance: 10 schedule.test.ts fails flip.

### B-011 [OPEN] ISSUE-046: StreamingResponse.error()
CD: runtime. Size S. Acceptance: 2 callable + 1 client-timeout fails flip.

### B-012 [OPEN] ISSUE-043: readonly-connection enforcement
CD: app+ws+ports. Size M. Wire shouldConnectionBeReadonly; rpc frames respect
readonly; connection.setState. Acceptance: 12 readonly-connections flips.

### B-013 [OPEN] Turn-loop small knobs (hooks-row family)
CD: turn. Size M. TurnConfig `output` + `experimental_transform`;
ModelCallSettings presence/frequency penalties + timeout; reasoning
start/end lifecycle chunks; actionLedgerPendingRetryLeaseMs config surface
already exists — expose per-test lease override. Acceptance: 6 hooks.test.ts
missing-feature fails flip.

### B-014 [OPEN] ChatOptions.metadata / activeTurnMetadata
CD: turn+app. Size S/M. Acceptance: 3 turn-metadata flips.

### B-015 [OPEN] runTurn continuation mode + chat:turn observability shape
CD: app. Size M. Acceptance: majority of run-turn.test.ts's 18 fails
(remainder are ISSUE-009 — note split in ledger row).

### B-016 [OPEN] Identity-frame vocabulary + identity-only opt-out
CD: ws. Size S/M. `cf_agent_identity` kebab `agent` slug (026 family);
`sendIdentityOnConnect:false` distinct from shouldSendProtocolMessages.
Acceptance: 4 basepath + 2 message-handling flips.

### B-017 [OPEN] Deliver-notice sub-behaviors
CD: chan. Size M. Markdown payload, informModel annotation, deliveryKind
metadata. Acceptance: 5 deliver-notice flips.

### B-018 [OPEN] Channel recovery re-stamp + threading divergences
CD: chan+rel. Size M. Recovery path re-resolves/re-stamps channel; threading
semantics per ported tests. Acceptance: 4 channel-recovery + 2
channel-threading flips.

### B-019 [OPEN] Attachment default renderer
CD: app. Size S. Built-in renderAttachment default. Acceptance: 3
attachment-consumption flips.

### B-020 [OPEN] Stream-cleanup / event-log retention decision
CD: app+runtime. Size M. DECISION FIRST (maintainer): adopt original's
alarm-driven cleanup or declare divergence + document retention model. Then
implement or re-triage the 11 stream-cleanup tests accordingly.

### B-021 [OPEN] think-session missing-feature worklist (split into 3 claims)
CD: turn+session+rel. The 33 named reasons in fixtures/think-session-agents.ts
group into: (a) saveMessages/addMessages surface variants [Size M]; (b)
submission seams + keep-recovering override [M]; (c) recovery-incident
bookkeeping variants + child-stream forwarding [M/L]. Claim as B-021a/b/c —
edit this line when claiming a sub-part. Acceptance: named think-session
fails flip per sub-part (~95 remaining total, not all from these).

### B-022 [OPEN] ISSUE-019: sanitization + row-size enforcement
CD: msgs+session. Size M. Tool-output depth truncation + persistence
sanitization parity. Acceptance: named think-session sanitization fails flip.

### B-023 [OPEN] Client-tools remaining divergences (split decision)
CD: turn+ws. Size L. auto-continue/debounce timing divergences,
regenerate/branching (missing feature — needs a design call), 11
suspended-stream done-timeout family (DECISION: adopt original close-stream
semantics or re-triage as documented divergence — affects hooks row too).
Acceptance: client-tools 34/86 → target ≥60; hooks +11 if close-semantics
adopted.

### B-024 [OPEN] Execute-hitl fixture rework onto durable-pause actions
CD: board only. Size M. Recovery-goal stretch 4 (target 10/10). Acceptance:
execute-hitl 0/10 → 10/10.

### B-025 [OPEN] actions-durable-pause root-cause investigation
CD: board (first), then rel. Size M. P11 flagged 2/18 as anomalously low vs
green e2e. Diagnose fixture-vs-real before any implementation. Deliverable:
corrected triage or a fix + flips.

### B-026 [OPEN] actions-attach-reply + protocol-messages residuals
CD: board+ws. Size M. 5 attach-reply fails + 13 protocol-messages
frame-vocabulary verdicts + 1 assistant-agent-loop residual — triage-to-fix
or documented-divergence each. Acceptance: rows updated with zero
"pending verdict" notes left.

# C. Delegation subsystem (sequence within this section; shared CD)

### B-030 [OPEN] ISSUE-035: reattach/no-progress budgets  ← START HERE
CD: deleg+app. Size L. Parity as swappable ReattachPolicy (decision + full
scope detail in ISSUES.md). Acceptance: 19 agent-tools + 5 agent-tool-replay
+ 3 rebind-noop + 1 max-concurrent flips; reattach-budget + task-amplification
e2e flip. Includes structured `output` on completed live runs (folded into
035's entry).

### B-031 [OPEN] ISSUE-036: facet spawner bridge (root-mediated)
CD: deleg+cf. Size L. host.spawner for facet-hosted agents, bridged through
the root DO (facets can't allocate facets). Acceptance: 13 sub-agent + 2
nested-agent-tools flips; parentAgent() works in facets.

### B-032 [OPEN] ISSUE-037: detached delivery ledger
CD: deleg. Size L. Two-slot claim+lease, give-up budgets, backbone cadence.
After B-030 (shares status vocabulary). Acceptance: 12 agent-tool-detached
flips.

### B-033 [OPEN] ISSUE-040: maxConcurrentAgentTools cap
CD: deleg. Size S/M. After B-030. Acceptance: 4 max-concurrent flips.

### B-034 [OPEN] ISSUE-024: public reconcile entry + run-id seeding seam
CD: deleg+app. Size S. Public Think entry for AgentToolRunService.reconcile();
caller-chosen (runId, requestId) binding seam (P9 fixture-gap). Acceptance:
P9 weak-passes become strong; 1 fixture-gap flips.

### B-035 [OPEN] ISSUE-017: sub-agent external routing
CD: cf. Size M/L. /sub/ URL addressability through the root, WS upgrade
pass-through. Acceptance: 6 sub-agent + 2 onconnect-broadcast flips.

# D. Consumption + integration (each independent; [consumption] = vendoring exemption)

### B-040 [OPEN] ISSUE-022: MCP server story [consumption-partial]
CD: mcp+cf. Size L. McpAgent-equivalent on the shell (re-implement, not
vendor — original extends old Agent). Unlocks the ~22 staged vendor-test
files + 6 elicitation subtests + 1 run-fiber + 1 message-handling frame.

### B-041 [OPEN] MCP tool source wiring into Think config surface
CD: app+mcp. Size S/M. M1 follow-up: `mcpServers` config → McpToolSource
instances → assembly mcpTools; `cf_agent_mcp_servers` frame. Acceptance:
adapter usable from a subclass without manual wiring; message-handling frame
test flips.

### B-042 [OPEN] ISSUE-005: shell workspace adapter [consumption]
CD: ports+new adapter dir. Size M. Acceptance: 7 assistant-tools bash flips.

### B-043 [OPEN] ISSUE-006: extensions seam + host bridge [consumption]
CD: app+cf+new dir. Size L. ExtensionManager + 9-method _host* bridge +
_insideInferenceLoop. Acceptance: extension-manager 34 unblocked+ported, ~19
hooks flips (15 host-bridge + 4 dispatch).

### B-044 [OPEN] ISSUE-009: observability bridge [consumption]
CD: kernel(bus)+new dir. Size M. EventBus → observability interface adapter.
Acceptance: named fails across run-turn/onstart/client-tools/sub-agent flip.

### B-045 [OPEN] ISSUE-016: AgentWorkflow base [re-implement]
CD: new workflows dir+deleg. Size L. Return path via getAgentByName/__call.
Acceptance: workflows 3 + workflow-sub-agent 11 unblocked; 4+3 submissions
workflow-notification/think_final_answer flips; workflow-recovery e2e.

### B-046 [OPEN] ISSUE-011: messengers [consumption]
CD: chan+new dir. Size L. Acceptance: messengers 30 unblocked; messenger
e2e.

### B-047 [OPEN] ISSUE-014: media eviction [re-implement]
CD: msgs+session. Size M. Acceptance: media-eviction 9 + hydration-budget 13
unblocked.

### B-048 [OPEN] ISSUE-004 codemode / ISSUE-008 browser / ISSUE-010 voice /
ISSUE-012 hono / ISSUE-023 email / ISSUE-025 webmcp [consumption, one claim each]
CD: separate new dirs. Size M each. Edit this block into separate lines when
claiming. Acceptance per ledger rows (execute-tool 6, browser-tools 6, etc.).

### B-049 [OPEN] ISSUE-013: framework/CLI story
CD: new dir+docs. Size L. DECISION FIRST (maintainer: is a CLI/scaffolding
story in scope for publish v1?). Unlocks framework 25 + host-embedding 11.

# E. Substrate + misc parity

### B-050 [OPEN] ISSUE-001 reasoning replay · ISSUE-002 implicit web channel ·
ISSUE-020 retry() · ISSUE-021 Serializable<State> (one claim each; split on claim)
CD: turn / chan / kernel / ports respectively. Size S/M each. 021 also ports
the three .test-d.ts type-level files.

### B-051 [OPEN] Submission running-row recovery tracking
CD: rel. Size M/L. messagesAppliedAt/messageIds + requeue/error-without-replay
paths (10 named submissions fails) + acceptance hook + stale window (2).
Acceptance: submissions 32/51 → ~44/51.

### B-052 [OPEN] Fiber caller-supplied fiberId dedupe
CD: runtime. Size S. Acceptance: 1 run-fiber flip.

# F. Port program remainder

### B-060 [OPEN] T2b: fiber/facet eviction e2e batch (26 tests, 6 files)
CD: e2e. Size L. fiber-eviction 15, concurrent-fibers 3, poison-row-aging 3,
scan-deadline-yield 3, facet-multipass-recovery 1, poison-row-backoff 1.

### B-061 [OPEN] T4 quarry: recovery-engine (65) → native additions
CD: rel+native tests. Size L. Read-only vs original tests; add missing
observable behaviors to our recovery suites in our idiom. Ledger the quarry
row with a per-behavior checklist outcome.

### B-062 [OPEN] T4 quarry: stream-accumulator (62) → native (CD: turn) ·
### B-063 [OPEN] T4 quarry: recovery-incident (48) → native (CD: rel) ·
### B-064 [OPEN] T4 quarry: message-reconciler (37) → native (CD: msgs)
Size M/L each, same method as B-061.

### B-065 [OPEN] ISSUE-007: react client compat smoke [consumption-test]
CD: new test project. Size M. Real `agents/react` useAgentChat against the
rebuild over a real socket — the external wire-compat proof; also
stream-resume.test.tsx (T0 third gate) + studio-chat.test.tsx.

### B-066 [OPEN] e2e red sweep
CD: e2e. Size M. Remaining e2e reds not owned by an issue above: re-triage
each to an owning backlog task or flip it (persist-false semantics,
submission-recovery variants). Deliverable: zero unowned red e2e files.

# G. Publish-readiness

### B-070 [OPEN] Compat-alias wave (audit 30 pile 2)
CD: app. Size M. getSchedule→getScheduleById alias, Session→createSession,
messages getter, runTurn dispatcher parity, type widenings. Half-day of
aliases erasing most visible API diff. Acceptance: audit 30's pile-2 list
checked off; aliases carry @deprecated-or-canonical decisions.

### B-071 [OPEN] DX cookbook: compose-your-own-agent
CD: docs. Size M. ADR-0002 follow-up: extension-contract doc, domain-factory
dep signatures, worked example (userland ChatAgent-equivalent), hosting
composition guide (generic host + hostAgent sugar).

### B-072 [OPEN] Demo verification + packaging pass
CD: docs+demo. Size M. demo:cf boot verified on a real account (blocked in
sandbox); package.json exports map, README, versioning/naming decision
(maintainer), CHANGELOG-vs-original (documented divergences from ledger).

### B-073 [OPEN] Divergence register
CD: docs. Size S/M. Collect every `divergence (documented)` from COVERAGE
rows into one publishable "differences from original Think" doc — several
are deliberate keeps (ledger replay-by-key, queue retry policy, error texts).
Maintainer reviews each keep/fix call.

---

## Suggested first parallel batch (no CD collisions)

B-001 (runtime) · B-002 (app+cf) · B-005 (deleg) · B-012 (ws) · B-013 (turn)
· B-022 (msgs+session) · B-042 (new dir) · B-044 (new dir) · B-061 (rel) —
nine agents, no overlaps. Then the C-section delegation sequence (B-030 →
031/032/033) as its own lane.

## Definition of done (the whole migration)

1. Every COVERAGE.md row non-pending with zero `claimed` leftovers; every
   `blocked ISSUE-NNN` row's issue resolved or explicitly deferred by the
   maintainer; quarry rows carry completed checklist outcomes.
2. Every ISSUES.md entry resolved or maintainer-deferred.
3. Board snapshot: no FAILED line without an owning backlog task or a
   documented divergence in the register (B-073).
4. Native + workers + e2e + ported suites green-or-triaged; final checkpoint
   snapshot committed.
5. B-070/071/072/073 done (publish-readiness).
