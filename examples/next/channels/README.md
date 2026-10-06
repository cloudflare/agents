# Channels

Agents served to browsers and terminals through Channels. The Worker serves
one agent class per harness, and any client can talk to either.

Every agent has the same shape:

1. A **harness** keeps the agent's conversations and transcripts and runs
   each message.
2. `Channels.forHarness(harness, { channels: { web: new WebChannel() } })`
   serves each harness session as a conversation through the Web Channel.
3. The Worker's **`ChannelGateway`** routes each WebSocket upgrade to the
   agent that holds the conversation.

| Path                               | Agent        | Harness                                                          |
| ---------------------------------- | ------------ | ---------------------------------------------------------------- |
| `/channels/pi/<room>[/<conv>]`     | `PiAgent`    | `PiHarness` from `agents/harness/pi`, behind `piChannelsHarness` |
| `/channels/ai-sdk/<room>[/<conv>]` | `AiSdkAgent` | `AiSdkHarness` from `agents/harness/ai-sdk`                      |

## Files

- `src/server.ts` is the Worker. It builds a `ChannelGateway` whose `agent`
  picks the Durable Object namespace from the first segment of the route, so
  one Worker serves several agent classes. Its `web` resolver lets the client
  name itself with `?as=`, which only a demo should trust.
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

## The pi agent

`PiHarness` keeps pi's own shape. `piChannelsHarness(harness, { kv })`,
also from `agents/harness/pi`, is the harness adapter that puts it behind
the shared harness interface: pi events become session events, and pi
submission ids become the caller's operation ids. pi entries and messages
become transcript messages and response chunks through the pi projection
(`agents/experimental/channels/projections/pi`). `Channels.forHarness`
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
