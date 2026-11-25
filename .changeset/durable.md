---
"agents": patch
"@cloudflare/think": patch
---

Fibers, schedules, background jobs and workflows.

- Fibers run as Task runs; `runFiber()`, `startFiber()` and the fiber methods are unchanged. See [Durable execution](https://github.com/cloudflare/agents/blob/main/docs/agents/durable-execution.md).
- A fiber whose recovery hook crashes the isolate no longer takes the agent down (#2970).
- `destroy()` called from a scheduled callback sticks (#3083).
- `getSchedule()` and `getSchedules()` work in a sub-agent instead of throwing (#3020).
- A background job that keeps failing reaches `onJobError` instead of retrying forever or blocking other work (#3022, #3023, #3032).
- Jobs pushed inside a sub-agent now run, and pending work survives a dropped alarm (#2977, #3012).
- A rolled-back transaction no longer breaks later job writes (#3007), and a job whose capability a deploy dropped is kept for the deploy that restores it (#3025).
- Retry delays (fiber recovery, chat recovery, Tasks `backoff: "exponential"`, Think's notification retries) are jittered, so work that failed together does not retry together.
- `keepAlive()` and `keepAliveWhile()` hold the object awake with one background job instead of a schedule heartbeat.
- Work cut off by a reset resumes within 5 seconds instead of 30 (#3028).
- An `AgentWorkflow` run survives an Agent reset between steps (#3052), and `approveWorkflow()` and `rejectWorkflow()` no longer go through an overridden `sendWorkflowEvent()`.
