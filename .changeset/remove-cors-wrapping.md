---
"agents": patch
---

Remove CORS wrapping from `routeAgentRequest` and delegate to partyserver's native CORS support. The `cors` option is now passed directly through to `routePartykitRequest`, which handles preflight and response headers automatically since partyserver 0.1.4.
