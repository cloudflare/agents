---
"agents": patch
---

Fix `this.sql` to throw `SqlError` directly instead of routing through `onError`

Previously, SQL errors from `this.sql` were passed to `this.onError()`, which by default logged the error and re-threw it. This caused confusing double error logs and made it impossible to catch SQL errors with a simple try/catch around `this.sql` calls if `onError` was overridden to swallow errors.

Now, `this.sql` wraps failures in `SqlError` (which includes the query string for debugging) and throws directly. The `onError` lifecycle hook is reserved for WebSocket connection errors and unhandled server errors, not SQL errors.
