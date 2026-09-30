---
"agents": minor
---

Add `agents/tools/testing`, a set of AI SDK tools for breaking an agent's Durable Object on purpose so you can test how it recovers. `createTestingTools()` returns four tools:

- `sleep` waits for a given number of seconds.
- `get_current_time` returns the current time.
- `oom` allocates memory until the isolate hits its 128 MB limit.
- `burn_cpu` spins without yielding to the event loop until the CPU limit terminates the invocation.

`testingPrompts` has a prompt for each case. `testingPrompts.longRunning` keeps one turn running for 30 minutes by alternating `sleep` and `get_current_time`; use `longRunningPrompt({ minutes, sleepSeconds })` to change the timing. Local workerd enforces neither limit, so `oom` and `burn_cpu` stop at the `oomLimitMiB` and `burnCpuMs` bounds there and return a result instead of killing the object.
