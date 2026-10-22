# Next examples

Examples that compose capabilities from `agents` on a plain `DurableObject`
with `Lifecycle`, instead of extending the `Agent` class. Rows marked
Experimental use APIs that may change between releases.

| Example                                                  | Status    | Demonstrates                                                                                                                                        |
| -------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`lifecycle`](./lifecycle)                               | Available | A plain `DurableObject` composed with `Lifecycle` and a reusable capability                                                                         |
| [`schedules`](./schedules)                               | Available | `Scheduler` installed as a reusable lifecycle capability                                                                                            |
| [`queue`](./queue)                                       | Available | Durable background work: `Queue` installed as a reusable lifecycle capability                                                                       |
| [`tasks`](./tasks)                                       | Available | Durable replayable `Tasks` installed as a reusable lifecycle capability                                                                             |
| [`streams`](./streams)                                   | Available | Durable `Streams` composed with `Tasks`, served over SSE                                                                                            |
| [`sessions`](./sessions)                                 | Available | Durable message trees, streamed reads, and Sessions-owned attachments                                                                               |
| [`websockets`](./websockets)                             | Available | One plain `DurableObject`, `useAgent` over the WebSocket or Cap'n Web transport, callables on every wire, hibernating connections and tags          |
| [`mcp-client`](./mcp-client)                             | Available | `MCPClientManager` installed as a reusable lifecycle capability                                                                                     |
| [`routing`](./routing)                                   | Available | `RoutedAgents` on a plain `DurableObject` hub: one Agent per chat, a per-user catalog with push-based metadata, forwarded requests and sockets      |
| [`dynamic-agents`](./dynamic-agents)                     | Available | A supervisor runs user-submitted code as facets: isolated storage, supervised abort, code upgrades over stable state                                |
| [`harnesses/codex`](./harnesses/codex)                   | Available | A static Codex Rust/Wasm loop composed as a Lifecycle capability, using LanguageModelV4 and Shell Workspace                                         |
| [`harnesses/opencode`](./harnesses/opencode)             | Available | Experimental: OpenCode v2 sessions on `agents/harness/opencode`, with Workspace tools from `@cloudflare/computer` and Workers AI over the binding   |
| [`harnesses/pi`](./harnesses/pi)                         | Available | pi-durable sessions on `agents/harness/pi`, with Workspace tools and a JavaScript `exec` from `@cloudflare/computer`                                |
| [`harnesses/think`](./harnesses/think)                   | Available | Experimental: Think's agent loop on a plain `DurableObject` with `agents/harness/think`, served to `useAgentChat` by `ThinkChat`                    |
| [`harnesses/container`](./harnesses/container)           | Available | Experimental: Claude Code or Codex in a Cloudflare Container, driven from a Durable Object by `agents/harness/container`, resumed across containers |
| [`harnesses/self-modifying`](./harnesses/self-modifying) | Available | A Lifecycle capability runs editable harness revisions in fresh Dynamic Workers with trusted System tools and auto-discovered Custom tools          |
| [`models`](./models)                                     | Available | One `createAI` per framework (AI SDK and pi-ai): `@cf/` ids for Workers AI, vendor models routed through AI Gateway                                 |
| [`channels`](./channels)                                 | Available | Agents on different harnesses served through `Channels.forHarness` and one `ChannelGateway`, to a browser client and terminal clients               |

Each example is an independent workspace package and should stay focused on one
capability. Once the APIs are stable, move the examples into the main examples
catalog or replace an existing example where appropriate.
