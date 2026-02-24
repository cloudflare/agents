---
"@cloudflare/ai-chat": patch
---

Undeprecate client tool APIs (`createToolsFromClientSchemas`, `clientTools`, `AITool`, `extractClientToolSchemas`, and the `tools` option on `useAgentChat`) for SDK/platform use cases where tools are defined dynamically at runtime. Fix spurious `detectToolsRequiringConfirmation` deprecation warning when using the `tools` option.
