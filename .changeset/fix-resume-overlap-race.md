---
"agents": patch
---

Fix reconnect-driven resume overlap throwing `Cannot read properties of undefined (reading 'state')` in `useAgentChat` (#1837).

With `resume: true` (the default), the hook re-probes the stream from its WebSocket `onAgentOpen` handler on every reconnect. The AI SDK's `Chat.makeRequest` has no concurrency guard — every resume shares the single mutable `this.activeResponse`, and its `finally` finalizer reads `this.activeResponse.state.message` with a bare (unguarded) read before clearing it. Under a reconnect storm (flaky mobile link, or a Durable Object bounce on redeploy), a second resume could overwrite + clear `activeResponse` before an earlier resume's finalizer ran, so the earlier finalizer read `undefined` and threw. The old guard didn't close the window: `isAwaitingResume()` only covers the handshake (it flips false the instant `STREAM_RESUMING` resolves, before the AI SDK sets status to `submitted` in a later microtask) and `statusRef` is lagging React state. Resumes are now serialized via an in-flight flag, so a re-probe `resumeStream()` is never issued while one is still outstanding.
