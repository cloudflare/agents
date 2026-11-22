# Outbox

Deliver a value somewhere and keep trying until it arrives. An Outbox stores each value under a key, sends it to a named sink from the Durable Object's alarm, and retries with backoff while the sink throws. It survives the object leaving memory.

Use it for notifications that must not be lost: telling a workflow that a request finished, posting a reply to a chat platform, calling another service's webhook.

> **Experimental.** The `Outbox` capability may change between releases.

## Install it

```typescript
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Outbox } from "agents/outbox";

type OrderShipped = { orderId: string; trackingNumber: string };

export class OrderObject extends DurableObject<Env> {
  readonly outbox = new Outbox({
    sinks: {
      shipped: {
        deliver: async (event: OrderShipped, delivery) => {
          const response = await fetch("https://example.com/hooks/shipped", {
            method: "POST",
            headers: { "Idempotency-Key": delivery.idempotencyKey },
            body: JSON.stringify(event)
          });
          if (!response.ok) throw new Error(`webhook ${response.status}`);
        },
        retry: { maxAttempts: 10 }
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.outbox);

  async ship(orderId: string, trackingNumber: string): Promise<void> {
    await this.outbox.send(
      "shipped",
      { orderId, trackingNumber },
      { key: orderId }
    );
  }
}
```

A sink acknowledges a value by returning. A throw fails the attempt and the value is tried again later. Sinks run in host context, so `getCurrentAgent()` returns the object.

## Keys

A delivery is identified by its sink and key. Sending to a key that has not been delivered yet replaces its value: the old value is never delivered, and the new one starts over with a fresh attempt count. Leave out `key` and `send()` generates one, so every send becomes its own delivery.

If a value is replaced while an attempt for it is running, that attempt finishes with the old value and the new value is delivered after it.

Deliveries under different keys are independent. A failing key does not hold up the others, and there is no order between keys.

## Retries and giving up

A failed attempt `n` waits `min(maxDelayMs, baseDelayMs * 2^(n - 1))` before the next one. Delivery gives up after `maxAttempts` attempts, or when the next attempt would start more than `giveUpAfterMs` after the first one.

| Option          | Default    |
| --------------- | ---------- |
| `baseDelayMs`   | 2 seconds  |
| `maxDelayMs`    | 10 minutes |
| `maxAttempts`   | unlimited  |
| `giveUpAfterMs` | 12 hours   |

Set a policy on the `Outbox` (`retry`), on a sink (`retry`), or on one send (`options.retry`). The most specific wins.

When a delivery gives up, its status becomes `failed`, the sink's `onGiveUp(payload, delivery, error)` runs once, and an `outbox:give_up` event is emitted. Failed deliveries stay readable for seven days. `retry(sink, key)` starts one over, and `purge()` deletes them.

## At least once

The Outbox counts an attempt before the sink runs. If the object resets after the sink did its work but before the Outbox recorded the acknowledgement, the sink runs again for the same value. Make sinks idempotent. `delivery.idempotencyKey` is new for every `send()` and the same for every retry of that value. Pass it to a receiver that can drop repeats.

An attempt that brings the object down still counts, so a value that fails that way gives up like any other failing value.

## Holding a value

`send(sink, value, { key, hold: true })` stores a value without delivering it. Use it when you know where a message goes before you know what it says. Two calls release it:

- `release(sink, key, update?)` delivers the held value, or the value `update(held)` returns. The read and the write happen together, so when two callers race to release the same key, one wins and the other gets `false`.
- A `send()` to the same key without `hold` replaces the value and delivers it.

## Values delivered in steps

A sink that delivers one value as several calls can record its progress with `delivery.saveCheckpoint(value)`. The next attempt reads it back as `delivery.checkpoint`:

```typescript
import type { OutboxSink } from "agents/outbox";

const posts: OutboxSink<string[]> = {
  deliver: async (parts, delivery) => {
    let next =
      typeof delivery.checkpoint === "number" ? delivery.checkpoint : 0;
    for (; next < parts.length; next++) {
      await postToThread(parts[next]);
      await delivery.saveCheckpoint(next + 1);
    }
  }
};
```

Sending a new value clears the checkpoint.

## API

| Method                          | Description                                                    |
| ------------------------------- | -------------------------------------------------------------- |
| `send(sink, payload, options?)` | Store a value and deliver it. Options: `key`, `hold`, `retry`. |
| `get(sink, key)`                | Read a delivery. Delivered values are gone.                    |
| `list({ sink?, status? })`      | List deliveries, oldest first.                                 |
| `cancel(sink, key)`             | Drop a delivery, whatever its status.                          |
| `retry(sink, key)`              | Start a failed delivery over.                                  |
| `purge({ before? })`            | Delete failed deliveries.                                      |

Once the Lifecycle has started, `send()` writes its row before it returns its promise, so a send made in the same synchronous block as your own SQL writes commits with them.

Values are JSON and at most 1 MB each.

## What is stored

The first `send()` creates the `cf_agents_outbox` table. Each delivery is a row in it: the value, its key, its status (`pending`, `held` or `failed`), the attempt count, the time of the first attempt and the next one, the last error, and the checkpoint. Each pending delivery has one job in the Lifecycle job queue. Which attempts are running right now is kept in memory only.

## Events

Events go to the `agents:outbox` diagnostics channel: `outbox:send`, `outbox:deliver`, `outbox:retry` (with the attempt, the next attempt time and the error) and `outbox:give_up`. See [Observability](./observability.md).
