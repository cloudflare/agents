# Next: routing

An early-access, server-only example showing `RoutedAgents` from
`agents/routing` installed on a plain Cloudflare `DurableObject`. The hub does
not extend `Agent`; its targets do.

```ts
export class NoteAgent extends Agent<Env> {
  // An ordinary top-level Agent: its own storage, alarms, and placement.
}

export class HubObject extends DurableObject<Env> {
  readonly notes = new RoutedAgents<NoteAgent, { title: string }>({
    namespace: this.env.NoteAgent,
    route: "notes"
  });
  readonly lifecycle = Lifecycle.install(this).use(this.notes);

  async onRequest(request: Request) {
    // Catalog CRUD: create(), list(), setMetadata(), delete(), get().
  }
}
```

A hub often owns an open-ended set of independent peers: one Durable Object
per notebook, chat, or document for a user. `RoutedAgents` codifies that
topology as a Lifecycle capability. The hub keeps a durable catalog of public
entry IDs mapped to opaque physical names, and forwards every request and
WebSocket upgrade under one route segment to the selected Agent:

| URL                                         | Handled by                               |
| ------------------------------------------- | ---------------------------------------- |
| `/agents/hub-object/alice`                  | `HubObject` "alice"                      |
| `/agents/hub-object/alice/catalog`          | `HubObject` "alice", catalog CRUD        |
| `/agents/hub-object/alice/notes/{id}`       | the `NoteAgent` behind that entry        |
| `/agents/hub-object/alice/notes/{id}/notes` | same `NoteAgent`, sees the path `/notes` |

What the capability guarantees:

- `create()`, `list()`, and `setMetadata()` touch only the hub's SQLite. No
  target wakes. `list()` orders most-recently-updated first.
- `get(id)` returns an initialized, typed stub for RPC, or `null`. The
  `/catalog/{id}` route uses it to ask the target for its note count.
- A forwarded WebSocket upgrade is answered by the target, which then owns
  the socket. Frames never wake the hub.
- `delete(id)` hides the entry first, condemns the target, then removes the
  row. The target wipes its own storage on its next wake. A failed call
  leaves a hidden row, and calling `delete` again retries.
- Physical names are random UUIDs that never leave the hub. Clients only
  ever see entry IDs.

Two sharp edges to design around:

- **Pick a route that cannot collide.** Forwarding matches every occurrence
  of the route segment in the path, so the hub's own routes live under
  `/catalog`, not `/notes`. A coincidental match with no active entry behind
  it is answered `404` instead of reaching the hub's `onRequest`.
- **A routed suffix cannot address a target's own dynamic agents.** A
  `/sub/{class}/{name}` marker is resolved against the hub's exported classes
  before this capability runs. Reach a target's dynamic agents through a
  direct connection to that target.

For the richer many-chats pattern where targets push metadata back into the
hub's index, see [`../chats`](../chats).

## Run

```sh
pnpm install
pnpm run dev
```

Exercise the hub `alice`:

```sh
# Create two notebooks. No NoteAgent wakes.
curl -X POST http://localhost:8787/agents/hub-object/alice/catalog \
  -H "content-type: application/json" -d '{"title": "work"}'
curl -X POST http://localhost:8787/agents/hub-object/alice/catalog \
  -H "content-type: application/json" -d '{"title": "home"}'

# List entries, most recently updated first.
curl http://localhost:8787/agents/hub-object/alice/catalog

# Write to one notebook through the hub's route. Only that NoteAgent wakes.
curl -X POST http://localhost:8787/agents/hub-object/alice/notes/<id>/notes \
  -H "content-type: application/json" -d '{"text": "buy milk"}'
curl http://localhost:8787/agents/hub-object/alice/notes/<id>/notes

# Rename, inspect via a typed stub, and delete.
curl -X PATCH http://localhost:8787/agents/hub-object/alice/catalog/<id> \
  -H "content-type: application/json" -d '{"title": "errands"}'
curl http://localhost:8787/agents/hub-object/alice/catalog/<id>
curl -X DELETE http://localhost:8787/agents/hub-object/alice/catalog/<id>
```

A WebSocket to `/agents/hub-object/alice/notes/<id>` is answered by that
notebook's Agent, which echoes every frame:

```sh
websocat ws://localhost:8787/agents/hub-object/alice/notes/<id>
```

## Test

```sh
pnpm test
```
