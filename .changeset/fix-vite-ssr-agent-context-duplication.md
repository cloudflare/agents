---
"agents": patch
"@cloudflare/ai-chat": patch
---

Fix `getCurrentAgent()` returning `undefined` connection when used with `@cloudflare/ai-chat` and Vite SSR

Re-export `agentContext` from the main `agents` entry point and update `@cloudflare/ai-chat` to import it from `agents` instead of the `agents/internal_context` subpath export. This prevents Vite SSR pre-bundling from creating two separate `AsyncLocalStorage` instances, which caused `getCurrentAgent().connection` to be `undefined` inside `onChatMessage` and tool `execute` functions.
