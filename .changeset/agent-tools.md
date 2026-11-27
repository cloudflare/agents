---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Agent tools and sub-agents.

- `Think.startAgentToolRun` takes an optional `signal`.
- A run cut off by a parent reset re-attaches to its child and ends once, or `interrupted` after 2 s, and a throwing `onAgentToolFinish` goes to `onError`.
- A run whose child cannot stay up ends `error`, and a detached run without progress ends `interrupted`, not `running` (#3073, #2467).
- A given-up detached run is no longer re-armed forever, and `onMilestones` gets a milestone reached before finishing (#2769, #3278).
- Runs wait for their child's recovery and start in order, and aged-media eviction runs for every sub-agent (#3024, #3144, #2974).
- Many sub-agents started at once no longer stall, and their work resumes when the root restarts (#3077, #3014, #3086).
- Sub-agents work under a jurisdiction, keep socket frames in order, and no longer reset their tree's storage when upgrading old chat tables (#3085, #3181, #3215, #3192).
- An `AIChatAgent` agent-tool run is its chat turn: one durable run, so a reset of the child resumes it and a cancel ends it at once, whatever the turn is doing. Runs a released version kept are carried forward, and a run in flight across the upgrade carries on.
