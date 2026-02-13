# Resumable Streaming

The `AIChatAgent` class provides **automatic resumable streaming** out of the box. When a client disconnects and reconnects during an active stream, the response automatically resumes from where it left off.

## How It Works

When you use `AIChatAgent` with `useAgentChat`:

1. **During streaming**: All chunks are automatically persisted to SQLite
2. **On disconnect**: The stream continues server-side, buffering chunks
3. **On reconnect**: Client requests a resume, receives all buffered chunks, and continues streaming

No extra code is needed -- it just works.

## Example

### Server

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages } from "ai";

export class ChatAgent extends AIChatAgent {
  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      messages: await convertToModelMessages(this.messages)
    });

    // Automatic resumable streaming - no extra code needed
    return result.toUIMessageStreamResponse();
  }
}
```

### Client

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({
    agent: "ChatAgent",
    name: "my-chat"
  });

  const { messages, sendMessage, status } = useAgentChat({
    agent
    // resume: true is the default - streams automatically resume on reconnect
  });

  // ... render your chat UI
}
```

## Under the Hood

### Server-side (`AIChatAgent`)

- Creates SQLite tables for stream chunks and metadata on construction
- Each stream gets a unique ID and tracks chunk indices
- Chunks are batched (every 10 chunks) and flushed to SQLite for performance
- When a client sends `CF_AGENT_STREAM_RESUME_REQUEST`, the server checks for active streams and responds with `CF_AGENT_STREAM_RESUMING`
- Stale streams (older than 5 minutes) are cleaned up on restore
- Completed streams older than 24 hours are periodically garbage collected

### Client-side (`useAgentChat`)

- After the message handler is registered in `useEffect`, sends `CF_AGENT_STREAM_RESUME_REQUEST` to the server
- This avoids a race condition where the server's `onConnect` notification could arrive before the client's handler is ready
- On receiving `CF_AGENT_STREAM_RESUMING`, sends `CF_AGENT_STREAM_RESUME_ACK`
- Receives all buffered chunks with `replay: true` flag and applies them in a single batch
- Continues receiving live chunks as they arrive from the ongoing stream

### The `replay` flag

Replayed chunks include `replay: true` to distinguish them from live chunks. The client uses this to batch-apply all replayed chunks before rendering, which prevents intermediate states (like reasoning "Thinking..." indicators) from flashing briefly during replay. During a live stream, chunks arrive gradually and React renders each intermediate state naturally.

## Disabling Resume

If you do not want automatic resume (for example, for short responses), disable it:

```tsx
const { messages } = useAgentChat({
  agent,
  resume: false // Disable automatic stream resumption
});
```

## Try It

See [examples/resumable-stream-chat](../examples/resumable-stream-chat) for a complete working example. Start a long response, refresh the page mid-stream, and watch it resume automatically.

## Related Docs

- [Chat Agents](./chat-agents.md) — Full `AIChatAgent` and `useAgentChat` reference
- [Client Tools Continuation](./client-tools-continuation.md) — Client-side tool execution and auto-continuation
