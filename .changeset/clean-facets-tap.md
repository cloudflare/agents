---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
"agents": patch
---

Fix sub-agent WebSockets on deployed Workers by keeping the browser WebSocket owned by the parent Agent and forwarding connect/message/close events to child facets over RPC.

Fix resumed chat streams so a partially hydrated assistant response is rebuilt from replay chunks instead of rendering replayed text as a second assistant text part.

Fix a resume ACK race where drill-in chat connections could miss the terminal stream frame if the helper completed between the resume notification and client acknowledgement.
