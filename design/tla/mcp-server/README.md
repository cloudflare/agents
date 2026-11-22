# MCP server models

TLA+ models of the sessionful MCP servers in `packages/agents/src/mcp/server`. They check the places where one HTTP request takes several steps and other requests, a dropped connection or a restart can land between them.

Run them with `everystate`:

```bash
./check.sh
```

Each line names a configuration and the rule it broke, or `holds`. The script exits non-zero when a result is not the expected one.

## The rules

| Model                    | Rule                     | In plain words                                                                                               |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `McpSession`             | `InitReadSeesNothing`    | Reading the stored initialize request during an initialize never finds one, so the read is not needed.       |
| `McpSession`             | `NoLeftovers`            | A session object that holds storage is a session, is scheduled for deletion, or has a request in flight.     |
| `McpSession`             | `TerminatedIsNotServed`  | A message is never handed to a session that a `DELETE` has ended.                                            |
| `McpStream`              | `ResponseNotLost`        | Once the server has a tool's response, the client has it, it is on its way, or a resume can still replay it. |
| `McpStream`              | `StreamEndsWithResponse` | Once the client has the response, no stream for that request stays open.                                     |
| `McpStream`              | `InOrder`                | The client sees a stream's events in order, each once.                                                       |
| `WorkerTransportSession` | `DeletedStaysDeleted`    | A session ended with `DELETE` is not answered for again after the Durable Object restarts.                   |

## Configurations

`session.cfg`, `stream.cfg` and `worker-transport.cfg` describe the code as it is. Every rule holds in them.

The others switch one guard off and must fail. They show which guard keeps which rule:

| Configuration               | Guard switched off                                                                      | Rule that breaks         |
| --------------------------- | --------------------------------------------------------------------------------------- | ------------------------ |
| `session-before-leftovers`  | `McpAgent._admitStreamableHttp` and `_cf_terminateSession` schedule a destroy on a miss | `NoLeftovers`            |
| `session-before-terminated` | `McpAgent.fetch` checks the session in the call that accepts the upgrade                | `TerminatedIsNotServed`  |
| `stream-before-lost`        | `sendOnStream` keeps a finished stream's events for `FINISHED_STREAM_RETENTION_MS`      | `ResponseNotLost`        |
| `stream-before-open`        | the GET bridge in `createStreamingHttpHandler` closes on a frame with `close`           | `StreamEndsWithResponse` |
| `stream-replay-unmarked`    | `handleGetRequest` closes the connection after replaying a finished stream              | `StreamEndsWithResponse` |
| `worker-transport-before`   | `WorkerTransport` stores `closed` on `DELETE` and restores it                           | `DeletedStaysDeleted`    |

`session-before-init-read` is the code before #2814. It holds, which is why that change was safe.

## Known gap

`session-worker-dies` lets the Worker invocation end between its two calls to the object (`getAgentByName`, then `fetch`). `NoLeftovers` breaks: an initialize that dies after the first call leaves an object with tables and no session. `session-one-call-worker-dies` shows the rule holds once a request is a single call. That is not built.

The models also leave out sessions a client abandons without a `DELETE`. Nothing expires them.
