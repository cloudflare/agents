---
"@cloudflare/ai-chat": patch
---

Fix `regenerate()` leaving stale assistant messages in SQLite

**Bug 1 — Transport drops `trigger` field:**
`WebSocketChatTransport.sendMessages` was not including the `trigger` field
(e.g. `"regenerate-message"`, `"submit-message"`) in the body payload sent
to the server. The AI SDK passes this field so the server can distinguish
between a new message and a regeneration request. Fixed by adding
`trigger: options.trigger` to the serialized body.

On the server side, `trigger` is now destructured out of the parsed body
alongside `messages` and `clientTools`, so it does not leak into
`options.body` in `onChatMessage`. Users who inspect `options.body` will
not see any change in behavior.

**Bug 2 — `persistMessages` never deletes stale rows:**
`persistMessages` only performed `INSERT ... ON CONFLICT DO UPDATE` (upsert),
so when `regenerate()` removed the last assistant message from the client's
array, the old row persisted in SQLite. On the next `_loadMessagesFromDb`,
the stale assistant message reappeared in `this.messages`, causing:

- Anthropic models to reject with HTTP 400 (conversation must end with a
  user message)
- Duplicate/phantom assistant messages across reconnects

Fixed by adding an internal `_deleteStaleRows` option to `persistMessages`.
When the chat-request handler (`CF_AGENT_USE_CHAT_REQUEST`) calls
`persistMessages`, it passes `{ _deleteStaleRows: true }`, which deletes
any DB rows whose IDs are absent from the incoming (post-merge) message set.
This uses the post-merge IDs from `_mergeIncomingWithServerState` to
correctly handle cases where client assistant IDs are remapped to server IDs.

The `_deleteStaleRows` flag is internal only (`@internal` JSDoc) and is
never passed by user code or other handlers (`CF_AGENT_CHAT_MESSAGES`,
`_reply`, `saveMessages`). The default behavior of `persistMessages`
(upsert-only, no deletes) is unchanged.

**Bug 3 — Content-based reconciliation mismatches identical messages:**
`_reconcileAssistantIdsWithServerState` used a single-pass cursor for both
exact-ID and content-based matching. When an exact-ID match jumped the
cursor forward, it skipped server messages needed for content matching
of later identical-text assistant messages (e.g. "Sure", "I understand").

Rewritten with a two-pass approach: Pass 1 resolves all exact-ID matches
and claims server indices. Pass 2 does content-based matching only over
unclaimed server indices. This prevents exact-ID matches from interfering
with content matching, fixing duplicate rows in long conversations with
repeated short assistant responses.
