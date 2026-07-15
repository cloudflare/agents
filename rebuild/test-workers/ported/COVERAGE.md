# Ported test coverage ledger — the single comprehensive record

One row per ORIGINAL test file across the whole monorepo (audit 29 §4). The
port is complete when every row is non-`pending`. Original files are readable
from `rebuild/` at `../<path>` (paths below are monorepo-relative; each
section header states the base directory once).

**Status vocabulary**
- `pending` — not yet ported/assessed (open for claiming)
- `claimed <wave>` — a port wave is actively working it
- `ported n/m` — copied (verbatim or near-verbatim); n of m tests pass
- `rewritten n/m` — same scenarios re-authored against the rebuilt surface
- `native <file>` — rebuild's own suite already covers it (pointer required)
- `dropped` — deliberately not ported (reason required)
- `quarry` — INTERNAL suite kept as a spec checklist, never ported (audit 29 T4)
- `blocked ISSUE-NNN` — porting is pointless until that issue lands (most of
  these become near-verbatim ports WITH the issue, since the original module
  arrives with its own tests)

**Claiming protocol (parallel porting).** A wave claims files by flipping
their rows to `claimed <wave-id>` in its first commit, OR the orchestrator
marks rows at dispatch. During parallel waves the orchestrator is the only
writer of this file (porting agents report results; the orchestrator ledgers
them) — this avoids whole-file write races. Shared merge points besides this
file: `ported/wrangler.jsonc`, `ported/fixtures/index.ts`, `ported/compat.ts`,
`e2e/worker.ts`/`e2e/wrangler.jsonc` — waves must touch only their own test
files + per-wave fixture modules; the orchestrator merges the shared files.

**Failure triage vocabulary** (for `ported`/`rewritten` rows that fail):
`framing` (ISSUE-026 payload mismatch) · `missing-feature ISSUE-NNN` ·
`fixture-gap` · `divergence` (intentional behavior change — explain) · `flake`.

---

## packages/think/src/tests/ (main suite, workerd)

| File | ~Tests | Class | Status | Notes |
|---|--:|---|---|---|
| client-tools.test.ts | 86 | WIRE | ported 33/86 | 53 fail on REAL semantics: auto-continue/debounce divergences, ISSUE-009 observability shim, regenerate/branching missing-feature, residual done-timeouts. (ISSUE-029 flipped the approval-vocabulary tests.) |
| think-session.test.ts | 198 | WIRE+API | rewritten 57/198 (7 dropped-with-pointer) | R1 landed waitUntilStable (block 9/9) + recovery inspection accessors (chatRecoveryIncidents/chatRecoverySchedule): +3 flips (recovering-status hydration #1620, attempt-budget reset on progress, HITL no-seal). Remaining failures keep NAMED missing-feature reasons — next: recovery injection seams + onChatRecovery hook core (R2). |
| hooks.test.ts | 105 | WIRE+API | pending | split T1/T3 |
| submissions.test.ts | 51 | PUBLIC-API | pending | T3 |
| agent-tools.test.ts | 33 | PUBLIC-API | pending | T3 |
| assistant-agent-loop.test.ts | 23 | WIRE | ported 22/23 | Near-green; 1 residual to pin in the next triage pass. |
| extension-manager.test.ts | 34 | INTERNAL | blocked ISSUE-006 | ports with the extensions lift |
| run-turn.test.ts | 26 | PUBLIC-API | pending | T3 |
| fetch-tools.test.ts | 32 | INTERNAL | quarry | checklist vs domain/fetch suite |
| assistant-tools.test.ts | 30 | PUBLIC-API | pending | T3 |
| scheduled-tasks.test.ts | 14 | PUBLIC-API | pending | T3 |
| message-reconciliation.test.ts | 8 | WIRE | ported 8/8 | **GREEN** — ISSUE-015 resolved: reconcileIncoming (collapse optimistic duplicates, no-downgrade merge) + pre-turn orphan write-back (preserve + flip to output-error, inputs normalized; approval-requested exempt). Also fixed the P1 fixture to seed through the real session (raw-row seeding bypassed tree bookkeeping). |
| execute-hitl.test.ts | 10 | WIRE | ported 0/10 | `fixture-gap`: fixture authored on the approval-gate path (`approval-requested`); original uses ACTIONS durable-pause (paused output as normal `output-available` result + approveExecution). Rework fixture onto the rebuild's durable-pause actions. |
| hydration-budget.test.ts | 13 | PUBLIC-API | blocked ISSUE-014 | media-eviction dependent |
| actions-durable-pause.test.ts | 18 | PUBLIC-API | pending | T3 |
| host-embedding.test.ts | 11 | INTERNAL | blocked ISSUE-013 | framework/server-entry |
| onconnect-broadcast.test.ts | 9 | WIRE | ported 7/9 | ISSUE-018 resolved: connect-time suppression + proactive STREAM_RESUMING, ACK-gated replay (from first delta), #1645 terminal retention/replay all pass. The 2 remaining tests exercise `/sub/` sub-agent URLs — `blocked ISSUE-017` (they previously 'passed' by asserting against the wrong agent). |
| actions-attach-reply.test.ts | 12 | WIRE | ported 6/12 | 6 fail REAL semantics: attachment validation strictness `divergence` (rebuild accepts invalid/non-json-safe attachments the original filters/normalizes) + done-timeouts on specific flows. Candidate small actions fix. |
| assistant-agent.test.ts | 5 | WIRE | ported 5/5 | **T0 gate GREEN** (ISSUE-026 resolved) |
| channel-recovery.test.ts | 5 | PUBLIC-API | pending | T3 |
| stream-cleanup.test.ts | 11 | PUBLIC-API | pending | T3; event-log retention differs — expect divergence notes |
| media-eviction.test.ts | 9 | INTERNAL | blocked ISSUE-014 | port pure-fn tests with the impl |
| workflows.test.ts | 3 | INTERNAL | blocked ISSUE-016 | |
| action-pause-recovery.test.ts | 3 | PUBLIC-API | pending | T3 |
| onstart-degraded.test.ts | 5 | PUBLIC-API | pending | T3 |
| agent-tool-reattach-recovery.test.ts | 2 | WIRE | ported 2/2 | **PASSES** — facet spawner + delegation reattach hold against the original's assertions. |
| streaming-message-id.test.ts | 1 | WIRE | ported 1/1 | **T0 gate GREEN** (ISSUE-026 resolved) |
| run-turn-recovery.test.ts | 2 | PUBLIC-API | pending | T3 |
| turn-metadata.test.ts | 4 | PUBLIC-API | pending | T3 |
| execute-tool.test.ts | 6 | PUBLIC-API | blocked ISSUE-004 | codemode |
| channels.test.ts | 8 | INTERNAL | quarry | vs domain/channels suite |
| deliver-notice.test.ts | 7 | PUBLIC-API | pending | T3 |
| fiber.test.ts | 7 | PUBLIC-API | pending | T3 |
| max-concurrent-agent-tools.test.ts | 5 | PUBLIC-API | pending | T3 |
| agent-tool-rebind-noop.test.ts | 3 | PUBLIC-API | pending | T3 |
| nested-agent-tools.test.ts | 3 | PUBLIC-API | pending | T3 |
| attachment-consumption.test.ts | 4 | PUBLIC-API | pending | T3 |
| errored-stream-replay.test.ts | 1 | PUBLIC-API | pending | T3 |
| browser-tools.test.ts | 6 | INTERNAL | blocked ISSUE-008 | |
| channel-threading.test.ts | 4 | PUBLIC-API | pending | T3 |
| channel-policy.test.ts | 3 | PUBLIC-API | pending | T3 |
| messengers.test.ts | 30 | INTERNAL+API | blocked ISSUE-011 | |
| framework.test.ts | 25 | INTERNAL | blocked ISSUE-013 | |
| action-types.test-d.ts / chat-options.test-d.ts / tool-call-types.test-d.ts | type | type-level | blocked ISSUE-021 | |
| generated-entry/ (1 file) | 10 | INTERNAL | blocked ISSUE-013 | fixture project |

## packages/think/src/e2e-tests/ (kill/restart, node vitest + wrangler dev)

| File | Tests | Status | Notes |
|---|--:|---|---|
| chat-recovery.test.ts | 5 | ported 5/5 | **GREEN** — all five kill/restart scenarios recover (chat via persisted alarm, restart churn, post-persist failure surface, sub-agent recovery, agent-tool re-attach #1630). ISSUE-026 resolution unlocked the three chat-frame scenarios. |
| stall-recovery.test.ts | 1 | ported 1/1 | **GREEN** — stalled turn recovers via scheduled continuation (#1626) under a real kill. |
| context-overflow-recovery.test.ts | 3 | ported 0/3 | fast-fails ~4s pre-chat: `fixture-gap`/config mismatch between fixture's overflow options and the rebuild's ContextOverflowConfig — pin next. |
| submission-recovery.test.ts | 3 | ported 0/3 | long timeouts on submission transitions — likely `divergence` in submission surface/RPC names vs original; pin next. |
| action-pause-recovery.test.ts | 1 | ported 0/1 | fails ~8s: same durable-pause fixture mechanism question as execute-hitl (`fixture-gap`). |
| action-ledger-recovery.test.ts | 1 | ported 1/1 | **PASSES** — crash-left pending ledger lease reclaimed after real kill/restart. |
| tool-rollback.test.ts | 1 | ported 1/1 | **GREEN** — long tool loop recovers across repeated evictions without deep rollback. |
| persist-false-preserves.test.ts | 1 | ported 0/1 | 75s: recovery hook persist:false mapping — `divergence`/`fixture-gap`; pin with recovery-hook work. |
| reattach-budget.test.ts | 1 | ported 0/1 | `missing-feature`: re-attach budget semantics in delegation recovery (slow-but-healthy child sealed interrupted). NOTE: burns ~14 min of real eviction churn per run. |
| task-amplification.test.ts | 2 | ported 0/2 | `missing-feature`: stable child runId across parent eviction (no whole-turn re-runs, #1630 task path). ~10 min/test runtime. |
| messenger-recovery.test.ts | 2 | blocked ISSUE-011 | |
| workflow-recovery.test.ts | 2 | blocked ISSUE-016 | |
| assistant-e2e.test.ts | 4 | pending | real AI binding; out of CI like the original |
| step-prompt-structured.test.ts | 2 | blocked ISSUE-016 | real providers; out of CI |

## packages/think/src/{cli,react,vite}-tests/

| File | Tests | Status | Notes |
|---|--:|---|---|
| react-tests/stream-resume.test.tsx | 2 | pending | T0 third gate; needs a decision on depending on the original client package (ISSUE-007) |
| react-tests/studio-chat.test.tsx | 3 | pending | T1; same client-package dependency |
| cli-tests/cli.test.ts | 37 | blocked ISSUE-013 | build tooling |
| cli-tests/runtime-cli.test.ts | 18 | blocked ISSUE-013 | |
| vite-tests/vite.test.ts | 10 | blocked ISSUE-013 | |

## packages/agents/src/tests/ (full enumeration)

| File | ~Tests | Status | Notes |
|---|--:|---|---|
| agent-tool-detached.test.ts | 13 | pending | T3 (delegation) |
| agent-tool-replay.test.ts | 5 | pending | T3 |
| agent-tools-failure.test.ts | 5 | pending | T3 |
| alarms.test.ts | 3 | native test-workers/alarm.test.ts | verify overlap when convenient |
| basepath.test.ts | 21 | pending | T3 (routing prefix option) |
| browser-connector.test.ts | 34 | blocked ISSUE-008 | ports with the browser lift |
| browser-quick-actions.test.ts | 20 | blocked ISSUE-008 | |
| callable.test.ts | 21 | pending | T3 |
| chat-sdk.test.ts | 9 | blocked ISSUE-011 | messengers depend on chat-sdk Adapter |
| client-timeout.test.ts | 5 | pending | T3 |
| deferred-destroy.test.ts | 6 | pending | T3 (shell __destroy semantics) |
| email-headers.test.ts | 10 | blocked ISSUE-023 | |
| email-routing.test.ts | 46 | blocked ISSUE-023 | |
| keep-alive.test.ts | 14 | pending | T3 |
| message-handling.test.ts | 10 | pending | T3 |
| migration.test.ts | 8 | dropped | migrates the ORIGINAL's old storage schema — meaningless for the rebuild |
| msg-ordering.test.ts | 1 | pending | T3 |
| observability.test.ts | 46 | blocked ISSUE-009 | ports with the adapter |
| protocol-messages.test.ts | 18 | pending | ported 5/18 | 13 fail on original frame-vocabulary asserts — needs per-test verdicts: genuine missing frames vs deliberate `divergence` (some will become dropped rows). |
| queue.test.ts | 3 | pending | T3 |
| r2-skills.test.ts | 9 | blocked ISSUE-004 | R2+codemode skills; also quarry vs domain/skills |
| readonly-connections.test.ts | 45 | pending | T3 |
| resumable-stream-migration.test.ts | 1 | dropped | old-architecture migration |
| retries.test.ts | 48 | blocked ISSUE-020 | |
| retry-integration.test.ts | 18 | blocked ISSUE-020 | |
| routing.test.ts | 24 | pending | ported 24/24 | **GREEN — full original suite passes** (after fixing unknown-binding 400 vs 404 divergence found here). |
| run-fiber.test.ts | 54 | pending | T3 |
| schedule.test.ts | 52 | pending | T3 |
| schema-and-state-optimization.test.ts | 31 | quarry | original SQL-schema internals |
| skill-runner.test.ts | 31 | blocked ISSUE-004 | |
| skills.test.ts | 13 | blocked ISSUE-004 | quarry vs domain/skills meanwhile |
| spike-sub-agent-routing.test.ts | 16 | blocked ISSUE-017 | |
| state.test.ts | 22 | pending | T3 |
| sub-agent-routing.test.ts | 22 | blocked ISSUE-017 | |
| sub-agent.test.ts | 97 | pending | T3 (delegation surface — big) |
| workflow-error-reporting.test.ts | 7 | blocked ISSUE-016 | |
| workflow-integration.test.ts | 7 | blocked ISSUE-016 | |
| workflow-prototype.test.ts | 14 | blocked ISSUE-016 | |
| workflow-sub-agent.test.ts | 11 | blocked ISSUE-016 | |
| workflow.test.ts | 47 | blocked ISSUE-016 | |
| mcp/ (29 files: client-manager 165, worker-transport 66, client-connection 34, client-elicitation 33, transports/rpc 33, oauth2-mcp-client 29, transports/streamable-http 27, auto-transport 22, handler 16, errors 14, event-store 14, wait-connections-e2e 13, add-rpc-mcp-server 13, mcp-protocol 13, normalize-server-id 12, do-oauth-client-provider 11, elicitation 10, transports/auto 10, add-mcp-server 9, http-dedup 8, transports/sse 8, jurisdiction 7, transports/post-keepalive 7, resumability 6, create-oauth-provider 4, outside-context-send 3, session-lifecycle.integration 3, connection-uri 2, codemode-context 1) | ~600 | blocked ISSUE-003/022 | the client-stack tests arrive nearly-verbatim WITH the vendored client (003); handler/elicitation server halves ride 022 |
| experimental/memory/session/{session 80, postgres-providers 50, provider 42, skills 30, init-lifecycle 18, search 10} | 230 | quarry | session stays native (audit 28); spec source if ever swapped |
| experimental/memory/utils/compaction.test.ts | 8 | quarry | vs session/compaction suite |

## packages/agents/src/chat/__tests__/ (internal to the replaced architecture)

All quarry (audit 29 T4) — mapped to the rebuild module / issue whose suite
should absorb any missing behaviors:

| File | Tests | Maps to |
|---|--:|---|
| recovery-engine.test.ts | 65 | domain/reliability/recovery (primary checklist) |
| stream-accumulator.test.ts | 62 | domain/conversation/chunks (primary checklist) |
| recovery-incident.test.ts | 52 | domain/reliability/recovery |
| message-reconciler.test.ts | 37 | ISSUE-015 (port WITH the impl) |
| tool-state.test.ts | 27 | domain/messages tool parts / actions |
| agent-tools.test.ts | 24 | domain/delegation |
| broadcast-state.test.ts | 23 | adapters/websocket-chat (state fan-out) |
| abort-registry.test.ts | 22 | domain/turn admission/cancel |
| resume-handshake.test.ts | 19 | adapters/websocket-chat resume (+ISSUE-018) |
| turn-queue.test.ts | 17 | domain/turn/admission |
| continuation-state.test.ts | 17 | domain/conversation/continuation |
| auto-continuation-controller.test.ts | 17 | domain/conversation continuation barrier |
| recovery-codec.test.ts | 17 | domain/reliability/recovery persistence |
| parse-protocol.test.ts | 15 | adapters/websocket-chat frame parsing (+ISSUE-026) |
| pre-stream-turns.test.ts | 12 | ISSUE-018 |
| repair-transcript.test.ts | 12 | domain/messages/repair |
| async-helpers.test.ts | 9 | kernel utilities |
| resume-handshake-frames.test.ts | 9 | adapters/websocket-chat (+ISSUE-026) |
| recovery-cutover.test.ts | 8 | dropped-quarry: old-architecture migration |
| recovery.test.ts | 5 | domain/reliability/recovery |
| submit-concurrency.test.ts | 5 | domain/reliability/submissions |
| client-tools.test.ts | 4 | domain/tools client-tool path |
| stall-watchdog.test.ts | 4 | domain/turn stall watchdog |
| recovery-conformance.test.ts | 2 | domain/reliability/recovery |
| slug-parity.test.ts | 1 | adapters/cloudflare/routing kebab rules |

## packages/agents/src/{browser,webmcp,x402,cli,react,e2e}-tests + tests-d

| File / group | ~Tests | Status | Notes |
|---|--:|---|---|
| browser-tests/browser.test.ts | 14 | blocked ISSUE-008 | |
| webmcp-tests/webmcp.test.ts | 36 | blocked ISSUE-025 | parked with the feature |
| x402-tests/x402.test.ts | 33 | blocked ISSUE-003 | vendored with the mcp client |
| cli-tests/{cli 27, vite-skills 13} | 40 | blocked ISSUE-013 | tooling |
| react-tests/{client 40, useAgent 25, rpc-robustness 14, cache-ttl 11, cache-invalidation 8, useAgentToolEvents 7, stub-tojson 5, agent-tool-replay 3, resume-overlap-race 2} | 115 | blocked ISSUE-007 | these certify the client package; once consumed as-is they run nearly-verbatim against the rebuild shell |
| e2e-tests/{fiber-eviction 15, concurrent-fibers 3, poison-row-aging 3, scan-deadline-yield 3, facet-multipass-recovery 1, poison-row-backoff 1} | 26 | pending | T2b — fiber/facet eviction e2e; highly relevant to our fibers + W3 spawner |
| tests-d/ (15 type-level files) | type | blocked ISSUE-021 | port opportunistically with the Serializable/type work |

## Other packages

| Package | ~Tests | Status | Notes |
|---|--:|---|---|
| packages/ai-chat (56 files) | 703 | dropped | the parallel product built on the replaced architecture; its behaviors reach us through the think ports + chat/__tests__ quarry |
| packages/codemode, shell, voice, hono-agents | — | n/a | consumed packages ship their own suites (ISSUES 004/005/010/012) |
