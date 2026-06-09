---
"@cloudflare/think": patch
---

Stop oversized sessions from permanently bricking the Durable Object with `SQLITE_NOMEM` on wake (#1710).

A throw out of `onStart` is terminal: partyserver resets its init state and rethrows, so every wake — including platform alarm retries — re-runs the failing `onStart` forever, and the failure survives redeploys because it is driven by stored data. Long-lived media-heavy sessions hit exactly this once eager full-transcript hydration approached the isolate's memory budget. Four changes:

- **`onStart` degrades instead of throwing.** Transcript hydration, declared scheduled-task reconciliation, and durable submission/workflow recovery are now best-effort: failures are recorded on `_onStartDegradations`, logged with remediation hints, and emitted as `chat:onstart:degraded` observability events, and the agent comes up reachable. The user-defined `onStart()` is intentionally NOT guarded.
- **`hydrationByteBudget` (default 24MB).** Cache refreshes hydrate at most this many stored bytes; an oversized transcript boots as a bounded window of the most recent messages (always at least the latest) and emits `chat:hydration:windowed`. Durable storage is never truncated by this; `session.getHistory()` still reads the full path. Set to `Infinity` to restore unbounded hydration.
- **`mediaEviction` (default on).** Background passes rewrite oversized inline media — large `data:` URL file parts and large strings nested in tool outputs — in messages that have aged out of the recent window, replacing them with size/path markers. By default the original bytes are preserved as workspace files under `/attachments/evicted/` (written BEFORE the row is rewritten, so no pass can lose data); set `externalizeToWorkspace: false` to drop them or `false` to disable. Passes are memory-bounded: row sizes come from `getHistoryRowStats()`, only rows large enough to contain an evictable value are parsed, one at a time.
- Plain `text` parts are never evicted, and the recent window (`keepRecentMessages`, default 8) stays above the read-time truncation window so the model never loses content it would still see.
