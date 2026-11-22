---
"agents": major
---

The child of an agent-tool run is now an ordinary Durable Object of its class, not a facet of the parent: declare the class under `durable_objects` and `migrations`, and drill in with `useAgent({ path: "agent-tool-runs/<runId>" })`. See [Agent tools](https://github.com/cloudflare/agents/blob/main/docs/agents/agent-tools.md#configure-the-child-class).
