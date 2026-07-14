# Ported test coverage ledger

One row per original test file (audit 29 §4). The port is complete when every
row is non-`pending`. Update the row in the SAME commit as the port.

**Status vocabulary**
- `pending` — not yet ported/assessed
- `ported` — copied (verbatim or near-verbatim) into `test-workers/ported/` or `e2e/`; pass/fail noted
- `rewritten` — same scenarios re-authored against the rebuilt surface
- `native <file>` — rebuild's own suite already covers it (pointer required)
- `dropped` — deliberately not ported (reason required)
- `quarry` — INTERNAL suite used as a spec checklist, never ported (audit 29 T4)
- `blocked ISSUE-NNN` — porting is pointless until that issue lands

**Failure triage vocabulary** (for `ported` rows that fail): `framing`
(ISSUE-026 payload mismatch) · `missing-feature ISSUE-NNN` · `fixture-gap`
(fixture agent not yet capable) · `divergence` (intentional behavior change —
explain) · `flake`.

## think/src/tests/ (main suite)

| Original file | ~Tests | Class | Status | Notes |
|---|--:|---|---|---|
| client-tools.test.ts | 82 | WIRE | pending | T1; needs observability bridge for some asserts |
| think-session.test.ts | 198 | WIRE+API | pending | T1 (wire half) / T3 (api half) — split on port |
| hooks.test.ts | 105 | WIRE+API | pending | T1/T3 split |
| submissions.test.ts | 51 | PUBLIC-API | pending | T3 |
| agent-tools.test.ts | 33 | PUBLIC-API | pending | T3 |
| assistant-agent-loop.test.ts | 23 | WIRE | pending | T1 |
| extension-manager.test.ts | 34 | INTERNAL | blocked ISSUE-006 | port with the extensions lift |
| run-turn.test.ts | 26 | PUBLIC-API | pending | T3 |
| fetch-tools.test.ts | 32 | INTERNAL | quarry | checklist vs domain/fetch suite |
| assistant-tools.test.ts | 30 | PUBLIC-API | pending | T3 |
| scheduled-tasks.test.ts | 14 | PUBLIC-API | pending | T3 |
| message-reconciliation.test.ts | 8 | WIRE | ported 0/8 | All fail `framing` (ISSUE-026: init.body request never parsed → 10s timeouts) before reaching the intended `missing-feature ISSUE-015` reconciliation asserts. Re-triage after 026. |
| execute-hitl.test.ts | 10 | WIRE | ported 0/10 | All fail `framing` (ISSUE-026: requests unparsed → 15s timeouts). The rebuild HAS the approval/durable-pause flow, so expect real signal here once 026 lands; original execute-tool paused-output semantics may add `missing-feature ISSUE-004` residue. |
| hydration-budget.test.ts | 13 | PUBLIC-API | blocked ISSUE-014 | media-eviction dependent |
| actions-durable-pause.test.ts | 18 | PUBLIC-API | pending | T3 |
| host-embedding.test.ts | 11 | INTERNAL | blocked ISSUE-013 | framework/server-entry |
| onconnect-broadcast.test.ts | 9 | WIRE | ported 5/9 | Identity/state/history connect frames already compatible (5 pass). 4 fail: on-connect CHAT_MESSAGES suppression while a stream is active, and terminal replay via `cf_agent_stream_resuming` on reconnect (ours answers `resume_none`) — `framing` + ISSUE-018-adjacent `divergence` (#1645 semantics). |
| actions-attach-reply.test.ts | 12 | WIRE | pending | T1 |
| assistant-agent.test.ts | 5 | WIRE | ported 0/5 | **T0 gate.** All fail `framing` (ISSUE-026: init.body envelope + {body,done} response chunks → timeouts). |
| channel-recovery.test.ts | 5 | PUBLIC-API | pending | T3 |
| stream-cleanup.test.ts | 11 | PUBLIC-API | pending | T3; retention semantics differ (event log) — expect divergence notes |
| media-eviction.test.ts | 9 | INTERNAL | blocked ISSUE-014 | port pure-fn tests with the impl |
| workflows.test.ts | 3 | INTERNAL | blocked ISSUE-016 | |
| action-pause-recovery.test.ts | 3 | PUBLIC-API | pending | T3 |
| onstart-degraded.test.ts | 5 | PUBLIC-API | pending | T3 |
| agent-tool-reattach-recovery.test.ts | 2 | WIRE | pending | T1 |
| streaming-message-id.test.ts | 1 | WIRE | ported 0/1 | **T0 gate.** Fails `framing` (ISSUE-026); also asserts start-chunk messageId alignment once the envelope exists. |
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
| *.test-d.ts (3 files) | — | type-level | blocked ISSUE-021 | |

## think/src/e2e-tests/ (kill/restart, node vitest + wrangler dev)

| Original file | Tests | Status | Notes |
|---|--:|---|---|
| chat-recovery.test.ts | 5 | ported 2/5 | Real dispatcher `npm run test:e2e`: wrangler dev booted, served requests, was SIGKILLed, and restarted successfully across all 5 tests (repeated `Ready on http://localhost:18797` after each kill/restart; no boot failure, port conflict, fixture compile error, or harness-level failure). PASSED: `should recover helper sub-agent chat after process kill via parent alarm` and `should re-attach to a still-running child agent-tool run after parent restart and collect its terminal result (#1630)`; both are pure RPC-driven and prove the harness's wrangler start/kill/restart/RPC machinery works end-to-end. FAILED expected triage: `should recover chat after process kill via persisted alarm` (`getRecoveryStatus` never recovered), `should still recover after repeated restart churn around an interrupted turn` (`hasFiberRows` false before churn), and `should expose the current post-persist chat request failure surface` (`sendChatMessageAndWaitForDone` timed out). Root cause for all three failures is ISSUE-026: `sendChatMessage` sends `cf_agent_use_chat_request`, which the rebuild adapter does not parse yet, so no fiber/stream starts and no `cf_agent_use_chat_response` with `done:true` is produced. Native baseline also matched expectations: `npx vitest run` 1057/1057 passed, `npm run test:workers` 42/42 passed, `npm run test:ported` 33 tests with unchanged 5-pass baseline, and `npm run typecheck` clean. |
| stall-recovery.test.ts | 1 | pending | T2 |
| context-overflow-recovery.test.ts | 3 | pending | T2 |
| submission-recovery.test.ts | 3 | pending | T2 |
| action-pause-recovery.test.ts | 1 | pending | T2 |
| action-ledger-recovery.test.ts | 1 | pending | T2 |
| tool-rollback.test.ts | 1 | pending | T2 |
| persist-false-preserves.test.ts | 1 | pending | T2 |
| reattach-budget.test.ts | 1 | pending | T2 (sub-agent recovery) |
| task-amplification.test.ts | 2 | pending | T2 (sub-agent recovery) |
| messenger-recovery.test.ts | 2 | blocked ISSUE-011 | |
| workflow-recovery.test.ts | 2 | blocked ISSUE-016 | |
| assistant-e2e.test.ts | 4 | pending | needs real AI binding; out of CI like the original |
| step-prompt-structured.test.ts | 2 | blocked ISSUE-016 | real providers; out of CI |

## think cli/react/vite

| Original file | Tests | Status | Notes |
|---|--:|---|---|
| react-tests/stream-resume.test.tsx | 2 | pending | T0 third gate (client half) |
| react-tests/studio-chat.test.tsx | 3 | pending | T1 |
| cli-tests/* (2 files) | 55 | blocked ISSUE-013 | build tooling |
| vite-tests/vite.test.ts | 10 | blocked ISSUE-013 | |
| tests/generated-entry (1 file) | 10 | blocked ISSUE-013 | |

## agents/src/tests/ (Think-relevant subset)

| Original file | ~Tests | Status | Notes |
|---|--:|---|---|
| sub-agent.test.ts | 97 | pending | T3 (delegation surface) |
| schedule.test.ts | 52 | pending | T3 |
| run-fiber.test.ts | 48 | pending | T3 |
| workflow.test.ts | 47 | blocked ISSUE-016 | |
| state.test.ts | 22 | pending | T3 |
| protocol-messages.test.ts | 18 | pending | T1-adjacent (wire vocab) |
| callable.test.ts | 21 | pending | T3 |
| sub-agent-routing / spike (2 files) | 38 | blocked ISSUE-017 | |
| readonly-connections.test.ts | 17 | pending | T3 |
| queue.test.ts | 3 | pending | T3 |
| agent-tool-{detached,replay,failure} (3) | 23 | pending | T3 |
| keep-alive.test.ts | 14 | pending | T3 |
| experimental/memory/session/* (~6 files) | ~218 | quarry | audit 28: session stays native; spec source if swapped |
| experimental/memory/utils/compaction.test.ts | 6 | quarry | vs session/compaction suite |

## agents/src/chat/__tests__/ (25 files, 477 tests)

| Group | Status | Notes |
|---|---|---|
| recovery-engine (65), recovery-incident (48), stream-accumulator (62), message-reconciler (37) | quarry | primary spec checklists for reliability/conversation + ISSUE-015 |
| remaining 21 files | quarry | internal to the replaced architecture (audit 29 T4) |
