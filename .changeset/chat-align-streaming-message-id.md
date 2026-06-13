---
"@cloudflare/ai-chat": patch
---

Fix transient duplicate assistant messages in the chat UI when the model
provider does not emit a `start.messageId` (e.g. Workers AI). The agent now
stamps the assistant message id it persists under onto the new-turn `start`
chunk it streams to clients, so the live-streamed message and the persisted
`CF_AGENT_CHAT_MESSAGES` broadcast share an id and reconcile cleanly instead of
briefly rendering the turn twice before collapsing. Continuation turns still
strip `start.messageId` so they append to the existing assistant message.
