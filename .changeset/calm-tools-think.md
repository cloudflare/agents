---
"@cloudflare/think": patch
---

Fix two warnings that misread whether a subclass overrides a Think method. `Agent` copies inherited methods onto the concrete prototype while wrapping them, so the `this.method !== Think.prototype.method` checks always saw an "override". As a result, every skills-enabled agent logged the `getSystemPrompt()` fallback warning even without overriding it, and enabling `contextOverflow.reactive` without a `classifyChatError` override never logged its warning. Think now records the methods each subclass declares before `Agent` wraps them. Both warnings fire only for real overrides, whether they are declared as methods, class fields, or on an intermediate class.
