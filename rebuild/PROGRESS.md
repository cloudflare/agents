# Rebuild progress

Workflow state for the clean-room rebuild. Update when a module lands.
Implementers: read `audit/00-overview.md` first; your module's audit doc is
the spec. **Never read `packages/think/` or `packages/agents/`.**

## Status legend
`todo` → `in-progress` → `done` (tests green + typecheck clean)

## Wave 0–1 (foundations)
- [x] kernel/ids, kernel/errors, kernel/json, kernel/events (audit 01)
- [x] ports/* (audit 02)
- [x] adapters/memory/* incl. FakeModel (audit 02)
- [x] domain/messages/model (audit 03)

## Wave 2
- [x] domain/messages/repair + store (audit 03)
- [x] domain/state (audit 04)
- [x] domain/scheduling/dsl + cron (audit 05)
- [x] domain/stream/chunks (audit 07)

## Wave 3
- [x] domain/scheduling/scheduler + keep-alive (audit 05)
- [x] domain/queue (audit 04)
- [x] domain/fibers (audit 06)
- [x] domain/stream/resumable (audit 07)
- [x] domain/tools/registry (audit 08)
- [x] domain/turn/admission (audit 09)
- [x] domain/session (audit 10)
- [x] domain/workspace (audit 15)
- [x] domain/fetch (audit 16)
- [x] domain/rpc/callable (audit 21)

## Wave 4
- [x] domain/turn/loop (audit 09)
- [x] domain/session/compaction (audit 10)
- [x] domain/submissions (audit 11)
- [x] domain/actions (audit 12)
- [x] domain/scheduled-tasks (audit 13)
- [x] domain/recovery + overflow (audit 14)
- [x] domain/workspace/tools (audit 15)
- [x] domain/skills (audit 17)
- [x] domain/channels (audit 18)
- [x] domain/delegation (audit 19)
- [x] domain/workflows (audit 20)

## Wave 5–6
- [x] app/agent (audit 22)
- [x] app/think (audit 23)
- [x] e2e scenarios (audit 24)

## Refactor wave (docs 25-26): transport-free agents
- [x] domain/events/log.ts — ConversationEventLog (audit 25 §1)
- [x] Agent exposes scheduler/fibers/keepAlive + registerInternalCallback (audit 26 §5)
- [x] app rewire: events out, no Connection/frames; extractions 1-4, 6 (audits 25 §2-3, 26)
- [x] adapters/websocket-chat + relay; resumable.ts retired; e2e rewired (audit 25 §4-6)

## Log
- 2026-07-14: recovery conversation-dep surgery (the R2 deferral) done by the orchestrator: recovery.ts now owns continue/terminalize semantics (commits the repaired partial itself, persists the terminal message itself) over turnState + session + one scheduleTurn callback; Think's three recovery callbacks collapsed to scheduleRecoveryTurn. think.ts 1070 lines. 1050 tests green.
- 2026-07-14: refactor R3 done (1050 tests): websocket-chat adapter (cf_agent_* frames, resume via log offsets, echo exclusion, readonly), relayTurn in domain/events with adapter wrapper, resumable.ts deleted (log owns retention), chat-session + actions-approvals e2e run through the adapter. Refactor waves complete.
- 2026-07-14: refactor R2 done (1029 tests): app/ transport-free (banned-token test), turn-state + pending-interactions + assembly + maybeParkSuspension + session builder extracted; agent.ts 643 / think.ts 1096 lines (above ~450 target — recovery conversation-dep surgery deferred, inherent delegation surface). EventBus field renamed to `bus`; events() is the ConversationEventLog.
- 2026-07-14: refactor R1 done (973 tests): ConversationEventLog + Agent protected services; both Think facades and the fake-method dispatch hack deleted.
- 2026-07-14: refactor audit docs 25 (transport & lifecycle) and 26 (Think decomposition) written; decisions: methods canonical (no command envelope), replay built into the event port, cf_agent_* kept in the WS adapter, extractions bundled.
- 2026-07-13: e2e wave done (939 tests, 57 files). E2e agent fixed two Think bugs (stable session id across restarts; continuation now commits the repaired partial before re-running). Orchestrator closed three follow-up gaps: delegation summarize() reads UiChunk `delta`; Think.onStart reconciles declared tasks; public inspect/list/cancel/deleteSubmissions on Think. Remaining known gap: no public Think entry point for AgentToolRunService.reconcile() (e2e drives the domain service directly).
- 2026-07-13: Think composition root done (919 tests). Known gaps noted in agent report: deep interruption recovery + full delegation flow deferred to e2e; MessageStore row-size guard not wired (session owns persistence).
- 2026-07-13: wave 5 done (901 tests): chat recovery + overflow guard, Agent composition root over memory host.
- 2026-07-13: wave 4 done (826 tests): turn loop, fibers, actions, scheduled-tasks, delegation. (Wave interrupted once by session usage limit; all five agents resumed and completed.)
- 2026-07-13: wave 3 done (680 tests): scheduler/keep-alive, queue, admission, tool registry, session+compaction, workspace tools, fetch, skills, channels, workflows, submissions.
- 2026-07-13: wave 2 + workspace/callable/resumable done (357 tests). Tool types module added at domain/tools/types.ts.
- 2026-07-12: audit complete (docs 00–24), package scaffolded.
