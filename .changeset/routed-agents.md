---
"agents": minor
---

Add `RoutedAgents` (`agents/routing`), a Lifecycle capability that codifies the "user hub with one Durable Object per chat" topology: an owning Agent keeps a durable catalog of independent top-level Agents and routes to them by public ID.

```ts
class UserAgent extends Agent<Env> {
  readonly chats = new RoutedAgents<ChatAgent, { title: string }>({
    namespace: this.env.ChatAgent,
    route: "chats"
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.chats);
  }
}
```

`create()`, `list()`, and `setMetadata()` never wake a target; `get()` returns an initialized typed stub; `delete()` hides the entry, condemns the target through Agent's deferred teardown, then drops the row, so a failed call is retryable and a clean teardown never surfaces as an abort error. Requests and WebSocket upgrades under `/agents/user-agent/{user}/chats/{id}` are forwarded to the target with the suffix preserved, and the target owns the upgraded socket, so chat frames never wake the user hub. Physical Durable Object names are opaque UUIDs held only in the catalog.

`examples/next/chats` is rebuilt on `RoutedAgents`: the hub creates, lists, searches, and deletes chats through the capability, and the browser reaches each chat through the hub's route.

`Lifecycle.use()` accepts `{ fallback: true }` to dispatch a capability after every non-fallback one regardless of installation order. `Agent` installs its WebSockets capability as a fallback, so middleware a subclass installs from its constructor runs before the upgrade catch-all.
