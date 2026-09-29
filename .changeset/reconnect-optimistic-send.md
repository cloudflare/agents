---
"agents": patch
---

Fix `useAgentChat` dropping an in-flight optimistic send on reconnect (#1983). A message buffered by PartySocket while the socket was down was missing from the transcript the server sends on connect, so the whole-array `setMessages` erased it from the UI until the turn completed. The hook now keeps such buffered sends when a snapshot is marked `connect: true` (the new optional field on `cf_agent_chat_messages`). Every other snapshot stays authoritative, so a server rollback of a rejected send (for example under `messageConcurrency: "drop"`) still removes it.
