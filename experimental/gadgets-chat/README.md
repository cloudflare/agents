# Chat Rooms — Multiple Conversations via Facets

A traditional chat app with rooms — each room is a **facet** with its own isolated SQLite and conversation history. Create rooms, switch between them, clear or delete them. All under a single Durable Object.

## How It Works

```
  OverseerAgent (parent DO — owns room registry)
    ├── facet("room-abc123")  →  ChatRoom (own SQLite, own messages)
    ├── facet("room-def456")  →  ChatRoom (own SQLite, own messages)
    └── facet("room-ghi789")  →  ChatRoom (own SQLite, own messages)
```

- **OverseerAgent** manages the room list (create, rename, delete) in its own SQLite. It forwards chat messages to the active room's facet.
- **ChatRoom** (facet) stores messages and calls the LLM in its own isolated context. Each room has a completely separate conversation — switching rooms loads a different history from a different SQLite.
- Deleting a room calls `ctx.facets.delete()` — the facet and its storage are gone.

## Interesting Files

### `src/server.ts`

- **`ChatRoom`** — plain DurableObject with `chat()`, `getMessages()`, `clearMessages()`. Each instance is a facet with its own SQLite.
- **`OverseerAgent._room(id)`** — `ctx.facets.get("room-${id}", ...)` creates/gets a named facet per room.
- **`createRoom` / `deleteRoom` / `switchRoom` / `clearRoom`** — `@callable()` methods the client invokes via `agent.call()`.
- **`onChatMessage()`** — extracts user text, forwards to `this._room(activeId).chat(text)`, returns the response.
- **`_syncState()`** — reads rooms from parent SQLite, message counts + messages from facets, broadcasts to all clients.

### `src/client.tsx`

- **`RoomSidebar`** — lists rooms with message counts, hover actions (clear, delete), "New" button.
- **`RoomMessages`** — displays messages from the facet state (not useAgentChat — we show the facet's persisted messages).
- Room switching calls `agent.call("switchRoom", [id])` + `clearHistory()` to reset the chat UI.

## Quick Start

```bash
npm start
```

## Try It

1. Click **New** to create a room
2. Type a message — it goes to that room's facet
3. Create another room, switch to it — empty conversation
4. Switch back — previous conversation is still there (persisted in the facet's SQLite)
5. **Clear** empties a room's messages, **Delete** removes the room and its facet entirely
