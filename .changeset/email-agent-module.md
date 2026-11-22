---
"agents": patch
---

Agent's email handling (`_onEmail`, `replyToEmail()`) and `routeAgentEmail()` move into an internal module; `routeAgentEmail` and `EmailRoutingOptions` are still exported from `agents`. There is no API change.
