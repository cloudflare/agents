# Resumable Streaming

The `AIChatAgent` class provides **automatic resumable streaming** out of the box. When a client disconnects and reconnects during an active stream, the response automatically resumes from where it left off.

## How It Works

When you use `AIChatAgent` with `useAgentChat`:

1. **During streaming**: All chunks are automatically persisted to SQLite
2. **On disconnect**: The stream continues server-side, buffering chunks
3. **On reconnect**: Client receives all buffered chunks and continues streaming

It just works!

## Example

### Server

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const result = streamText({
      model: openai("gpt-4o"),
      messages: this.messages
    });

    // Automatic resumable streaming - no extra code needed!
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

  const { messages, input, handleInputChange, handleSubmit, status } =
    useAgentChat({
      agent
      // resume: true is the default - streams automatically resume on reconnect
    });

  // ... render your chat UI
}
```

## Under the Hood

### Server-side (`AIChatAgent`)

- Creates SQLite tables for stream chunks and metadata on startup
- Each stream gets a unique ID and tracks chunk indices
- Chunks are buffered and flushed to SQLite every 100ms for performance
- On client connect, checks for active streams and sends `CF_AGENT_STREAM_RESUMING`
- Old completed streams are cleaned up after 24 hours

### Client-side (`useAgentChat`)

- Listens for `CF_AGENT_STREAM_RESUMING` notification
- Sends `CF_AGENT_STREAM_RESUME_ACK` when ready
- Receives all buffered chunks and reconstructs the message
- Continues receiving live chunks as they arrive

## Disabling Resume

If you don't want automatic resume (e.g., for short responses), disable it:

```tsx
const { messages } = useAgentChat({
  agent,
  resume: false // Disable automatic stream resumption
});
```

## Try It

See [examples/resumable-stream-chat](../examples/resumable-stream-chat) for a complete working example. Start a long response, refresh the page mid-stream, and watch it resume automatically!
