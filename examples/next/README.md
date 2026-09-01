# Next examples

Early-access examples for APIs being introduced across a short stack of Agents
SDK pull requests. Keeping them under `examples/next` avoids presenting the new
composition patterns as part of the current stable examples before the stack
lands.

| Example                              | Status    | Demonstrates                                                                                                         |
| ------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------- |
| [`lifecycle`](./lifecycle)           | Available | A plain `DurableObject` composed with `Lifecycle` and a reusable capability                                          |
| [`schedules`](./schedules)           | Available | `Scheduler` installed as a reusable lifecycle capability                                                             |
| [`tasks`](./tasks)                   | This PR   | Durable replayable `Tasks` installed as a reusable lifecycle capability                                              |
| [`streams`](./streams)               | This PR   | Durable `Streams` composed with `Tasks`, served over SSE                                                             |
| [`mcp-client`](./mcp-client)         | Available | `MCPClientManager` installed as a reusable lifecycle capability                                                      |
| [`chats`](./chats)                   | This PR   | One DO per chat + a per-user push-based index — the recommended many-chats pattern                                   |
| [`dynamic-agents`](./dynamic-agents) | This PR   | A supervisor runs user-submitted code as facets: isolated storage, supervised abort, code upgrades over stable state |
| [`harness/pi`](./harness/pi)         | This PR   | Pi `AgentHarness`, Workers AI, and dynamic tools in a Lifecycle Object                                               |

Each example is an independent workspace package and should stay focused on one
capability. Once the APIs are stable, move the examples into the main examples
catalog or replace an existing example where appropriate.
