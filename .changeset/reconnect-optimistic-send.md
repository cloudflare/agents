---
"agents": patch
---

Fix `useAgentChat` dropping an in-flight optimistic send on reconnect. When a message was sent while the socket was down, PartySocket buffers the frame for delivery, but the idle-connect transcript the server replays on reconnect (`cf_agent_chat_messages`) doesn't include it yet — so the whole-array `setMessages` replace erased the just-sent message from the UI until the turn completed and the server rebroadcast. The reconnect replay now preserves a trailing local-only `user` message that was buffered while disconnected, while still letting the server snapshot win for a delivered send it deliberately rolls back (e.g. `messageConcurrency: "drop"`) and for a regenerate's assistant replacement. Also fixes `@cloudflare/ai-chat` and `@cloudflare/think`, which re-export the hook unchanged.
