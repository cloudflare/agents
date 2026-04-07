---
"@cloudflare/ai-chat": patch
---

Widen `useAgentChat` agent prop type to accept both typed and untyped `useAgent` connections. Previously, `useAgent<MyAgent>()` results could not be passed to `useAgentChat` due to incompatible `call` types. The agent prop now uses a structural type matching only the fields `useAgentChat` actually uses.
