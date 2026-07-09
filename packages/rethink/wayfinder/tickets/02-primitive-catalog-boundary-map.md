# Primitive catalog & boundary map (Agent + Think)

Type: research+task
Status: claimed
Blocked by:

Prep asset: [`../02-primitive-catalog-prep.md`](../02-primitive-catalog-prep.md)

## Question

What primitives do the two god classes decompose into, and where do the
boundaries fall?

Turn the god-class inventory into a catalog: for each subsystem in `Agent` and
`Think`, name the primitive it becomes, its responsibility, the storage it owns,
which shared entrypoints it needs, and its dependencies on other primitives.

`Agent` subsystems: state, SQL, migrations, WebSocket/HTTP, RPC/callable methods,
scheduling/alarms, keep-alive leases, fibers, queues, retries, email,
sub-agents/facets, agent-tools, streaming, workflows, MCP client, observability.

`Think` subsystems: message history, config/model/session, inference loop, turn
lifecycle, tools/actions, action ledger, HITL/pending executions, extensions,
skills, channels, sub-agent tools, submissions, declared scheduled tasks,
workflow notifications, chat recovery, context-overflow, auto-continuation,
chat protocol.

This is first-pass boundary-drawing; expect refinement once ticket 01 locks the
model (where a boundary falls depends on how primitives attach). Cross-informs 01.
Produce the catalog as a linked markdown asset under `wayfinder/`.
