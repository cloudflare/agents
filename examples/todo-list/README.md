# Todo List

A classic Todo list application demonstrating the Cloudflare Agents sync layer for real-time state synchronization across multiple browser windows.

## Features

- ✅ Add, edit, complete, and delete todos
- 🔄 Real-time state synchronization across multiple windows
- 🎯 Filter by all, active, or completed todos
- 🧹 Clear all completed todos
- ✨ Toggle all todos at once
- 💾 Persistent state using Durable Objects

## How It Works

This example showcases the **sync layer** of Cloudflare Agents, which enables automatic state synchronization between the server and all connected clients. When you make changes in one browser window, they instantly appear in all other open windows.

### Key Concepts

1. **Agent State Management**: The `TodoAgent` class extends the base `Agent` class and defines a typed state with todos and filter settings.

2. **State Synchronization**: Changes to state via `this.setState()` are automatically broadcast to all connected clients through WebSocket connections.

3. **React Integration**: The `useAgent` hook from `agents/react` connects your React component to the agent and receives state updates in real-time.

4. **Callable Methods**: Methods decorated with `@callable()` can be invoked remotely from the client using `agent.call()`.

## Quick Start

```bash
npm install && npm start
```

Visit http://localhost:5173 to see the app.

## Testing State Sync

1. Open the app in multiple browser windows side by side
2. Add a todo in one window - it appears in all windows instantly
3. Complete a todo in another window - the checkbox updates everywhere
4. Try filtering, editing, or clearing completed todos - all changes sync in real-time

## Code Structure

- **`src/server.ts`**: TodoAgent class with state management and callable methods
- **`src/client.tsx`**: React UI using the `useAgent` hook for state synchronization
- **`src/styles.css`**: Classic TodoMVC styling
- **`wrangler.jsonc`**: Cloudflare Workers configuration with Durable Objects bindings

## Learn More

- [Agents Documentation](https://developers.cloudflare.com/agents/)
- [State Management Guide](../../packages/agents/README.md)
- [useAgent Hook API](../../packages/agents/src/react.tsx)
