# A2A Agent

Exposes a Cloudflare Agent as an [A2A protocol](https://a2a-protocol.org/) server with a browser-based A2A client UI.

## What this shows

- **Agent Card discovery** at `/.well-known/agent-card.json`
- **JSON-RPC transport** (`message/send`, `message/stream`) via the `@a2a-js/sdk` server
- **SSE streaming** for real-time task status updates
- **DO-backed TaskStore** using Durable Object SQLite for persistent task state
- **Workers AI** (GLM 4.7 Flash) for actual AI responses

## Run it

```sh
npm install
npm start
```

Open [http://localhost:5173](http://localhost:5173) to use the chat UI.

Any A2A client can discover this agent:

```sh
curl http://localhost:5173/.well-known/agent-card.json
```

## Key pattern

The server uses the SDK's `DefaultRequestHandler` + `AgentExecutor` to avoid hand-rolling A2A protocol logic:

```typescript
class AIAgentExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus) {
    // Publish task → working status → AI response → completed status
    bus.publish(initialTask);
    bus.publish(workingStatus);

    const result = await generateText({ model, messages });

    bus.publish(responseMessage);
    bus.publish(completedStatus);
    bus.finished();
  }
}

const handler = new DefaultRequestHandler(agentCard, taskStore, executor);
const transport = new JsonRpcTransportHandler(handler);
```

Tasks are persisted in Durable Object SQLite via a custom `TaskStore` implementation.

## Related

- [A2A Protocol docs](https://a2a-protocol.org/latest/)
- [a2a-js SDK](https://github.com/a2aproject/a2a-js)
- [AI Chat example](../ai-chat/) — similar AI agent using `@cloudflare/ai-chat`
