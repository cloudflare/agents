---
"agents": patch
---

Add `sessionAffinity` getter to `Agent` base class for Workers AI prefix-cache optimization. Returns the Durable Object ID, which is globally unique and stable per agent instance. Pass it as the `sessionAffinity` option when creating a Workers AI model to route requests from the same agent to the same backend replica.
