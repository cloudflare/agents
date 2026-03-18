---
"@cloudflare/codemode": patch
---

Add `SandboxPlugin` interface and plugin support to `DynamicWorkerExecutor` and `createCodeTool`. Plugins add named globals (e.g. `state.*`) to the sandbox alongside `codemode.*` tools, enabling composable capabilities from different packages in a single execution.
