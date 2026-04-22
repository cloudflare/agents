---
"agents": patch
---

Remove unused `dependencies`, `devDependencies`, and `peerDependencies` from the `agents` package.

- `dependencies`: drop `json-schema`, `json-schema-to-typescript`, and `picomatch`. None are imported by the package; `picomatch` was already pulled in transitively via `@rolldown/plugin-babel`.
- `devDependencies`: drop `@ai-sdk/openai` (only referenced in a commented-out line) and `@cloudflare/workers-oauth-provider` (not referenced anywhere).
- `peerDependencies` / `peerDependenciesMeta`: drop `@ai-sdk/react` and `viem`. `@ai-sdk/react` is already a peer of `@cloudflare/ai-chat` (itself an optional peer here), and `viem` is a regular dependency of `@x402/evm`, so both are supplied transitively when the relevant optional features are used.
