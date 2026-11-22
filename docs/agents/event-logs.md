# Event logs

An event log is a numbered, stored list of events that a Durable Object sends to its WebSocket clients. Every event gets the log's next sequence number (`seq`). A client that loses its connection comes back with the last `seq` it applied and receives the events it missed, in order. When those events are gone, the client receives a snapshot to rebuild from instead.

Event logs belong to the [`WebSockets`](./lifecycle.md#websockets-are-an-opt-in-capability) capability. They are experimental and may change between releases.

## Declare a log

Call `log()` on the `WebSockets` capability where you construct it. A client's subscribe frame can wake the object in a fresh isolate, so a log must exist from construction onwards.

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { WebSockets } from "agents/websockets";
import { routeAgentRequest } from "agents";

type Item = { id: string; text: string };

export class Board extends DurableObject<Env> {
  readonly webSockets = new WebSockets();

  readonly items = this.webSockets.log<Item, Item[]>("items", {
    // What a client rebuilds from when it cannot replay.
    snapshot: () => this.listItems()
  });

  readonly lifecycle = Lifecycle.install(this).use(this.webSockets);

  onStart() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, text TEXT)"
    );
  }

  onRequest() {
    return new Response("Not found", { status: 404 });
  }

  addItem(text: string): Item {
    const item = { id: crypto.randomUUID(), text };
    this.ctx.storage.sql.exec(
      "INSERT INTO items (id, text) VALUES (?, ?)",
      item.id,
      item.text
    );
    this.items.publish(item);
    return item;
  }

  listItems(): Item[] {
    return this.ctx.storage.sql
      .exec<Item>("SELECT id, text FROM items")
      .toArray();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

`publish(data)` stores the event, then sends it to every connection following the log, and returns its `seq`. Data must be JSON.

## Follow a log from a client

In React, use `useEventLog` with the agent from `useAgent`:

```tsx
import { useState } from "react";
import { useAgent, useEventLog } from "agents/react";

function BoardView() {
  const agent = useAgent({ agent: "Board", name: "team" });
  const [items, setItems] = useState<Item[]>([]);

  useEventLog<Item, Item[]>(agent, "items", {
    onResync: (snapshot) => setItems(snapshot ?? []),
    onEvent: (item) => setItems((prev) => [...prev, item])
  });

  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.text}</li>
      ))}
    </ul>
  );
}
```

Without React, call `followEventLog` from `agents/client` on an `AgentClient`:

```ts
import { AgentClient, followEventLog } from "agents/client";

const client = new AgentClient({ agent: "Board", name: "team" });
let items: Item[] = [];
const subscription = followEventLog<Item, Item[]>(client, "items", {
  onResync: (snapshot) => {
    items = snapshot ?? [];
  },
  onEvent: (item) => {
    items.push(item);
  }
});

// Later
subscription.close();
```

The handlers:

- `onResync(snapshot, seq)` runs on the first subscription, and whenever the server cannot replay what the client missed. Replace your local state with the snapshot. The snapshot is `undefined` when the log has no `snapshot` option; fetch your own state then.
- `onEvent(data, seq)` runs for every event after that, replayed or live, in `seq` order.
- `onSynced(seq)` runs when a reconnect finished replaying.
- `onError(error)` runs when the server refuses the subscription.

The client keeps its cursor in memory. A page reload starts with `onResync`.

## When a client gets a resync

The server replays from the client's cursor when it can. It sends a resync instead when:

- the client has no cursor yet (its first subscription)
- the cursor is ahead of the log, or from another epoch (the log's storage was deleted and started again)
- the events after the cursor were trimmed by retention
- the client saw events that a crash lost (see [batches](#high-rate-events-batches))

The snapshot is taken in the same synchronous block as the log's head, so the snapshot and the resync's `seq` agree: no event falls between them. Keep `snapshot` synchronous; SQLite reads in a Durable Object are.

## Retention

A log keeps the newest 1,000 events or 4 MiB, whichever is smaller. Change it per log:

```ts
readonly items = this.webSockets.log("items", {
  retention: { maxEvents: 10_000, maxBytes: 16 * 1024 * 1024 }
});
```

Trimming deletes whole stored batches, oldest first, and never the newest one, so a `seq` is never reused.

## High-rate events: batches

Storing every event as its own row is too many writes for a stream of model tokens. Open a batch instead:

```ts
const batch = this.tokens.batch();
for await (const chunk of stream) {
  batch.append(chunk);
}
batch.close();
```

`append` gives the event its `seq` and sends it at once, then stores it with the next write of the buffer. The buffer is written when it holds 10 events or 256 KiB, after 250 ms, when something is published to the same log, and on `close()`. Tune it per log with `batching: { maxEvents, maxBytes, maxDelayMs }`.

A crash loses what is still buffered: at most `maxEvents - 1` events, and at most `maxDelayMs` of output. Live clients may already have seen those events. When the object starts again, the log records the seqs that may have been lost as a gap. Clients that saw a lost event get a resync; clients that did not replay across the gap. Always `close()` a batch, even on error: an unclosed batch makes the next start record a gap.

## Limits

- One event can be at most 1 MiB once serialized. Raise it with `maxEventBytes`, up to 1.9 MB. `publish` and `append` throw for a larger event before giving it a `seq`, so a log never holds part of an event.
- Log names are 1 to 128 characters.
- `canSubscribe: (connection) => boolean` decides which connections may follow a log. By default every connection can.

## What is stored where

| What                                        | Where                                                       | Survives a crash |
| ------------------------------------------- | ----------------------------------------------------------- | ---------------- |
| Published events, the log's epoch           | SQLite (`cf_agents_event_logs`, `cf_agents_event_log_rows`) | Yes              |
| A batch's buffered events                   | Memory                                                      | No               |
| Which logs a connection follows             | The connection's hibernation attachment                     | Yes              |
| A client's cursor and the state built on it | Browser memory                                              | Page reload: no  |

Delivery is at least once across reconnects, in `seq` order. The server keeps no cursor or acknowledgement per client; the client drops any event at or before its cursor.
