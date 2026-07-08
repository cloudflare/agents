---
"agents": minor
---

Extract Agent scheduling into the `AgentScheduler` lifecycle component and publish it from `agents/schedules`. Existing Agent scheduling methods remain compatible delegators, and the previous `agents/schedule` parser entry point remains available as a deprecated compatibility re-export.
