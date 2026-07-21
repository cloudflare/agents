---
"agents": patch
"@cloudflare/think": patch
---

Cache MCP JSON Schema conversion for the current catalog on each live connection, and let Think agents skip direct MCP AI-tool exposure when those tools are exposed through Code Mode or another mechanism outside Think's automatic tool set.
