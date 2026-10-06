# Channels

Agents served to browsers, terminals and ACP clients through Channels. The Worker serves
one agent class per harness, and any client can talk to either.

Every agent has the same shape:

1. A **harness** keeps the agent's conversations and transcripts and runs
   each message.
2. `Channels.forHarness(harness, { channels: { web: new WebChannel() } })`
   serves each harness session as a conversation through the Web Channel.
3. The Worker's **`ChannelGateway`** routes each WebSocket upgrade to the
   agent object its route names, which holds the room's conversations.

| Path                               | Agent        | Harness                                                          |
| ---------------------------------- | ------------ | ---------------------------------------------------------------- |
| `/channels/pi/<room>[/<conv>]`     | `PiAgent`    | `PiHarness` from `agents/harness/pi`, behind `piChannelsHarness` |
| `/channels/ai-sdk/<room>[/<conv>]` | `AiSdkAgent` | `AiSdkHarness` from `agents/harness/ai-sdk`                      |

Each agent also mounts an `AcpChannel` at `/acp/<harness>/<room>`. See
[Use it from an ACP client](#use-it-from-an-acp-client).

## Files

- `src/server.ts` is the Worker. It builds a `ChannelGateway` whose `agent`
  picks the Durable Object namespace from the first segment of the route, so
  one Worker serves several agent classes. Its `web()` Channel lets the
  client name itself with `?as=` and join any room, which only a demo
  should allow: the agent object is the authorization boundary, so whoever
  reaches a room may use every conversation in it. Its `acp()` Channel
  does the same for `/acp/<harness>/<room>`.
- `src/ai-sdk-agent.ts` is `AiSdkAgent`: `AiSdkHarness` runs each message
  with `streamText` on Workers AI. It has a client tool (`getLocation`, run
  by the participant who asked) and a tool that needs approval (`flipCoin`).
- `src/pi/agent.ts` is `PiAgent`: `PiHarness` runs pi-durable sessions with
  a `current_time` tool. See [The pi agent](#the-pi-agent).
- `src/client.tsx` is a browser client built on `WebChannelClient` from
  `agents/experimental/channels/web/client`. The URL hash picks the agent and room
  (`#ai-sdk/lobby`); the harness picker switches between agents.

## Run it

```sh
pnpm install
pnpm start
```

The example uses the remote Workers AI binding. If your Wrangler login has
more than one account, set `CLOUDFLARE_ACCOUNT_ID`.

Open the printed URL. Each browser is its own participant, so it runs only
the `getLocation` calls from its own messages and shows the rest as not its
to run. Messages sent while a turn runs are queued, and Stop cancels the
running turn.

## Chat from a terminal

With the dev server running, in another terminal:

```sh
pnpm tui [room]
```

`src/ai-sdk-tui.ts` runs `@ai-sdk/tui` over `WebChannelChatTransport` from
`agents/experimental/channels/web/ai-sdk`, against the AI SDK agent. The TUI runs
`getLocation` itself and asks for approvals with `y` / `n`. Set
`AGENT_ORIGIN` if the dev server is not on `ws://localhost:5173`. The browser
and the TUI can share a room; each is its own participant.

`pnpm tui2 [harness] [room]` runs the Agents SDK terminal client built on Pi
TUI (`npx agents tui <url>`) against either agent, for example
`pnpm tui2 ai-sdk lobby`. It shows turns started from other surfaces, lets you
provide client-tool results, and can start, fork, list and switch
conversations (`/new`, `/fork`, `/conversations`, `/switch <id>`). A
conversation is also reachable directly at
`/channels/<harness>/<room>/<conversation>`.

## Use it from an ACP client

Both agents also mount an `AcpChannel` from
`agents/experimental/channels/acp`, which speaks the
[Agent Client Protocol](https://agentclientprotocol.com) over a WebSocket.
The Worker's `acp()` Channel takes `/acp/<harness>/<room>` upgrades, and
the gateway names its key in the connection identity, so the agent's
`AcpChannel` mounted under the same key serves them rather than the Web
Channel. An ACP client opens sessions itself, so each ACP session is a
conversation in that room, and the browser and terminal clients see its
turns live.

ACP clients launch agents as local commands that speak JSON-RPC on stdio.
`npx agents acp <url>` bridges stdio to the channel's WebSocket, and
`bin/acp-agent` runs it against the dev server. The script ignores its
arguments and reads `ACP_HARNESS` (`ai-sdk` or `pi`), `ACP_ROOM`,
`ACP_PARTICIPANT` or a full `ACP_URL` from the environment.

- **Zed**: add an `agent_servers` entry whose `command` is the absolute
  path to `bin/acp-agent`.
- **T3 Code**: add an ACP Registry provider, pick any npx registry agent,
  such as Claude Agent, and set **Executable override** to the absolute path
  to `bin/acp-agent`. T3 Code passes the registry agent's arguments, which
  the script ignores.

Tool calls stream as ACP tool calls, and `flipCoin` approvals arrive as
permission requests in the client.

## The pi agent

`PiHarness` keeps pi's own shape. `src/pi/channels-harness.ts`,
`piChannelsHarness(harness, { kv })`, is the harness adapter that puts it
behind the shared harness interface. It only translates shapes: pi entries
become transcript messages, pi events become session events, and pi
submission ids become the caller's operation ids. `Channels.forHarness`
knows nothing about pi:

```ts
readonly channels = Channels.forHarness(
  piChannelsHarness(this.harness, { kv: this.ctx.storage.kv }),
  { channels: { web: new WebChannel() } }
);
```

| Channels                           | Harness                                               |
| ---------------------------------- | ----------------------------------------------------- |
| Conversation                       | Session, with the same id; the default is pi's root   |
| Inbound `message` event            | `session.submit(input, { operationId: eventId })`     |
| Turn                               | One operation; steers get their own turns             |
| Response                           | One per run; turns that join a run share its response |
| Transcript and snapshot            | The session watch's state, then its `message` events  |
| `cancel`                           | `session.abort(turnId)`                               |
| `conversation-create` / `-fork`    | `sessions.create()` / `sessions.fork(id)`             |
| `conversation-reset`               | `session.reset(handoff)`                              |
| `approval-response`, `tool-result` | Rejected: pi-durable has neither yet                  |

Client tools and approvals therefore work only on the AI SDK agent. Try
`pnpm tui2 pi lobby`, ask `What time is it?`, then `/fork`, `/new`, or
`/reset <handoff note>`.
