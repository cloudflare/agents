---
"@cloudflare/think": minor
---

`getScheduledTasks()` runs on the Scheduler's declared schedules and existing task rows migrate forward; `getScheduledTasksScope()` is removed, so sub-agents never arm declared tasks. See [Scheduled tasks](https://developers.cloudflare.com/agents/api-reference/think/#scheduled-tasks).
