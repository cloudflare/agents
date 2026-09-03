---
"@cloudflare/think": minor
---

Replatform Think conversation storage onto `agents/sessions` and prompt context onto `agents/context`.

**Existing subclasses keep compiling and running.** `configureSession(session)` still accepts the `withContext()` / `withCachedPrompt()` chain, `this.session` still carries `addContext`, `getContextBlock`, `replaceContextBlock`, `refreshSystemPrompt`, `freezeSystemPrompt`, `tools()`, and the rest, and `appendMessage(message, parentId)` / `getHistory(leafId)` still take their positional arguments. Those context methods are deprecated forwards to the new `this.context`; new code should declare blocks in `configureContext()` and read `this.context` directly. `withCachedPrompt()` is a no-op because the frozen prompt is always persisted now.

**What you may want to change**

- Declare prompt blocks with the new `configureContext()` hook instead of `withContext()`. Blocks from both are merged, `configureContext()` first.
- Read context through `this.context` (a `ContextBlocks` from `agents/context`) instead of `this.session`.
- Import `Session` from `@cloudflare/think` when you annotate a `configureSession` override. The class exported from `agents/sessions` is the raw storage handle and is not assignable to Think's.

**Behaviour changes on upgrade**

- **Storage migrates on first wake and cannot be rolled back.** Each Durable Object lifts its `assistant_messages`, `assistant_compactions`, and `assistant_config` rows into the `cf_agents_session_*` tables, verifies every row landed, and drops the old tables. An object that has woken on this version has an empty conversation if you roll back to the previous release; rolling forward again is safe. Deploy behind a canary if you need a rollback path.
- `hydrationByteBudget` defaults to 32 MiB (was 24 MiB) and is now a hard ceiling that charges each row its full stored size, attachments included. There is no message-count floor, so an unusually large recent window can hydrate fewer than four messages. `getHistory()` still reads the full path.
- Context blocks load during `onStart`, as before the replatform, so `this.context.getBlock()` answers as soon as the object has started.
- `session.search()` is always available; Think enables the Sessions FTS index.
- Think no longer reads Sessions tables with raw SQL. If you queried `assistant_messages` yourself, use `this.session.history()` or `getHistory()`.

**Removed**

- `sessionAttachments`. There is nothing to configure about how Sessions stores a message: media leaves the row into a content-addressed attachment store and a message larger than one SQLite row is split across continuation rows, losslessly.
- `getRecentHistory(budget, minRecentMessages)`: the second argument is accepted and ignored.
- `compactAfter(threshold, { tokenCounter })`: the counter option is accepted and ignored; the trigger reads the estimate Sessions stamps on each row.
