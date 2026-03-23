# Memory API — TODO

What hermes-agent implements that we don't yet have first-class support for.

## Done

- [x] Session message storage (SQLite, UIMessage format)
- [x] MicroCompaction (truncate old tool outputs + text, no LLM)
- [x] Full compaction with user-supplied function
- [x] Auto-compaction on token threshold
- [x] Context blocks with per-block providers (ContextBlockProvider)
- [x] Frozen snapshot for system prompt (toSystemPrompt() caches until re-called)
- [x] update_context AI tool for writable blocks
- [x] Readonly block enforcement
- [x] Token estimation + maxTokens per block
- [x] Usage % indicator in rendered blocks
- [x] FTS5 search over messages (content-sync, triggers)

## Missing — High Priority

- [ ] **Reference compaction implementation** — hermes has a structured summary format (Goal, Progress, Key Decisions, Next Steps) and iterative updates. We have the `CompactFunction` interface but no reference implementation. Need an example that shows head/tail protection, middle summarization, and tool pair sanitization.
- [ ] **Iterative summary updates** — hermes doesn't regenerate summaries from scratch on each compaction. It passes the previous summary to the next compaction call and asks for an incremental update. Session should store `_previousSummary` and pass it to the compact fn.
- [ ] **Tool call/result pair sanitization** — after compaction, orphaned tool calls (result dropped) or orphaned results (call dropped) break the API. Need automatic cleanup: remove orphaned results, add stub results for orphaned calls.
- [ ] **Session split on compaction** — hermes creates a new session with `parent_session_id` when compacting, preserving lineage for search. We should support this: `compact()` returns a new session ID, old session ends with `end_reason="compression"`.

## Missing — Medium Priority

- [ ] **Bounded memory with % indicator in tool description** — the update_context tool description should show current usage per block so the AI knows when to consolidate.
- [ ] **Memory injection scanning** — scan content before saving to blocks for prompt injection patterns, exfiltration, invisible unicode. Hermes rejects dangerous content.
- [ ] **Session metadata table** — hermes tracks per-session: model, source, token counts, cost, title, parent_session_id. We only store messages. Add a sessions table.
- [ ] **Session search across sessions** — our FTS searches within one DO. Cross-session search needs a different architecture (shared D1 database, or search service).
- [ ] **Context file discovery** — hermes auto-discovers .hermes.md, AGENTS.md, .cursorrules from the working directory. Could be useful for agent projects.
- [ ] **@reference syntax** — `@file:path`, `@git:5`, `@url:https://...` in user messages, expanded before sending to LLM. Context injection with safety limits.

## Missing — Low Priority / Future

- [ ] **Honcho-style cross-session user modeling** — AI-generated user profile that evolves across sessions. Optional, requires external service.
- [ ] **Prompt caching markers** — hermes applies Anthropic cache_control breakpoints to system prompt + last 3 messages. We should document the pattern even if we don't enforce it.
- [ ] **Trajectory saving** — save conversation traces in ShareGPT format for training/evaluation. Hermes does this automatically.
- [ ] **Session title generation** — auto-generate a title for each session based on first user message.
- [ ] **Separate USER.md target** — hermes splits memory into MEMORY (env facts) and USER (preferences). Currently we leave this to the developer via block labels.

## Architecture Notes

- Session is the single entry point (no separate Context class)
- Each context block has its own ContextBlockProvider — storage is pluggable per block
- Frozen snapshot pattern: toSystemPrompt() captures once, setBlock() writes to provider but doesn't change the snapshot. Re-snapshot on next toSystemPrompt() call.
- FTS5 uses content-sync mode (content='table_name') — no data duplication, triggers keep index in sync
