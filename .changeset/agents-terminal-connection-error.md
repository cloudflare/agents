---
"agents": minor
"@cloudflare/ai-chat": minor
---

Stop reconnecting on terminal WebSocket close events and expose terminal connection failures via `connectionError` / `onConnectionError` on `AgentClient`, `useAgent`, and `useAgentChat`.
