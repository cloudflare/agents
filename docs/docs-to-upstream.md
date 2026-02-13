# Docs to Upstream

This file tracks documentation in this repo that should be pushed to [developers.cloudflare.com/agents/](https://developers.cloudflare.com/agents/).

## Ready to Upstream

These docs are complete and should be added to the official Cloudflare docs site:

| Doc                                                                | Description                                                              | Priority           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------ |
| [getting-started.md](./getting-started.md)                         | Quick start guide: create project, first agent, React client, deploy     | High               |
| [adding-to-existing-project.md](./adding-to-existing-project.md)   | Adding agents to existing Workers, Hono, with assets, auth patterns      | High               |
| [routing.md](./routing.md)                                         | URL patterns, name resolution, `routeAgentRequest()`, instance naming    | High               |
| [callable-methods.md](./callable-methods.md)                       | `@callable` decorator, RPC, streaming responses, TypeScript integration  | High               |
| [email.md](./email.md)                                             | Email routing with `routeAgentEmail()`, resolvers, secure reply handling | High               |
| [queue.md](./queue.md)                                             | Background task queue with `queue()`, `dequeue()`, `getQueue()`          | High               |
| [observability.md](./observability.md)                             | Tracing and monitoring agent activity                                    | Medium             |
| [workflows.md](./workflows.md)                                     | `AgentWorkflow` class - more detailed than current CF docs               | Medium             |
| [mcp-servers.md](./mcp-servers.md)                                 | Creating MCP servers with `McpAgent`                                     | Medium             |
| [securing-mcp-servers.md](./securing-mcp-servers.md)               | OAuth and authentication for MCP servers                                 | Medium             |
| [mcp-client.md](./mcp-client.md)                                   | Connecting to external MCP servers with `addMcpServer()`                 | Medium             |
| [cross-domain-authentication.md](./cross-domain-authentication.md) | Auth patterns across domains                                             | Medium             |
| [chat-agents.md](./chat-agents.md)                                 | AIChatAgent class and useAgentChat hook — full reference                 | High               |
| [client-tools-continuation.md](./client-tools-continuation.md)     | Client-side tool call handling                                           | Low                |
| [codemode.md](./codemode.md)                                       | Experimental CodeAct pattern                                             | Low (experimental) |
| [resumable-streaming.md](./resumable-streaming.md)                 | Handling interrupted streams                                             | Low                |
| [migration-to-ai-sdk-v5.md](./migration-to-ai-sdk-v5.md)           | AI SDK v5 migration guide                                                | Low                |
| [migration-to-ai-sdk-v6.md](./migration-to-ai-sdk-v6.md)           | AI SDK v6 migration guide                                                | Low                |

## Partially Covered on CF Docs

These topics exist on developers.cloudflare.com but our repo has additional content:

| Doc                                        | What's Different                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| [agent-class.md](./agent-class.md)         | Deep architectural explanation (DO → Server → Agent layers)              |
| [state.md](./state.md)                     | Comprehensive patterns, workflow integration, state vs SQL guidance      |
| [http-websockets.md](./http-websockets.md) | Full lifecycle hooks, connection tags, per-connection state, hibernation |
| [workflows.md](./workflows.md)             | `AgentWorkflow` class details, typed RPC, state sync from workflows      |
| [scheduling.md](./scheduling.md)           | AI-assisted scheduling, comparison table, more patterns (retry, backoff) |
| [client-sdk.md](./client-sdk.md)           | Comprehensive reference, async query, streaming, MCP integration         |

## Notes

- The official CF docs have good coverage of: State Management, Scheduling, Client SDK (`useAgent`, `AgentClient`), WebSockets, HTTP/SSE, AI Models, RAG, Browse the Web, Configuration
- When upstreaming, check if the feature is already partially documented and merge/extend rather than duplicate
- Keep this list updated as docs are pushed upstream
