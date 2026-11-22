---
"agents": major
---

The child of an agent-tool run is now an ordinary Durable Object of its class, not a facet of the parent: declare the class under `durable_objects` and `migrations`, drill in with `useAgent({ path: "agent-tool-runs/<runId>" })`, and reach it from server code with `getAgentToolChild(runId)`. See [Agent tools](https://github.com/cloudflare/agents/blob/main/docs/agents/agent-tools.md#configure-the-child-class).
