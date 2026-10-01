---
"agents": minor
---

Add `agents/tools/testing`, a toolbox for breaking an agent's Durable Object mid-turn so you can test how it recovers. It has no dependencies, so any harness can wrap it in its own tool format:

- `fillMemory(signal?)` fills an in-memory buffer until the isolate exceeds its 128 MB memory limit.
- `burnCpu(response, signal?)` hashes a response body. Give it an endless one, such as a `fetch()` of an endpoint that serves `generateBytes()`, and the invocation runs until it exceeds its CPU limit. CPU spent between reads counts toward the limit even though each read waits on I/O.
- `sleep(seconds, signal?)` and `currentTime()` drive long turns.
- `longRunningPrompt()` alternates `sleep` and `current_time` for 30 minutes, twice the alarm wall-time limit. `crashPrompt("oom" | "burn_cpu")` calls a crash tool between two other tool calls. Both end with `secondaryTask`, a follow-up whose answer a test can check.

`agents/tools/testing/ai` wraps these as AI SDK tools: `createTestingTools()` returns `sleep`, `current_time`, `oom`, and `burn_cpu`, with names that match the prompts.

Local workerd enforces neither the memory nor the CPU limit, so `fillMemory` and `burnCpu` only kill a deployed Durable Object. Locally they run until aborted.
