# Webhooks

Receive webhook events from external services and route them to dedicated agent instances. Each webhook source (repository, customer, device) can have its own agent with isolated state, persistent storage, and real-time client connections.

## Quick Start

```typescript
import { Agent, getAgentByName, routeAgentRequest } from "agents";

type GitHubWebhookPayload = {
  repository?: { full_name?: string };
};

async function verifyGitHubWebhook(
  rawBody: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signatureBytes = Uint8Array.from(
    signature.slice("sha256=".length).match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16)
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encoder.encode(rawBody)
  );
}

export class WebhookAgent extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("X-Hub-Signature-256");
    if (
      !(await verifyGitHubWebhook(rawBody, signature, this.env.WEBHOOK_SECRET))
    ) {
      return new Response("Invalid signature", { status: 401 });
    }

    await this.processEvent(JSON.parse(rawBody));
    return new Response("OK");
  }

  private async processEvent(payload: unknown) {
    // Store event, update state, trigger actions...
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/webhooks/github" && request.method === "POST") {
      const rawBody = await request.clone().text();
      const signature = request.headers.get("X-Hub-Signature-256");
      if (
        !(await verifyGitHubWebhook(rawBody, signature, env.WEBHOOK_SECRET))
      ) {
        return new Response("Invalid signature", { status: 401 });
      }

      const payload = JSON.parse(rawBody) as GitHubWebhookPayload;
      const repository = payload.repository?.full_name;
      if (!repository) {
        return new Response("Missing repository", { status: 400 });
      }

      const agentName = repository.toLowerCase().replace(/\//g, "-");
      const agent = await getAgentByName(env.WebhookAgent, agentName);
      return agent.fetch(request);
    }

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

The key pattern is verifying the raw request before parsing it, then deriving the Agent identity from authenticated payload data. A body signature does not authenticate an unrelated URL segment or arbitrary header.

### Extract Entity from Payload

Most webhooks include an identifier in the payload:

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      const rawBody = await request.clone().text();
      const signature = request.headers.get("X-Hub-Signature-256");
      if (
        !(await verifyGitHubWebhook(rawBody, signature, env.WEBHOOK_SECRET))
      ) {
        return new Response("Invalid signature", { status: 401 });
      }

      const payload = JSON.parse(rawBody) as GitHubWebhookPayload;
      const repository = payload.repository?.full_name;
      if (!repository) {
        return new Response("Missing repository", { status: 400 });
      }

      const agentName = repository.toLowerCase().replace(/\//g, "-");
      const agent = await getAgentByName(env.RepoAgent, agentName);
      return agent.fetch(request);
    }
  }
};
```

### Validate Entity IDs in URLs

A provider's body signature does not authenticate the webhook URL. If the URL includes an entity ID, compare it with the corresponding identity from the verified provider payload and reject a mismatch before calling `getAgentByName()`.

### Derive Slack Identity from the Verified Body

Slack does not send an authenticated `X-Slack-Team-Id` routing header. Validate Slack's timestamped signature and replay window against the raw body, then read `team_id` from the verified event or form body.

## Signature Verification

Always verify webhook signatures before trusting or processing the payload.

### GitHub HMAC-SHA256 Pattern

The Quick Start's `verifyGitHubWebhook()` helper verifies GitHub's `sha256=<hex>` signature over the raw body with `crypto.subtle.verify()`. This format is GitHub-specific. Other providers use different signature encodings, signed inputs, timestamp checks, and replay protections; follow the provider documentation linked under [Common Webhook Providers](#common-webhook-providers).

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

Use `onRequest()` to handle incoming webhooks in your agent. If the Worker has not already verified the request, verify it before parsing the body. This example reuses the Quick Start's `verifyGitHubWebhook()` helper:

```typescript
export class WebhookAgent extends Agent<Env, MyState> {
  async onRequest(request: Request): Promise<Response> {
    // 1. Validate method
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // 2. Get the GitHub event type
    const eventType = request.headers.get("X-GitHub-Event") ?? "unknown";

    // 3. Verify the GitHub signature
    const signature = request.headers.get("X-Hub-Signature-256");
    const body = await request.text();

    if (
      !(await verifyGitHubWebhook(body, signature, this.env.WEBHOOK_SECRET))
    ) {
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

```tsx
import { useAgent } from "agents/react";

function Dashboard() {
  const agent = useAgent({
    agent: "webhook-agent",
    name: "my-entity-id"
  });

  return <div>Last event: {agent.state?.lastEvent?.type}</div>;
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

If the asynchronous work is a single Think chat turn, use
`submitMessages()` instead. It returns a durable submission ID immediately and
lets retries use an idempotency key instead of duplicating the message turn:

```typescript
const submission = await this.submitMessages(messages, {
  idempotencyKey: payload.id
});

return Response.json(
  { submissionId: submission.submissionId },
  { status: 202 }
);
```

If the webhook owns application side effects around a turn, such as restoring a
provider thread and posting a visible reply, use
[`startFiber()`](./durable-execution.md#startfiber) around that job. Managed
fibers retain status, dedupe provider retries, and let `onFiberRecovered()` or
`resolveFiber()` record the app-level recovery outcome.

### Multi-Provider Routing

Keep provider-specific verification and parsing behind one typed seam. Its implementation must validate the raw request according to the provider documentation linked under [Common Webhook Providers](#common-webhook-providers), then derive `agentName` only from the verified body.

```typescript
type VerifiedWebhook =
  | { provider: "github"; agentName: string }
  | { provider: "stripe"; agentName: string }
  | { provider: "slack"; agentName: string };

declare function verifyAndParseWebhook(
  request: Request,
  env: Env
): Promise<VerifiedWebhook | null>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.startsWith("/webhooks/")) {
      const verified = await verifyAndParseWebhook(request.clone(), env);
      if (!verified) {
        return new Response("Invalid signature", { status: 401 });
      }

      switch (verified.provider) {
        case "github":
          return (
            await getAgentByName(env.GitHubAgent, verified.agentName)
          ).fetch(request);
        case "stripe":
          return (
            await getAgentByName(env.StripeAgent, verified.agentName)
          ).fetch(request);
        case "slack":
          return (
            await getAgentByName(env.SlackAgent, verified.agentName)
          ).fetch(request);
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

See the [GitHub Webhook Dashboard](https://github.com/cloudflare/agents/tree/main/examples/github-webhook) for a full implementation featuring:

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
