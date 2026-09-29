# Vue WebSocket chat

A minimal Vue client that connects AI SDK `useChat` directly to a Cloudflare
`AIChatAgent` over WebSockets, without React.

## Run locally

From this directory:

```bash
pnpm install
pnpm run start
```

The example uses a remote Workers AI binding, so Wrangler may ask you to log in.
No API key is required.

## Client

`AgentClient` owns the WebSocket connection. The framework-neutral transport
adapts that connection to the AI SDK interface consumed by Vue's `useChat`:

```ts
import { useChat } from "@ai-sdk/vue";
import { AgentClient } from "agents/client";
import { WebSocketChatTransport } from "agents/chat/transport";

const agent = new AgentClient({
  agent: "ChatAgent",
  name: crypto.randomUUID(),
  host: window.location.host
});

const { messages, sendMessage, status } = useChat({
  transport: new WebSocketChatTransport({
    agent,
    cancelOnClientAbort: true
  })
});
```

The minimal transport entry supports new and regenerated turns plus stream
cancellation. This example starts a fresh thread on each page load because it
does not hydrate persisted messages. Automatic stream resume, cross-tab
transcript synchronization, and client-side tool continuations remain
coordinated by React's `useAgentChat`; this example intentionally does not claim
those behaviors.

See [`examples/ai-chat`](../ai-chat/) for the full React integration, including
tools, approvals, transcript synchronization, and resumable streams.
