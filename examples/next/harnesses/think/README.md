# Think harness

An experimental example of `ThinkHarness` from `agents/harness/think`: Think's
agent loop as a Lifecycle capability on a plain Durable Object, served to
`useAgentChat` by `ThinkChat`.

`src/server.ts` composes four capabilities:

- `Sessions` keeps the transcript.
- `ThinkHarness` runs turns with the AI SDK. It keeps each model call's
  output in storage while it streams, and one Lifecycle job per session wakes
  the object after an eviction.
- `WebSockets` accepts the browser's connection.
- `ThinkChat` speaks Think's `cf_agent_chat_*` protocol over it, so the
  client is the stock `useAgentChat` from `agents/chat/react`.

The tools show the three ways a tool call runs:

| Tool               | Runs                    | After an eviction cuts a call short                |
| ------------------ | ----------------------- | -------------------------------------------------- |
| `getWeather`       | on the server           | runs again, because it carries `recovery: "rerun"` |
| `sendNotification` | on the server, approved | reported to the model as interrupted (the default) |
| `getUserTimezone`  | in the browser          | waits for the browser's result, as it did before   |

## Run locally

```sh
pnpm install
pnpm run start
```

The example uses the remote Workers AI binding and may incur Workers AI
usage. It needs no API key.

## Try

- "What is the weather in Lisbon?" runs a server tool.
- "Notify Sam that lunch is ready" asks for your approval first.
- "What time zone am I in?" runs a tool in the browser.
- Refresh the page while an answer streams. The client reconnects and the
  stream picks up where it was.

## Learn more

- [Think harness docs](../../../../docs/agents/harnesses/think.md)
