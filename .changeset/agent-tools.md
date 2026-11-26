---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Agent tools and sub-agents.

- An agent-tool run whose child cannot stay up ends `error` instead of staying `running` (#3073).
- A detached agent-tool run given up after its child was torn down now counts as settled, so it is no longer re-armed forever, while a late finish (including a failed-callback retry) is still delivered; `onFinish` gets the give-up once, not also an `aborted` for the cancel the give-up made (#2769). See [Detached (background) runs](https://github.com/cloudflare/agents/blob/main/docs/agents/agent-tools.md#detached-background-runs).
- An awaited agent-tool run cut off by a reset of its parent is run again and re-attaches to its child, so it ends once with the child's result. A run whose child cannot be reached after the reset ends `interrupted` after 2 s. An `onAgentToolFinish` that throws goes to `onError` instead of failing `runAgentTool`.
- A detached agent-tool run whose child never reports progress is given up on after `detachedNoProgressBudgetMs` counted from the run's start, not only after the absolute budget (#2467).
- An agent-tool run whose child's turn was cut off waits for the child's recovery (#3024), and runs started together run in order (#3144).
- `Think.startAgentToolRun` takes an optional `signal`. See [Agent tools](https://developers.cloudflare.com/agents/api-reference/agent-tools/).
- Starting or waking many sub-agents at once no longer stalls after about 14 (#3077).
- A sub-agent's work cut off by a reset resumes as soon as the root restarts (#3014, #3086).
- A sub-agent of an agent addressed in a jurisdiction now reaches that agent (#3085).
- Aged-media eviction runs for every sub-agent (#2974).
- A sub-agent's broadcast followed by a direct send to a connection in the same call reaches that connection in that order (#3181).
- A sub-agent upgraded from a version that kept chat streams in the old `cf_ai_chat_stream_*` tables now empties those tables instead of dropping them, so its first start cannot reset the storage of its agent tree (#3192).
- A sub-agent now handles the frames a client sends over its socket in the order they were sent, also when they arrive right after the socket opens (#3215).
- `clearAgentToolRuns()` now deletes each cleared run's child agent and its storage; before, children whose class came from the Worker's exports were left behind (#3278).
