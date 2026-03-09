---
"agents": patch
---

Embed sub-agent (facet) API into the Agent base class. Adds `subAgent()`, `abortSubAgent()`, and `deleteSubAgent()` methods directly on `Agent`, replacing the experimental `withSubAgents` mixin. Uses composite facet keys for class-aware naming, guards scheduling and `keepAlive` in facets, and persists the facet flag to storage so it survives hibernation.
