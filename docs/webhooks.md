# Webhooks

Receive webhook events from external services and route them to dedicated agent instances. Each webhook source (repository, customer, device) can have its own agent with isolated state, persistent storage, and real-time client connections.

## Quick Start

```typescript
import { Agent, getAgentByName, routeAgentRequest } from "agents";

// Agent that handles webhooks for a specific entity
export class WebhookAgent extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Verify the webhook signature
    const signature = request.headers.get("X-Hub-Signature-256");
    const body = await request.text();

    if (
      !(await this.verifySignature(body, signature, this.env.WEBHOOK_SECRET))
    ) {
      return new Response("Invalid signature", { status: 401 });
    }

    // Process the webhook payload
    const payload = JSON.parse(body);
    await this.processEvent(payload);

    return new Response("OK", { status: 200 });
  }

  private async verifySignature(
    payload: string,
    signature: string | null,
    secret: string
  ): Promise<boolean> {
    if (!signature) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(payload)
    );
    const expected = `sha256=${Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;

    return signature === expected;
  }

  private async processEvent(payload: unknown) {
    // Store event, update state, trigger actions...
  }
}

// Route webhooks to the right agent instance
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Webhook endpoint: POST /webhooks/:entityId
    if (url.pathname.startsWith("/webhooks/") && request.method === "POST") {
      const entityId = url.pathname.split("/")[2];
      const agent = await getAgentByName(env.WebhookAgent, entityId);
      return agent.fetch(request);
    }

    // Default routing for WebSocket connections
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
```

## Use Cases

Webhooks combined with agents enable powerful patterns where each external entity gets its own isolated, stateful agent instance.

### Developer Tools

| Use Case                 | Description                                                                |
| ------------------------ | -------------------------------------------------------------------------- |
| **GitHub Repo Monitor**  | One agent per repository tracking commits, PRs, issues, and stars          |
| **CI/CD Pipeline Agent** | React to build/deploy events, notify on failures, track deployment history |
| **Linear/Jira Tracker**  | Auto-triage issues, assign based on content, track resolution times        |

### E-commerce & Payments

| Use Case                   | Description                                                           |
| -------------------------- | --------------------------------------------------------------------- |
| **Stripe Customer Agent**  | One agent per customer tracking payments, subscriptions, and disputes |
| **Shopify Order Agent**    | Order lifecycle from creation to fulfillment with inventory sync      |
| **Payment Reconciliation** | Match webhook events to internal records, flag discrepancies          |

### Communication & Notifications

| Use Case             | Description                                                             |
| -------------------- | ----------------------------------------------------------------------- |
| **Twilio SMS/Voice** | Conversational agents triggered by inbound messages or calls            |
| **Slack Bot**        | Respond to slash commands, button clicks, and interactive messages      |
| **Email Tracking**   | SendGrid/Mailgun delivery events, bounce handling, engagement analytics |

### IoT & Infrastructure

| Use Case              | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| **Device Telemetry**  | One agent per device processing sensor data streams          |
| **Alert Aggregation** | Collect alerts from PagerDuty, Datadog, or custom monitoring |
| **Home Automation**   | React to IFTTT/Zapier triggers with persistent state         |

### SaaS Integrations

| Use Case             | Description                                                     |
| -------------------- | --------------------------------------------------------------- |
| **CRM Sync**         | Salesforce/HubSpot contact and deal updates                     |
| **Calendar Agent**   | Google Calendar event notifications and scheduling              |
| **Form Submissions** | Typeform, Tally, or custom form webhooks with follow-up actions |

## Routing Webhooks to Agents

The key pattern is extracting an entity identifier from the webhook and using `getAgentByName()` to route to a dedicated agent instance.

### Extract Entity from Payload

Most webhooks include an identifier in the payload:

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      const payload = await request.clone().json();

      // Extract entity ID from payload
      const repoFullName = payload.repository?.full_name;
      if (!repoFullName) {
        return new Response("Missing repository", { status: 400 });
      }

      // Sanitize for use as agent name
      const agentName = repoFullName.toLowerCase().replace(/\//g, "-");

      // Route to dedicated agent
      const agent = await getAgentByName(env.RepoAgent, agentName);
      return agent.fetch(request);
    }
  }
};
```

### Extract Entity from URL

Alternatively, include the entity ID in the webhook URL:

```typescript
// Webhook URL: https://your-worker.dev/webhooks/stripe/cus_123456
if (url.pathname.startsWith("/webhooks/stripe/")) {
  const customerId = url.pathname.split("/")[3]; // "cus_123456"
  const agent = await getAgentByName(env.StripeAgent, customerId);
  return agent.fetch(request);
}
```

### Extract Entity from Headers

Some services include identifiers in headers:

```typescript
// Slack sends workspace info in headers
const teamId = request.headers.get("X-Slack-Team-Id");
if (teamId) {
  const agent = await getAgentByName(env.SlackAgent, teamId);
  return agent.fetch(request);
}
```

## Signature Verification

Always verify webhook signatures to ensure requests are authentic. Most providers use HMAC-SHA256.

### HMAC-SHA256 Pattern

```typescript
async function verifySignature(
  payload: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload)
  );

  const expected = `sha256=${Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  // Use timing-safe comparison in production
  return signature === expected;
}
```

### Provider-Specific Headers

| Provider | Signature Header        | Algorithm                    |
| -------- | ----------------------- | ---------------------------- |
| GitHub   | `X-Hub-Signature-256`   | HMAC-SHA256                  |
| Stripe   | `Stripe-Signature`      | HMAC-SHA256 (with timestamp) |
| Twilio   | `X-Twilio-Signature`    | HMAC-SHA1                    |
| Slack    | `X-Slack-Signature`     | HMAC-SHA256 (with timestamp) |
| Shopify  | `X-Shopify-Hmac-Sha256` | HMAC-SHA256 (base64)         |

## Processing Webhooks

### The onRequest Handler

Use `onRequest()` to handle incoming webhooks in your agent:

```typescript
export class WebhookAgent extends Agent<Env, MyState> {
  async onRequest(request: Request): Promise<Response> {
    // 1. Validate method
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // 2. Get event type from headers
    const eventType = request.headers.get("X-Event-Type");

    // 3. Verify signature
    const signature = request.headers.get("X-Signature");
    const body = await request.text();

    if (!(await this.verifySignature(body, signature))) {
      return new Response("Invalid signature", { status: 401 });
    }

    // 4. Parse and process
    const payload = JSON.parse(body);
    await this.handleEvent(eventType, payload);

    // 5. Respond quickly
    return new Response("OK", { status: 200 });
  }

  private async handleEvent(type: string, payload: unknown) {
    // Update state (broadcasts to connected clients)
    this.setState({
      ...this.state,
      lastEventType: type,
      lastEventTime: new Date().toISOString()
    });

    // Store in SQL for history
    this
      .sql`INSERT INTO events (type, payload, timestamp) VALUES (${type}, ${JSON.stringify(payload)}, ${Date.now()})`;
  }
}
```

## Storing Webhook Events

Use SQLite to persist webhook events for history and replay.

### Event Table Schema

```typescript
async onStart(): Promise<void> {
  this.sql`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      action TEXT,
      title TEXT NOT NULL,
      description TEXT,
      url TEXT,
      actor TEXT,
      payload TEXT,
      timestamp TEXT NOT NULL
    )
  `;

  this.sql`
    CREATE INDEX IF NOT EXISTS idx_events_timestamp
    ON events(timestamp DESC)
  `;
}
```

### Cleanup Old Events

Prevent unbounded growth by keeping only recent events:

```typescript
// Keep last 100 events
this.sql`
  DELETE FROM events WHERE id NOT IN (
    SELECT id FROM events ORDER BY timestamp DESC LIMIT 100
  )
`;

// Or delete events older than 30 days
this.sql`
  DELETE FROM events 
  WHERE timestamp < datetime('now', '-30 days')
`;
```

### Query Events

```typescript
@callable()
getEvents(limit = 20) {
  return [...this.sql`
    SELECT * FROM events
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `];
}

@callable()
getEventsByType(type: string, limit = 20) {
  return [...this.sql`
    SELECT * FROM events
    WHERE type = ${type}
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `];
}
```

## Real-time Broadcasting

When a webhook arrives, update agent state to automatically broadcast to connected WebSocket clients.

```typescript
// In your agent
private async processWebhook(eventType: string, payload: WebhookPayload) {
  // Update state - this automatically broadcasts to all connected clients
  this.setState({
    ...this.state,
    stats: payload.stats,
    lastEvent: {
      type: eventType,
      timestamp: new Date().toISOString()
    }
  });
}
```

On the client side:

```typescript
import { useAgent } from "agents/react";

function Dashboard() {
  const [state, setState] = useState(null);

  const agent = useAgent({
    agent: "webhook-agent",
    name: "my-entity-id",
    onStateUpdate: (newState) => {
      setState(newState); // Automatically updates when webhooks arrive
    }
  });

  return <div>Last event: {state?.lastEvent?.type}</div>;
}
```

## Patterns

### Event Deduplication

Prevent processing duplicate events using event IDs:

```typescript
async handleEvent(eventId: string, payload: unknown) {
  // Check if already processed
  const existing = [...this.sql`
    SELECT id FROM events WHERE id = ${eventId}
  `];

  if (existing.length > 0) {
    console.log(`Event ${eventId} already processed, skipping`);
    return;
  }

  // Process and store
  await this.processPayload(payload);
  this.sql`INSERT INTO events (id, ...) VALUES (${eventId}, ...)`;
}
```

### Respond Quickly, Process Asynchronously

Webhook providers expect fast responses. Use the queue for heavy processing:

```typescript
async onRequest(request: Request): Promise<Response> {
  const payload = await request.json();

  // Quick validation
  if (!this.isValid(payload)) {
    return new Response("Invalid", { status: 400 });
  }

  // Queue heavy processing
  await this.queue("processWebhook", payload);

  // Respond immediately
  return new Response("Accepted", { status: 202 });
}

async processWebhook(payload: WebhookPayload) {
  // Heavy processing happens here, after response sent
  await this.enrichData(payload);
  await this.notifyDownstream(payload);
  await this.updateAnalytics(payload);
}
```

### Multi-Provider Routing

Handle webhooks from multiple services in one worker:

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST") {
      // GitHub webhooks
      if (url.pathname.startsWith("/webhooks/github/")) {
        const payload = await request.clone().json();
        const repoName = payload.repository?.full_name?.replace("/", "-");
        const agent = await getAgentByName(env.GitHubAgent, repoName);
        return agent.fetch(request);
      }

      // Stripe webhooks
      if (url.pathname.startsWith("/webhooks/stripe/")) {
        const payload = await request.clone().json();
        const customerId = payload.data?.object?.customer;
        const agent = await getAgentByName(env.StripeAgent, customerId);
        return agent.fetch(request);
      }

      // Slack webhooks
      if (url.pathname === "/webhooks/slack") {
        const teamId = request.headers.get("X-Slack-Team-Id");
        const agent = await getAgentByName(env.SlackAgent, teamId);
        return agent.fetch(request);
      }
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

## Sending Outgoing Webhooks

Agents can also send webhooks to external services:

```typescript
export class NotificationAgent extends Agent<Env> {
  async notifySlack(message: string) {
    const response = await fetch(this.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message })
    });

    if (!response.ok) {
      throw new Error(`Slack notification failed: ${response.status}`);
    }
  }

  async sendSignedWebhook(url: string, payload: unknown) {
    const body = JSON.stringify(payload);
    const signature = await this.sign(body, this.env.WEBHOOK_SECRET);

    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": signature
      },
      body
    });
  }
}
```

## Security Best Practices

1. **Always verify signatures** - Never trust unverified webhooks
2. **Use environment secrets** - Store secrets with `wrangler secret put`, not in code
3. **Respond quickly** - Return 200/202 within seconds to avoid retries
4. **Validate payloads** - Check required fields before processing
5. **Log rejections** - Track invalid signatures for security monitoring
6. **Use HTTPS** - Webhook URLs should always use TLS

```typescript
// Store secrets securely
// wrangler secret put GITHUB_WEBHOOK_SECRET

// Access in agent
const secret = this.env.GITHUB_WEBHOOK_SECRET;
```

## Complete Example

See the [GitHub Webhook Dashboard](../examples/github-webhook) for a full implementation featuring:

- HMAC-SHA256 signature verification
- Agent-per-repository routing
- SQLite event storage
- Real-time WebSocket broadcasting
- React dashboard with live updates

### Architecture

```
GitHub                          Cloudflare Worker                    Client
  │                                    │                               │
  │  POST /webhooks/github             │                               │
  │  X-Hub-Signature-256: sha256=...   │                               │
  │  {"repository": {"full_name": ...}}│                               │
  │ ──────────────────────────────────>│                               │
  │                                    │                               │
  │                            ┌───────┴───────┐                       │
  │                            │ Verify sig    │                       │
  │                            │ Extract repo  │                       │
  │                            │ getAgentByName│                       │
  │                            └───────┬───────┘                       │
  │                                    │                               │
  │                            ┌───────┴───────┐                       │
  │                            │  RepoAgent    │                       │
  │                            │ (per repo)    │                       │
  │                            │               │                       │
  │                            │ • Update state│──── WebSocket ───────>│
  │                            │ • Store event │                       │
  │                            │ • Broadcast   │                       │
  │                            └───────────────┘                       │
  │                                    │                               │
  │<─────────── 200 OK ────────────────│                               │
```

## Common Webhook Providers

| Provider | Documentation                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| GitHub   | [Webhook events and payloads](https://docs.github.com/en/webhooks)                                           |
| Stripe   | [Webhook signatures](https://stripe.com/docs/webhooks/signatures)                                            |
| Twilio   | [Validate webhook requests](https://www.twilio.com/docs/usage/webhooks/webhooks-security)                    |
| Slack    | [Verifying requests](https://api.slack.com/authentication/verifying-requests-from-slack)                     |
| Shopify  | [Webhook verification](https://shopify.dev/docs/apps/webhooks/configuration/https#step-5-verify-the-webhook) |
| SendGrid | [Event webhook](https://docs.sendgrid.com/for-developers/tracking-events/getting-started-event-webhook)      |
| Linear   | [Webhooks](https://developers.linear.app/docs/graphql/webhooks)                                              |
