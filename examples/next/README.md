# Next examples

Early-access examples for APIs being introduced across a short stack of Agents
SDK pull requests. Keeping them under `examples/next` avoids presenting the new
composition patterns as part of the current stable examples before the stack
lands.

| Example                                                  | Status    | Demonstrates                                                                                                                                   |
| -------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`lifecycle`](./lifecycle)                               | Available | A plain `DurableObject` composed with `Lifecycle` and a reusable capability                                                                    |
| [`schedules`](./schedules)                               | Available | `Scheduler` installed as a reusable lifecycle capability                                                                                       |
| [`queue`](./queue)                                       | This PR   | Durable background work: `Queue` installed as a reusable lifecycle capability                                                                  |
| [`tasks`](./tasks)                                       | This PR   | Durable replayable `Tasks` installed as a reusable lifecycle capability                                                                        |
| [`streams`](./streams)                                   | This PR   | Durable `Streams` composed with `Tasks`, served over SSE                                                                                       |
| [`sessions`](./sessions)                                 | This PR   | Durable message trees, streamed reads, and Sessions-owned attachments                                                                          |
| [`websockets`](./websockets)                             | This PR   | One plain `DurableObject`, `useAgent` over the WebSocket or Cap'n Web transport, callables on every wire, hibernating connections and tags     |
| [`mcp-client`](./mcp-client)                             | Available | `MCPClientManager` installed as a reusable lifecycle capability                                                                                |
| [`routing`](./routing)                                   | This PR   | `RoutedAgents` on a plain `DurableObject` hub: one Agent per chat, a per-user catalog with push-based metadata, forwarded requests and sockets |
| [`dynamic-agents`](./dynamic-agents)                     | This PR   | A supervisor runs user-submitted code as facets: isolated storage, supervised abort, code upgrades over stable state                           |
| [`harnesses/codex`](./harnesses/codex)                   | This PR   | A static Codex Rust/Wasm loop composed as a Lifecycle capability, using LanguageModelV4 and Shell Workspace                                    |
| [`harnesses/pi`](./harnesses/pi)                         | This PR   | Experimental: pi-durable sessions on `agents/harness/pi`, with Workspace tools and a JavaScript `exec` from `@cloudflare/computer`             |
| [`harnesses/think`](./harnesses/think)                   | This PR   | Experimental: Think's agent loop on a plain `DurableObject` with `agents/harness/think`, served to `useAgentChat` by `ThinkChat`               |
| [`harnesses/self-modifying`](./harnesses/self-modifying) | This PR   | A Lifecycle capability runs editable harness revisions in fresh Dynamic Workers with trusted System tools and auto-discovered Custom tools     |
| [`models`](./models)                                     | This PR   | One `createAI` per framework (AI SDK and pi-ai): `@cf/` ids for Workers AI, vendor models routed through AI Gateway                            |
| [`channels`](./channels)                                 | This PR   | Agents on different harnesses served through `Channels.forHarness` and one `ChannelGateway`, to a browser client and terminal clients          |

Each example is an independent workspace package and should stay focused on one
capability. Once the APIs are stable, move the examples into the main examples
catalog or replace an existing example where appropriate.
