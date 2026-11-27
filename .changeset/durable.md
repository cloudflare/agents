---
"agents": patch
"@cloudflare/think": patch
---

Schedules, jobs and workflows.

- Work cut off by a reset resumes within 5 s instead of 30, and survives a dropped alarm (#3028, #2977).
- A failing job no longer retries forever and reaches its `onJobError` (#3022, #3023, #3032, #3025, #3007).
- Jobs and `getSchedule()` work in sub-agents, and `destroy()` from a scheduled callback sticks (#3012, #3020, #3083).
- A crashing fiber recovery hook no longer takes the agent down (#2970).
- `AgentWorkflow` runs and stubs survive an Agent reset, and `approveWorkflow()` and `rejectWorkflow()` skip an overridden `sendWorkflowEvent()` (#3052, #2978).
