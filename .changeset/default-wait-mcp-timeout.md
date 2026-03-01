---
"@cloudflare/ai-chat": patch
---

Changed `waitForMcpConnections` default from `false` to `{ timeout: 10_000 }`. MCP connections are now waited on by default with a 10-second timeout, so `getAITools()` returns the full set of tools in `onChatMessage` without requiring explicit opt-in. Set `waitForMcpConnections = false` to restore the previous behavior.
