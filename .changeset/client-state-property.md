---
"agents": minor
---

feat: expose readable `state` property on `useAgent` and `AgentClient`

Both `useAgent` (React) and `AgentClient` (vanilla JS) now expose a `state` property that tracks the current agent state. Previously, state was write-only via `setState()` — reading state required manually tracking it through the `onStateUpdate` callback.

**React (useAgent)**

```tsx
const agent = useAgent<GameAgent, GameState>({
  agent: "game-agent",
  name: "room-123"
});

// Read state directly — no need for separate useState + onStateUpdate
return <div>Score: {agent.state?.score}</div>;

// Spread for partial updates — works correctly now
agent.setState({ ...agent.state, score: agent.state.score + 10 });
```

`agent.state` is reactive — the component re-renders when state changes from either the server or client-side `setState()`.

**Vanilla JS (AgentClient)**

```typescript
const client = new AgentClient<GameAgent>({
  agent: "game-agent",
  name: "room-123",
  host: "your-worker.workers.dev"
});

// State updates synchronously on setState and server broadcasts
client.setState({ score: 100 });
console.log(client.state); // { score: 100 }
```

**Backward compatible**

The `onStateUpdate` callback continues to work exactly as before. The new `state` property is additive — it provides a simpler alternative to manual state tracking for the common case.

**Type: `State | undefined`**

State starts as `undefined` and is populated when the server sends state on connect (from `initialState`) or when `setState()` is called. Use optional chaining (`agent.state?.field`) for safe access.
