---
"agents": patch
"@cloudflare/ai-chat": patch
---

fix: deliver the actual error to `onError(connection, error)` when a message handler throws

When `.sql` (or anything else) threw while an agent was handling a websocket message, the framework reported it with a single-argument `this.onError(error)` call. A user override written with the documented two-parameter signature — `onError(connection, error)` — therefore received the error as the _connection_ and `undefined` as the _error_, and the original failure was replaced by `throw undefined` upstream (#388).

`_tryCatch` (and ai-chat's `_tryCatchChat`) now read the connection from the agent context and deliver the actual caught error through the `onError(connection, error)` overload, then rethrow the original error rather than `onError`'s return value. The base `onError` discriminates its overloads on call arity instead of error truthiness, so a connection error with no detail is no longer misrouted into the server branch (which threw the Connection object itself); errors are always passed through exactly as received, never synthesized.
