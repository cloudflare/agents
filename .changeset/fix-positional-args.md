---
"@cloudflare/codemode": patch
---

Fix `createCodeTool` dropping `positionalArgs` from providers, causing multi-argument tool calls (e.g. `stateTools`) to silently lose arguments after the first.
