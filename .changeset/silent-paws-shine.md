---
"agents": minor
---

Throttle chat UI updates by default in `useAgentChat`

Streaming writes chat state once per chunk, and each write re-renders. When
chunks arrive in a burst — a resumed stream replaying a long turn, for
example — React reaches its 50-render limit and throws "Maximum update depth
exceeded", which the AI SDK reports as a failed turn even though the server
completed it (#1913).

`useAgentChat` now coalesces those updates every 50ms, which removes about 78%
of renders on a fast stream and matches the value the AI SDK documents. The
first chunk of a stream is never delayed. Pass `throttle: false` to render
every chunk as it arrives, or a number to change the interval. The deprecated
`experimental_throttle` is still honoured. Message snapshots, functional
updates, and streamed continuations resolve against the current chat store, so
coalescing renders cannot roll assistant content back to an older snapshot.
