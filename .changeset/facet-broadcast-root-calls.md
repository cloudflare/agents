---
"agents": patch
---

Sub-agent broadcasts cost at most one root call, and none when nobody would receive them. Outside the client frame that started the work, every facet broadcast used to resolve the root through `getAgentByName()` (an `__unsafe_ensureInitialized` round trip) before calling `_cf_broadcastToSubAgent`, so a streamed answer made two billed root requests per chunk. The root endpoints facets call now start the root's lifecycle themselves, so facets use a plain stub, and a root that was evicted still runs `onStart()` before serving the call. A facet also skips the root entirely when its hydrated connection mirror shows no connection outside `without`; until the mirror is hydrated, broadcasts route to the root as before.
