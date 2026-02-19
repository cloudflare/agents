# Push Notification Reminders

Schedule reminders that arrive as browser push notifications — even when the tab is closed. Demonstrates how the Agents SDK's persistent state and scheduling combine naturally with the Web Push API.

## How it works

1. The **client** registers a service worker and subscribes to push notifications
2. The **agent** stores the push subscription in its state and schedules reminders using `this.schedule()`
3. When an alarm fires, the agent sends a push notification via the `web-push` library — no open tab required
4. The **service worker** receives the push event and displays a native notification

## Setup

Generate VAPID keys:

```bash
npm run generate-vapid-keys
```

Copy the output into a `.env` file (or `.dev.vars`):

```
VAPID_PUBLIC_KEY=BGxK...
VAPID_PRIVATE_KEY=abc1...
VAPID_SUBJECT=mailto:you@example.com
```

Install and run:

```bash
npm install
npm run start
```

## Key SDK features used

- **`this.schedule(delaySeconds, callback, payload)`** — fires reminders at the right time, even after restarts
- **`this.state` / `this.setState()`** — persists push subscriptions and reminder list across hibernation
- **`@callable`** — exposes agent methods to the client over WebSocket
- **`this.broadcast()`** — notifies connected clients in real time when a reminder fires
