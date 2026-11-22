---
"@cloudflare/think": minor
---

Scheduled tasks from `getScheduledTasks()` move to new storage, and existing task rows migrate forward on first start. `getScheduledTasksScope()` is removed, so sub-agents never arm declared tasks. See [Scheduled tasks](https://developers.cloudflare.com/agents/api-reference/think/#scheduled-tasks).
