# Memory API — TODO

## Done

- [x] Session message storage (SQLite, UIMessage format)
- [x] MicroCompaction (truncate old tool outputs + text, no LLM)
- [x] Full compaction with user-supplied function + auto-compaction on token threshold
- [x] Reference compaction: `createCompactFunction()` with head/tail protection, token-budget boundaries, structured LLM summary, iterative updates
- [x] Tool pair alignment (never split call/result across compaction boundary)
- [x] Tool pair sanitization (fix orphaned calls/results after compaction)
- [x] Context blocks with per-block `ContextBlockProvider`
- [x] Frozen snapshot (`toSystemPrompt()` caches, `refreshSystemPrompt()` to re-render)
- [x] `update_context` AI tool for writable blocks
- [x] Readonly block enforcement
- [x] Token estimation + maxTokens per block + usage % indicator
- [x] FTS5 search over messages
- [x] Separate USER.md — developers control this via block labels (no framework opinion needed)

## Remaining

- [ ] **Session split on compaction** — create new session with `parent_session_id` when compacting, preserving lineage for cross-session search
- [ ] **Session metadata table** — track per-session: model, source, token counts, cost, title, parent_session_id
- [ ] **Memory injection scanning** — scan content before saving to blocks for prompt injection, exfiltration, invisible unicode
- [ ] **Cross-session search** — FTS currently searches within one DO. Shared D1 or search service needed for cross-session
- [ ] **Context file discovery** — auto-discover .hermes.md, AGENTS.md, .cursorrules from working directory
- [ ] **@reference syntax** — `@file:path`, `@git:5`, `@url:https://...` expanded before LLM call
- [ ] **Prompt caching markers** — document Anthropic cache_control pattern (system + last 3 messages)
