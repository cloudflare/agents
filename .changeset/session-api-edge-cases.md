---
"agents": patch
---

fix(experimental): session API edge cases, compaction improvements, and status broadcasting

- Fix empty prompt not persisted (`freezeSystemPrompt` null vs empty)
- Fix double-prefix in compaction summaries
- Fix `SearchResult.createdAt` made optional (FTS5 can't populate it)
- Fix cross-session `parentId` validation
- Add depth guard to recursive CTEs
- Fix `previousSummary` closure lost on DO eviction
- Filter compaction overlay messages from iterative compaction range
- Return correct `fromMessageId` from `compact()`
- New `CompactResult` return type, `COMPACTION_PREFIX` constant, `isCompactionMessage()` helper
- New `onCompaction()` + `compactAfter()` builder methods
- Export `MessageType` enum from `agents` package
- Session status broadcasting during compaction (`cf_agent_session`, `cf_agent_session_error`)
