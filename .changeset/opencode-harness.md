---
"agents": patch
---

Add `agents/harness/opencode`, a beta `OpenCodeHarness` that hosts OpenCode v2 (`@opencode/sdk/workerd`) in a Durable Object behind the same interface as `PiHarness`. OpenCode's tables are kept under an `opencode_` prefix, a Lifecycle wake job per session brings runs back after eviction, and the harness closes OpenCode when it is idle so the object can hibernate. Add `agents/models/opencode`, whose `createAI({ binding })` returns an OpenCode plugin that serves Workers AI models through the `AI` binding.
