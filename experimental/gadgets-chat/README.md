# Chat Rooms — Multiple Conversations via Sub-Agents

A chat app with rooms where each room is a **sub-agent** with its own isolated SQLite and conversation history. Create rooms, switch between them, and stream LLM responses — all under a single Durable Object.

## How It Works

```
OverseerAgent (extends Agent)
  ├── Room registry (own SQLite)
  ├── Per-connection routing via connection.setState({ activeRoomId })
  │
  ├── this.subAgent(ChatRoom, "room-abc")  →  own SQLite, own LLM calls
  ├── this.subAgent(ChatRoom, "room-def")  →  own SQLite, own LLM calls
  └── this.subAgent(ChatRoom, "room-ghi")  →  own SQLite, own LLM calls
```

- **OverseerAgent** manages the room list and routes chat messages to the active room's sub-agent
- **ChatRoom** stores messages and streams LLM responses via `toUIMessageStream()` — each room has a completely independent conversation
- Deleting a room calls `this.deleteSubAgent()` — the sub-agent and its storage are permanently removed
- No mixin needed — `Agent` has `subAgent()` / `deleteSubAgent()` built in

## Key Pattern

```typescript
import { Agent } from "agents";

export class ChatRoom extends Agent<Env> {
  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS messages (...)`;
  }

  async chatStream(
    userMessage: string,
    callback: { onEvent(json: string): void; onDone(msg: ChatMessage): void }
  ) {
    // Store message, load history, stream LLM response via callback
    const result = streamText({ model, messages: history });
    for await (const chunk of result.toUIMessageStream()) {
      await callback.onEvent(JSON.stringify(chunk));
    }
  }
}

export class OverseerAgent extends Agent<Env, RoomsState> {
  async sendMessage(connection: Connection, text: string) {
    const roomId = this._getActiveRoomId(connection);
    const room = await this.subAgent(ChatRoom, `room-${roomId}`);
    await room.chatStream(text, new StreamRelay(connection, requestId));
  }
}
```

The streaming protocol uses `stream-start`, `stream-event` (serialized `UIMessageChunk`), and `stream-done` messages. The client builds a custom `ChatTransport` for the AI SDK's `useChat` hook, with support for request ID correlation, cancel, and stream resumption on room switch.

## Quick Start

```bash
npm start
```

## Try It

1. Click **New** to create a room
2. Type a message — it streams from that room's sub-agent
3. Create another room, switch to it — empty conversation
4. Switch back — previous conversation is still there (persisted in the sub-agent's SQLite)
5. Switch rooms mid-stream — the server keeps generating, and switching back resumes the stream
6. **Clear** empties a room's messages, **Delete** removes the room and its sub-agent entirely

## Related

- [gadgets-subagents](../gadgets-subagents) — fan-out/fan-in with parallel sub-agents
- [gadgets-gatekeeper](../gadgets-gatekeeper) — gated database access via sub-agent boundary
- [gadgets-sandbox](../gadgets-sandbox) — isolated database sub-agent with dynamic Worker isolates
- [design/rfc-sub-agents.md](../../design/rfc-sub-agents.md) — RFC for the sub-agent API
