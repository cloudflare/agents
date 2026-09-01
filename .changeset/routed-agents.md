---
"agents": minor
---

Add `RoutedAgents` (`agents/routing`), a Lifecycle capability that codifies the "user hub with one Durable Object per chat" topology: an owning Agent keeps a durable catalog of independent top-level Agents and routes to them by public ID.

```ts
class UserAgent extends Agent<Env> {
  readonly chats = this.use(
    new RoutedAgents<ChatAgent, { title: string }>({
      namespace: this.env.ChatAgent,
      route: "chats"
    })
  );
}
```

`create()`, `list()`, and `setMetadata()` never wake a target; `get()` returns an initialized typed stub; `delete()` hides the entry, destroys the target's storage, then drops the row, so a failed destroy is retryable. Requests and WebSocket upgrades under `/agents/user-agent/{user}/chats/{id}` are forwarded to the target with the suffix preserved, and the target owns the upgraded socket, so chat frames never wake the user hub. Physical Durable Object names are opaque UUIDs held only in the catalog.

`Lifecycle.use()` accepts `{ before }` / `{ after }` to position a capability relative to an installed one, and `Agent` gains a protected `use()` helper that installs a capability ahead of its WebSocket fallback.
