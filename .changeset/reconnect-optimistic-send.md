---
"agents": patch
---

Fix `useAgentChat` dropping an in-flight optimistic send on reconnect: a message buffered by PartySocket while the socket was down was omitted from the server's idle-connect transcript replay, so the whole-array `setMessages` erased it from the UI until the turn completed.
