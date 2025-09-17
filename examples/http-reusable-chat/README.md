# HTTP Reusable Chat Example

This example demonstrates the new HTTP-based reusable streams implementation for the Agents SDK. It drops WebSockets in favor of HTTP requests for better AI SDK compatibility and implements a "poke and pull" pattern for real-time updates.

## Key Features

- **HTTP-Only Communication**: No WebSocket dependencies, pure HTTP requests
- **Resumable Streams**: Streams can be resumed from exact positions after interruption
- **Message Persistence**: Full message history persistence following AI SDK patterns
- **"Poke and Pull" Updates**: Real-time updates via HTTP polling instead of WebSockets
- **Single Player Mode**: No broadcast functionality, focused on individual user experience
- **AI SDK v5 Compatibility**: Full compatibility with AI SDK streaming patterns

## Architecture

### Server Side (`AIHttpChatAgent`)

- **HTTP Endpoints**:
  - `GET /messages` - Retrieve paginated message history
  - `POST /chat` - Send message and get streaming response
  - `GET /stream/{streamId}` - Resume interrupted stream
  - `POST /stream/{streamId}/cancel` - Cancel active stream
  - `GET /stream/{streamId}/status` - Get stream status
  - `DELETE /messages` - Clear message history

- **Stream Persistence**: Streams are persisted to SQLite with position tracking
- **Automatic Cleanup**: Old completed streams are automatically cleaned up

### Client Side (`useAgentChatHttp`)

- **Polling-Based Updates**: Uses configurable polling interval for real-time updates
- **Stream Management**: Track active streams with resume/cancel capabilities
- **Backward Compatibility**: Drop-in replacement for existing `useAgentChat` usage

## Setup

1. Copy `.dev.vars.example` to `.dev.vars` and add your OpenAI API key:

   ```bash
   cp .dev.vars.example .dev.vars
   # Edit .dev.vars and add your OPENAI_API_KEY
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the development server:

   ```bash
   npm run dev
   ```

4. Open your browser to `http://localhost:5175` to see the HTML client

## Testing Resumable Streams

1. Click "Test Long Story" to populate a message that will generate a long response
2. Send the message and observe the streaming response
3. Refresh the page during streaming to test resumption
4. Use the stream controls to resume or cancel active streams

## Usage Patterns

### Basic HTTP Chat Agent

```typescript
import { AIHttpChatAgent } from "agents/ai-chat-agent-http";

export class MyHttpChatAgent extends AIHttpChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          messages: convertToModelMessages(this.messages),
          model: openai("gpt-4o-mini"),
          onFinish
        });
        writer.merge(result.toUIMessageStream());
      }
    });
    return createUIMessageStreamResponse({ stream });
  }
}
```

### React Hook Usage

```typescript
import { useAgentChatHttp } from "agents/use-agent-chat-http";

function ChatComponent() {
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    activeStreams,
    resumeStream,
    cancelStream,
    clearHistory
  } = useAgentChatHttp({
    agentUrl: "http://localhost:5175/MyHttpChatAgent/chat",
    pollingInterval: 2000, // Poll every 2 seconds
    enableResumableStreams: true
  });

  return (
    <div>
      {/* Chat UI */}
      {activeStreams.map(stream => (
        <div key={stream.streamId}>
          Stream {stream.streamId}: {stream.completed ? 'Complete' : 'Active'}
          <button onClick={() => resumeStream(stream.streamId)}>Resume</button>
          <button onClick={() => cancelStream(stream.streamId)}>Cancel</button>
        </div>
      ))}
    </div>
  );
}
```

## Benefits Over WebSocket Implementation

1. **Better AI SDK Compatibility**: Direct HTTP streaming aligns with AI SDK patterns
2. **Simpler Deployment**: No WebSocket infrastructure requirements
3. **Resumable Streams**: Built-in stream resumption capabilities
4. **Stateless Scaling**: HTTP-based architecture scales better
5. **Debugging**: Easier to debug HTTP requests vs WebSocket messages
6. **Caching**: HTTP responses can be cached and optimized

## Limitations

- **Polling Overhead**: Real-time updates require periodic polling
- **Latency**: Slight delay in updates compared to WebSocket push notifications
- **Single Player**: No multi-user broadcast functionality (by design)

## Migration from WebSocket Implementation

The HTTP implementation is designed as a drop-in replacement:

```typescript
// Before (WebSocket)
import { useAgentChat } from "agents/ai-react";
const chat = useAgentChat({ agent });

// After (HTTP)
import { useAgentChatHttp } from "agents/use-agent-chat-http";
const chat = useAgentChatHttp({
  agentUrl: "http://localhost:5175/MyAgent/chat",
  enableResumableStreams: true
});
```

The API surface is nearly identical, with additional stream management capabilities.
