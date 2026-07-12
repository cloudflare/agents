# Rebuild progress

Workflow state for the clean-room rebuild. Update when a module lands.
Implementers: read `audit/00-overview.md` first; your module's audit doc is
the spec. **Never read `packages/think/` or `packages/agents/`.**

## Status legend
`todo` → `in-progress` → `done` (tests green + typecheck clean)

## Wave 0–1 (foundations)
- [ ] kernel/ids, kernel/errors, kernel/json, kernel/events (audit 01)
- [ ] ports/* (audit 02)
- [ ] adapters/memory/* incl. FakeModel (audit 02)
- [ ] domain/messages/model (audit 03)

## Wave 2
- [ ] domain/messages/repair + store (audit 03)
- [ ] domain/state (audit 04)
- [ ] domain/scheduling/dsl + cron (audit 05)
- [ ] domain/stream/chunks (audit 07)

## Wave 3
- [ ] domain/scheduling/scheduler + keep-alive (audit 05)
- [ ] domain/queue (audit 04)
- [ ] domain/fibers (audit 06)
- [ ] domain/stream/resumable (audit 07)
- [ ] domain/tools/registry (audit 08)
- [ ] domain/turn/admission (audit 09)
- [ ] domain/session (audit 10)
- [ ] domain/workspace (audit 15)
- [ ] domain/fetch (audit 16)
- [ ] domain/rpc/callable (audit 21)

## Wave 4
- [ ] domain/turn/loop (audit 09)
- [ ] domain/session/compaction (audit 10)
- [ ] domain/submissions (audit 11)
- [ ] domain/actions (audit 12)
- [ ] domain/scheduled-tasks (audit 13)
- [ ] domain/recovery + overflow (audit 14)
- [ ] domain/workspace/tools (audit 15)
- [ ] domain/skills (audit 17)
- [ ] domain/channels (audit 18)
- [ ] domain/delegation (audit 19)
- [ ] domain/workflows (audit 20)

## Wave 5–6
- [ ] app/agent (audit 22)
- [ ] app/think (audit 23)
- [ ] e2e scenarios (audit 24)

## Log
- 2026-07-12: audit complete (docs 00–24), package scaffolded.
