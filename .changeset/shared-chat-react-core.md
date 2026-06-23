---
"agents": minor
---

Add the shared `agents/chat/react` entry with `useAgentChat`, chat transport helpers, and shared chat wire types. The hook also adds `syncMessagesToServer` so hosts with server-authoritative transcript storage can keep `setMessages` local-only.
