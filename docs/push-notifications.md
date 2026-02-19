# Push Notifications

Send browser push notifications from your agent — even when the user has closed the tab. By combining the agent's persistent state (for storing push subscriptions), scheduling (for timed delivery), and the [Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), you can reach users who are completely offline.

## How It Works

```
Browser                              Agent (Durable Object)
───────                              ──────────────────────
1. Register service worker
2. Subscribe to push (VAPID key)
3. Send subscription to agent ──────► Store in this.state
4. Create reminder ─────────────────► this.schedule(delay, "sendReminder", payload)

   ... user closes tab ...

5.                                    Alarm fires → sendReminder()
                                      web-push sends encrypted payload
                                              │
6. Service worker receives push ◄─────────────┘
7. showNotification()
```

The agent stores push subscriptions durably in its state and uses `this.schedule()` to fire notifications at the right time. When the alarm triggers, the agent calls the push service endpoint using the [`web-push`](https://www.npmjs.com/package/web-push) library. The browser's service worker receives the push event and displays a native notification.

## Prerequisites

### Generate VAPID Keys

Web Push requires a VAPID (Voluntary Application Server Identification) key pair. Generate one:

```bash
npx web-push generate-vapid-keys
```

Store the keys in a `.env` file for local development:

```
VAPID_PUBLIC_KEY=BGxK...
VAPID_PRIVATE_KEY=abc1...
VAPID_SUBJECT=mailto:you@example.com
```

For production, use `wrangler secret put`:

```bash
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_SUBJECT
```

## Create the Agent

The agent has three responsibilities: store push subscriptions, schedule reminders, and send notifications when alarms fire.

```typescript
import { Agent, callable, routeAgentRequest } from "agents";
import webpush from "web-push";

type Subscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

type Reminder = {
  id: string;
  message: string;
  scheduledAt: number;
  sent: boolean;
};

type ReminderAgentState = {
  subscriptions: Subscription[];
  reminders: Reminder[];
};

export class ReminderAgent extends Agent<Env, ReminderAgentState> {
  initialState: ReminderAgentState = {
    subscriptions: [],
    reminders: []
  };

  @callable()
  getVapidPublicKey(): string {
    return this.env.VAPID_PUBLIC_KEY;
  }

  @callable()
  async subscribe(subscription: Subscription): Promise<{ ok: boolean }> {
    const exists = this.state.subscriptions.some(
      (s) => s.endpoint === subscription.endpoint
    );
    if (!exists) {
      this.setState({
        ...this.state,
        subscriptions: [...this.state.subscriptions, subscription]
      });
    }
    return { ok: true };
  }

  @callable()
  async unsubscribe(endpoint: string): Promise<{ ok: boolean }> {
    this.setState({
      ...this.state,
      subscriptions: this.state.subscriptions.filter(
        (s) => s.endpoint !== endpoint
      )
    });
    return { ok: true };
  }

  @callable()
  async createReminder(
    message: string,
    delaySeconds: number
  ): Promise<Reminder> {
    const id = crypto.randomUUID();
    const scheduledAt = Date.now() + delaySeconds * 1000;
    const reminder: Reminder = { id, message, scheduledAt, sent: false };

    this.setState({
      ...this.state,
      reminders: [...this.state.reminders, reminder]
    });

    await this.schedule(delaySeconds, "sendReminder", { id, message });

    return reminder;
  }
```

When the scheduled alarm fires, send the push notification to all stored subscriptions:

```typescript
  async sendReminder(payload: { id: string; message: string }) {
    webpush.setVapidDetails(
      this.env.VAPID_SUBJECT,
      this.env.VAPID_PUBLIC_KEY,
      this.env.VAPID_PRIVATE_KEY
    );

    const deadEndpoints: string[] = [];

    await Promise.all(
      this.state.subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            sub,
            JSON.stringify({
              title: "Reminder",
              body: payload.message,
              tag: `reminder-${payload.id}`
            })
          );
        } catch (err: unknown) {
          const statusCode =
            err instanceof webpush.WebPushError ? err.statusCode : 0;
          if (statusCode === 404 || statusCode === 410) {
            deadEndpoints.push(sub.endpoint);
          }
        }
      })
    );

    // Clean up expired or revoked subscriptions
    if (deadEndpoints.length > 0) {
      this.setState({
        ...this.state,
        subscriptions: this.state.subscriptions.filter(
          (s) => !deadEndpoints.includes(s.endpoint)
        )
      });
    }

    // Mark reminder as sent
    this.setState({
      ...this.state,
      reminders: this.state.reminders.map((r) =>
        r.id === payload.id ? { ...r, sent: true } : r
      )
    });

    // Notify any connected clients in real time
    this.broadcast(
      JSON.stringify({
        type: "reminder_sent",
        id: payload.id,
        timestamp: Date.now()
      })
    );
  }
}
```

The `sendReminder` callback handles three things: delivering the push notification via the `web-push` library, cleaning up dead subscriptions (the push service returns 404 or 410 when a subscription is no longer valid), and broadcasting to any connected clients so the UI updates in real time.

## Set Up the Service Worker

The service worker runs in the browser and receives push events even when no tabs are open. Place this file at `public/sw.js` so it is served from the root of your domain:

```javascript
self.addEventListener("push", (event) => {
  if (!event.data) return;

  const data = event.data.json();

  event.waitUntil(
    self.registration.showNotification(data.title || "Notification", {
      body: data.body || "",
      icon: data.icon || "/favicon.ico",
      tag: data.tag,
      data: data.data
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow("/");
    })
  );
});
```

The `push` event handler parses the JSON payload and displays a native notification. The `notificationclick` handler focuses an existing tab or opens a new one when the user taps the notification.

## Build the Client

The client needs to: register the service worker, request notification permission, subscribe to push using the VAPID public key, and send the subscription to the agent.

### Register the Service Worker

```typescript
useEffect(() => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return; // Push not supported
  }

  navigator.serviceWorker.register("/sw.js");
}, []);
```

### Subscribe to Push

Fetch the VAPID public key from the agent, then subscribe through the Push API:

```typescript
function base64urlToUint8Array(base64url: string): Uint8Array {
  const padded = base64url + "=".repeat((4 - (base64url.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function subscribeToPush(agent) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;

  const vapidPublicKey = await agent.call("getVapidPublicKey");
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64urlToUint8Array(vapidPublicKey).buffer
  });

  const subJson = subscription.toJSON();
  await agent.call("subscribe", [
    {
      endpoint: subJson.endpoint,
      expirationTime: subJson.expirationTime ?? null,
      keys: subJson.keys
    }
  ]);
}
```

### Create Reminders

With the subscription stored, creating a reminder is a single RPC call. The agent handles scheduling and delivery:

```typescript
await agent.call("createReminder", ["Check the oven", 300]);
```

The agent schedules an alarm for 300 seconds (5 minutes). When it fires, the push notification arrives — even if the user closed the tab minutes ago.

## Configuration

### wrangler.jsonc

```jsonc
{
  "name": "push-notifications",
  "compatibility_date": "2026-01-28",
  "compatibility_flags": ["nodejs_compat"],
  "main": "src/server.ts",
  "durable_objects": {
    "bindings": [{ "name": "ReminderAgent", "class_name": "ReminderAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ReminderAgent"] }],
  "assets": {
    "not_found_handling": "single-page-application"
  }
}
```

The `nodejs_compat` compatibility flag is required for the `web-push` library.

### Dependencies

```bash
npm install agents web-push
```

## Production Considerations

### Subscription Expiry

Push subscriptions can expire or be revoked by the user. Always handle 404 and 410 responses from the push service by removing the dead subscription from state, as shown in the `sendReminder` example above.

### Per-User vs Shared Agents

For most applications, use one agent per user (using the user ID as the agent name). This isolates each user's subscriptions and reminders. For broadcast-style notifications (same message to many users), a shared agent can store all subscriptions, but be aware of the state size as the subscription list grows.

### Combining Push with WebSocket Broadcast

Use `this.broadcast()` for clients that are currently connected (instant, no push service roundtrip) and Web Push for clients that are offline. The `sendReminder` example above does both — connected clients get a real-time WebSocket message, and offline clients get a push notification.

### Multiple Devices

A single user may subscribe from multiple browsers or devices. The agent stores each subscription separately, and `sendReminder` iterates over all of them. Each device receives its own push notification.

### Retry on Failure

If the push service returns a 5xx error (temporary failure), you can retry using `this.schedule()` with a short delay:

```typescript
try {
  await webpush.sendNotification(sub, payload);
} catch (err: unknown) {
  const statusCode = err instanceof webpush.WebPushError ? err.statusCode : 0;
  if (statusCode >= 500) {
    await this.schedule(60, "retrySendNotification", {
      endpoint: sub.endpoint,
      payload
    });
  }
}
```

## Full Example

See the complete working example at [`examples/push-notifications/`](../examples/push-notifications/) — includes the agent, service worker, and a React client with subscription management, reminder creation, and real-time state sync.
