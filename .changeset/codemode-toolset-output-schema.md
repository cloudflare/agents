---
"@cloudflare/codemode": patch
---

`ToolSetConnector` now forwards each AI SDK tool's `outputSchema` into its connector descriptors, so durable `codemode.describe()` shows the output type instead of `unknown`, as `McpConnector` already does. Input and output schemas that convert asynchronously (`jsonSchema(promise)`) are now awaited instead of being dropped.

Output types, in both `generateTypes` and connector descriptors, now describe the value a tool returns rather than the input side of its schema. A `.default()` field is now required and a `.pipe()` field has the piped type. A `.transform()`, which JSON Schema can't express, shows as `unknown` instead of the pre-transform type.
