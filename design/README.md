# Design

This folder documents design decisions, tradeoffs, and rationale across the Agents SDK repository and its libraries. It covers software architecture, API design, visual/UI choices, and anything else where we made a deliberate decision worth recording.

The goal is to give contributors (and future-us) a quick way to understand _why_ things are the way they are, without having to reverse-engineer intent from code or PR history.

## Contents

| File                                                                             | Scope                                                                         |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [think.md](./think.md)                                                           | Think — chat agent base class, sessions, streaming, tools, execution ladder   |
| [visuals.md](./visuals.md)                                                       | UI component library choice, Kumo usage, custom patterns                      |
| [readonly-connections.md](./readonly-connections.md)                             | Readonly connection enforcement, storage, tradeoffs, and caveats              |
| [workspace.md](./workspace.md)                                                   | Workspace — hybrid SQLite+R2 filesystem, bash, symlinks                       |
| [agent-tools.md](./agent-tools.md)                                               | Agent tools — chat sub-agent orchestration, parent registry, replay           |
| [sub-agent-routing.md](./sub-agent-routing.md)                                   | Sub-agent routing as shipped — facets, nested URLs, registry, parent lookup   |
| [rfc-sub-agents.md](./rfc-sub-agents.md)                                         | RFC: Sub-agents — child DOs via facets, typed stubs, mixin API                |
| [rfc-helper-sub-agent-orchestration.md](./rfc-helper-sub-agent-orchestration.md) | RFC: Agent tool orchestration — `runAgentTool`, `agentTool`, event forwarding |
| [loopback.md](./loopback.md)                                                     | Loopback pattern — cross-boundary RPC for sub-agents and dynamic isolates     |
