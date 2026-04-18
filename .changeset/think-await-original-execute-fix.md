---
"@cloudflare/think": patch
---

Fix `_wrapToolsWithDecision` to `await originalExecute(...)` before checking for `Symbol.asyncIterator`. The previous code missed `Promise<AsyncIterable>` returns from plain async functions (`async function execute(...) { return makeIter(); }`) — `Symbol.asyncIterator in promise` is always false, the collapse logic was skipped, and the AI SDK ended up treating the iterator instance itself as the final output value (which the wrapper's own comment warned about). Both sync-returned-iterable and async-returned-iterable cases are now covered, with regression tests for each.
