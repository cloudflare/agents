---
"agents": minor
---

Agent Durable Object constructor setup — method wrapping, schema creation, and MCP client manager initialization — now runs inside an `agent_initialization` span, so constructor-time spans group under one stable parent in Workers Observability instead of appearing as top-level clutter. The span records the agent class name, the named instance when the name is readable at construction time, and the operation name. No-op on runtimes without the `tracing` API.
