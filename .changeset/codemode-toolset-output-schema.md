---
"@cloudflare/codemode": patch
---

`ToolSetConnector` now forwards each AI SDK tool's `outputSchema` into its connector descriptors, so durable `codemode.describe()` shows the output type instead of `unknown`, as `McpConnector` already does.
