# Next examples

Examples for the Lifecycle and harness APIs: a plain Durable Object with a
Lifecycle and the capabilities it needs. The repository README teaches this
way of building an agent, and links here for its examples and its Deploy
button. Many of the APIs are still beta or experimental, so the examples stay
under `examples/next` until those APIs are stable.

| Example                                                  | Status    | Demonstrates                                                                                                                                        |
| -------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`quick-start`](./quick-start)                           | Available | The README quick start: Pi on a plain `DurableObject`, kept as a project so CI typechecks it                                                        |
| [`lifecycle`](./lifecycle)                               | Available | A plain `DurableObject` composed with `Lifecycle` and a reusable capability                                                                         |
| [`schedules`](./schedules)                               | Available | `Scheduler` installed as a reusable lifecycle capability                                                                                            |
| [`queue`](./queue)                                       | This PR   | Durable background work: `Queue` installed as a reusable lifecycle capability                                                                       |
| [`tasks`](./tasks)                                       | This PR   | Durable replayable `Tasks` installed as a reusable lifecycle capability                                                                             |
| [`streams`](./streams)                                   | This PR   | Durable `Streams` composed with `Tasks`, served over SSE                                                                                            |
| [`sessions`](./sessions)                                 | This PR   | Durable message trees, streamed reads, and Sessions-owned attachments                                                                               |
| [`websockets`](./websockets)                             | This PR   | One plain `DurableObject`, `useAgent` over the WebSocket or Cap'n Web transport, callables on every wire, hibernating connections and tags          |
| [`mcp-client`](./mcp-client)                             | Available | `MCPClientManager` installed as a reusable lifecycle capability                                                                                     |
| [`routing`](./routing)                                   | This PR   | `RoutedAgents` on a plain `DurableObject` hub: one Agent per chat, a per-user catalog with push-based metadata, forwarded requests and sockets      |
| [`dynamic-agents`](./dynamic-agents)                     | This PR   | A supervisor runs user-submitted code as facets: isolated storage, supervised abort, code upgrades over stable state                                |
| [`harnesses/codex`](./harnesses/codex)                   | This PR   | A static Codex Rust/Wasm loop composed as a Lifecycle capability, using LanguageModelV4 and Shell Workspace                                         |
| [`harnesses/opencode`](./harnesses/opencode)             | This PR   | Experimental: OpenCode v2 sessions on `agents/harness/opencode`, with Workspace tools from `@cloudflare/computer` and Workers AI over the binding   |
| [`harnesses/pi`](./harnesses/pi)                         | This PR   | Experimental: pi-durable sessions on `agents/harness/pi`, with Workspace tools and a JavaScript `exec` from `@cloudflare/computer`                  |
| [`harnesses/think`](./harnesses/think)                   | This PR   | Experimental: Think's agent loop on a plain `DurableObject` with `agents/harness/think`, served to `useAgentChat` by `ThinkChat`                    |
| [`harnesses/container`](./harnesses/container)           | This PR   | Experimental: Claude Code or Codex in a Cloudflare Container, driven from a Durable Object by `agents/harness/container`, resumed across containers |
| [`harnesses/self-modifying`](./harnesses/self-modifying) | This PR   | A Lifecycle capability runs editable harness revisions in fresh Dynamic Workers with trusted System tools and auto-discovered Custom tools          |
| [`models`](./models)                                     | This PR   | One `createAI` per framework (AI SDK and pi-ai): `@cf/` ids for Workers AI, vendor models routed through AI Gateway                                 |
| [`channels`](./channels)                                 | This PR   | Agents on different harnesses served through `Channels.forHarness` and one `ChannelGateway`, to a browser client and terminal clients               |

Each example is an independent workspace package and should stay focused on one
capability. Once the APIs are stable, move the examples into the main examples
catalog or replace an existing example where appropriate.

The README, and the npm page built from it, link to `quick-start`,
`harnesses/pi`, `harnesses/opencode`, `harnesses/container`, `harnesses/codex`,
`schedules`, `sessions`, `mcp-client`, `routing` and `dynamic-agents`. Each
`agents` release freezes its npm page, so those links keep working only while
the paths do. When you move one of these examples, leave a `README.md` at the
old path that links to the new one.
