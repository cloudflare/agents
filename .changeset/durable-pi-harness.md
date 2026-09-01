---
"agents": minor
---

Add the experimental `agents/harness` and `agents/providers/pi` entry points. `PiHarness` installs pi's durable agent harness as a Lifecycle capability, stores its Session in Durable Object SQLite, resolves tool definitions before each owned drive pass, and keeps accepted operations moving through Lifecycle jobs after eviction. `createWorkersAI` adapts a Workers AI binding for pi, while `prompt()` returns the durable operation with display-ready transcript messages.
