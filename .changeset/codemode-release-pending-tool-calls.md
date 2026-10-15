---
"@cloudflare/codemode": patch
---

Stop leaking Dynamic Worker concurrency slots when code returns before a tool call finishes.

If a program run by `DynamicWorkerExecutor` returned while a connector call it started was still running (for example `async () => { t.ping({ x: "slow" }); return 1 }`), the sandbox kept waiting on that call after the run ended. The Dynamic Worker stayed counted as in-flight, so a Durable Object reusing one runtime (`createCodemodeRuntime` with connectors) failed with "Dynamic worker concurrency limit exceeded" after ten such programs. When `execute()` settles, any call it left pending, connector or provider, is now answered with an error right away. The work on the host still runs to completion, so fire-and-forget calls still happen, but the sandbox no longer keeps a request open for them.
