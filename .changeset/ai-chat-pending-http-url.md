---
"@cloudflare/ai-chat": patch
---

Fix `useAgentChat()` crashing on first render when `agent.getHttpUrl()` returns an empty string. This happened in setups where the WebSocket handshake hadn't completed by the time React rendered — most commonly when the agent is reached through a proxy or custom-routed worker — because `@cloudflare/ai-chat` unconditionally called `new URL(agent.getHttpUrl())`. See [#1356](https://github.com/cloudflare/agents/issues/1356).

`useAgentChat()` now treats a missing HTTP URL as "not ready yet":

- The built-in `/get-messages` fetch is deferred until the URL is known, and applied exactly once when it resolves (empty chats only — existing messages are never overwritten).
- Custom `getInitialMessages` callbacks continue to run and are passed `url: undefined` so they can load from other sources if they don't need the socket URL. `GetInitialMessagesOptions.url` is now `string | undefined`; callers that previously typed `url: string` should widen to `url?: string`.
- Initial messages are cached by agent identity (class + name) rather than by URL + identity, so the URL-arrival transition no longer invalidates the cache, re-invokes the loader, or re-triggers Suspense once the chat has already been populated.
- The underlying `useChat` instance keeps a stable `id` across the URL-arrival transition, so in-flight stream resume and chat state are preserved.

No API or behavior changes for apps where the URL was already available synchronously on first render.
