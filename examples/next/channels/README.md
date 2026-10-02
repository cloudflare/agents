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

| Path                               | Agent        | Harness                                     |
| ---------------------------------- | ------------ | ------------------------------------------- |
| `/channels/ai-sdk/<room>[/<conv>]` | `AiSdkAgent` | `AiSdkHarness` from `agents/harness/ai-sdk` |

## Files

- `src/server.ts` is the Worker. It builds a `ChannelGateway` whose `agent`
  picks the Durable Object namespace from the first segment of the route, so
  one Worker serves several agent classes. Its `web` resolver lets the client
  name itself with `?as=`, which only a demo should trust.
- `src/ai-sdk-agent.ts` is `AiSdkAgent`: `AiSdkHarness` runs each message
  with `streamText` on Workers AI. It has a client tool (`getLocation`, run
  by the participant who asked) and a tool that needs approval (`flipCoin`).
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
