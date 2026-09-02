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

`create()`, `list()`, and `setMetadata()` never wake a target; `get()` returns an initialized typed stub; `delete()` hides the entry, condemns the target through Agent's deferred teardown, then drops the row, so a failed call is retryable and a clean teardown never surfaces as an abort error. Requests and WebSocket upgrades under `/agents/user-agent/{user}/chats/{id}` are forwarded to the target with the suffix preserved, and the target owns the upgraded socket, so chat frames never wake the user hub. Physical Durable Object names are opaque UUIDs held only in the catalog. `create()` returns the same JSON round-trip of `metadata` that `list()` does, and `list()` breaks equal-timestamp ties by write order rather than by the random entry ID — derived from a `MAX(seq)` read of the route's own entries each write, a deliberate trade for a route sized like one owner's catalog: DO SQLite bills ~1000 writes for the cost of 1000 reads, so this is cheaper than a maintained counter row (or an index on `seq`, which would cost a write on every call too) until a route holds several thousand entries.

Destroying the hub retries condemning every remaining entry (active or still `deleting`) before its own storage is wiped — this is best-effort, not a durability guarantee: the platform wipes the hub's storage right after disposal regardless of outcome, so a target still unreachable after retries is orphaned, with no catalog row left to retry from later. That tradeoff is documented on the class and in the docs.

Two documented sharp edges: pick a route that can't collide with the hub's own path segments (a coincidental match with no active entry behind it 404s instead of reaching the hub), and a routed suffix can't address a target's own dynamic agents — `Agent.fetch()` resolves a `/sub/{class}/{name}` marker against the hub's exported classes before this capability ever sees the request, so it is served as a facet of the hub instead of being forwarded. Both are called out on the class and in the docs; the second is pinned by a regression test.

`examples/next/chats` is rebuilt on `RoutedAgents`: the hub creates, lists, searches, and deletes chats through the capability, the browser reaches each chat through the hub's route, a failed `init()` handshake rolls back the catalog entry instead of leaving an ownerless chat, malformed message bodies get a `400` instead of an uncaught exception, and pushed activity is fenced by each message's own strictly-increasing ordinal (not a wall-clock timestamp, which can tie within a millisecond and silently discard a genuinely newer push) inside `blockConcurrencyWhile`, so neither a delayed push nor two concurrent ones can overwrite one that already landed.

`Lifecycle.use()` accepts `{ fallback: true }` to dispatch a capability after every non-fallback one regardless of installation order. `Agent` installs its WebSockets capability as a fallback, so middleware a subclass installs from its constructor runs before the upgrade catch-all.
