---
"agents": patch
---

Added a call to `this.ctx.abort('destroyed')` in the `destroy` method to ensure the agent is properly evicted during cleanup.
