---
"agents": patch
---

Fix regressions from the fiber and MCP moves: `listFibers({ status: [] })` returns no fibers again; a sub-agent fiber started while another fiber's recovery wake failed to register still gets a wake; a managed fiber whose recovery hook kills the isolate is marked `interrupted` once instead of re-running the hook on every wake; and a cold `addMcpServer()` call before an older agent's stored name is loaded no longer fails when it needs no callback URL.
