# Next examples

Early-access examples for APIs being introduced across a short stack of Agents
SDK pull requests. Keeping them under `examples/next` avoids presenting the new
composition patterns as part of the current stable examples before the stack
lands.

| Example                      | Status    | Demonstrates                                                                |
| ---------------------------- | --------- | --------------------------------------------------------------------------- |
| [`lifecycle`](./lifecycle)   | Available | A plain `DurableObject` composed with `Lifecycle` and a reusable capability |
| [`schedules`](./schedules)   | Available | `Scheduler` installed as a reusable lifecycle capability                    |
| [`tasks`](./tasks)           | This PR   | Durable replayable `Tasks` installed as a reusable lifecycle capability     |
| [`mcp-client`](./mcp-client) | Available | `MCPClientManager` installed as a reusable lifecycle capability             |

Each example is an independent workspace package and should stay focused on one
capability. Once the APIs are stable, move the examples into the main examples
catalog or replace an existing example where appropriate.
