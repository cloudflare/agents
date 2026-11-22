---
"agents": patch
---

Fix regressions from the fiber and MCP moves: `listFibers({ status: [] })` returns no fibers again; a sub-agent fiber started while another fiber's recovery wake failed to register still gets a wake; a fiber whose recovery hook kills the isolate no longer takes the agent down: a managed fiber is marked `interrupted` once, and a plain `runFiber()` row is dropped after three such attempts (`fiber:recovery:skipped`, reason `recovery_crashed`); and a cold `addMcpServer()` call before an older agent's stored name is loaded no longer fails when it needs no callback URL.
