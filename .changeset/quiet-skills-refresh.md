---
"@cloudflare/think": minor
"agents": patch
---

Think builds each tool set once and reuses it until the state it derives from changes, instead of rebuilding workspace, fetch, action, extension, context-block and skill tools on every inference attempt (each turn, auto-continuation and overflow retry). `getTools()` and `getActions()` are still called every attempt.

Skill sources are no longer re-listed on every turn. The new `skillsRefresh` option defaults to `{ intervalMs: 60_000 }` (the `skills.r2` index TTL); set `"every-turn"` for the previous behaviour or `"on-start"` to load once. Continuations of an in-flight turn never refresh. A catalog change re-renders the system prompt once for the next turn; persisted transcript rows are never rewritten.

`ExtensionManager.getTools()`, `ContextBlocks.tools()` and `SkillRegistry.tools()` return the same tool set until their inputs change.
