---
"@cloudflare/ai-chat": patch
---

Fix `useAgentChat` recreating the AI SDK Chat instance — and orphaning any in-flight `resumeStream` — whenever `agent.name` transitions in place.

The `useAgent({ basePath })` + `static options = { sendIdentityOnConnect: true }` pattern lets the server own the Durable Object instance name. The browser starts with a placeholder (`"default"`), then `useAgent` mutates the agent object's `.name` to the server-assigned value when the identity frame arrives. `useAgentChat` previously included `agent.name` in the stable chat id it passed to `useChat({ id })`, so the transition changed the id and the AI SDK recreated the underlying Chat instance. The useEffect that fires `chatRef.current.resumeStream()` is keyed on the ref object, not the Chat instance, so it does not re-fire on recreation — the resumed stream kept feeding chunks into the orphaned Chat's state while React subscribed to the new Chat's state, so the user saw an empty assistant reply after a mid-stream refresh until the server's final `CF_AGENT_CHAT_MESSAGES` broadcast landed.

`useAgentChat` now distinguishes an in-place `agent.name` mutation from a genuine "consumer switched chats" event by checking the agent object's reference identity:

- same `agent` reference, `name` mutation → not a chat switch; keep the Chat instance stable.
- new `agent` reference → chat switch; recompute the stable chat id so the AI SDK recreates the Chat against the new conversation.

The stable id is also still upgraded once from the identity-only fallback to the URL-resolved key when the WebSocket handshake completes.

Consumers who want to switch chats without remounting should pass a different `agent` object (e.g. a new `useAgent({...})` call with a different `name`). To get a completely fresh Chat (e.g. when mounting a different chat tab), the conventional React pattern — `key={chatId}` on the parent or swapping the subtree — continues to work.
