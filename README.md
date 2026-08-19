# Reproduction for cloudflare/agents#2132

Pins `@cloudflare/think@0.16.0` and `agents@0.21.0`, uses a provider-free deterministic AI SDK model, and recreates the affected external/older Session configuration. The configured Session predates Think's private `internal_onMessagesChanged` hook; a no-op compatibility shim lets Think boot while retaining the stale-cache behavior.

## Run

```sh
npm install --legacy-peer-deps
npm run deploy
npm run verify -- https://<deployment>.workers.dev
```

Or open the deployment, press **Trigger bug**, and inspect the event log/data. The page:

1. streams a deterministic assistant reply;
2. closes the WebSocket immediately after the stream's `done` frame;
3. reconnects;
4. compares the reconnect snapshot and `/get-messages` against `session.getHistory()`.

A reproduction has one user message in both cache-backed recovery surfaces but two durable messages (user + assistant) in Session storage.

## Important control

With Think's built-in Session from `agents@0.21.0`, the issue does **not** reproduce: that Session invokes Think's `internal_onMessagesChanged` listener, which calls `_upsertCachedMessage` after `appendMessage`/`updateMessage`. This narrows the bug to Session implementations that do not deliver that private change event (the same kind of setup for which `_upsertMessageInHistory` otherwise has no direct cache update).
