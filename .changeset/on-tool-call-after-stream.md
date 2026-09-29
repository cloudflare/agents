---
"agents": patch
---

`useAgentChat` now calls `onToolCall` once the response stream ends, for each tool call still waiting for a result (#2195). Before, it also fired for server tools while the server was still running them. An app that answered an unknown tool with an error sent the server a false failure for that call and turned off auto-continuation for the turn.
