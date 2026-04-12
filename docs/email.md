# Email Service

Agents can send and receive email with Cloudflare's [Email Service](https://developers.cloudflare.com/email-service/). This guide shows how to send outbound email with the Workers binding, route inbound mail into Agents, and handle follow-up replies securely.

## Prerequisites

Before using email with Agents, you need:

1. A domain onboarded to [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
2. A `send_email` binding in `wrangler.jsonc` for outbound email
3. An Email Service routing rule that sends inbound mail to your Worker
4. Optional: an `EMAIL_SECRET` secret if you want secure reply routing

### Domain Setup

1. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Compute & AI** > **Email Service**
3. Select **Onboard Domain** and choose your domain
4. Add the DNS records (SPF and DKIM) to authorize sending

DNS changes usually complete within 5-15 minutes for domains using Cloudflare DNS, but can take up to 24 hours to propagate globally.

### Wrangler Configuration

Add the email binding to your `wrangler.jsonc`:

```jsonc
{
  "send_email": [
    {
      "name": "EMAIL",
      "remote": true  // For local development
    }
  ]
}
```

The `remote: true` option lets you call the real Email Service API during local development with `wrangler dev`.

## Quick Start

```ts
import { Agent, callable, routeAgentEmail } from "agents";
import { createAddressBasedEmailResolver, type AgentEmail } from "agents/email";
import PostalMime from "postal-mime";

export class EmailAgent extends Agent {
  @callable()
  async sendWelcomeEmail(to: string) {
    await this.env.EMAIL.send({
      to,
      from: "support@yourdomain.com",
      replyTo: "support@yourdomain.com",
      subject: "Welcome to our service",
      text: "Thanks for signing up. Reply to this email if you need help."
    });
  }

  async onEmail(email: AgentEmail) {
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);

    console.log("Received email from:", email.from);
    console.log("Subject:", parsed.subject);

    await this.replyToEmail(email, {
      fromName: "Support Agent",
      body: "Thanks for your email! We received it."
    });
  }
}

export default {
  async email(message, env) {
    await routeAgentEmail(message, env, {
      resolver: createAddressBasedEmailResolver("EmailAgent")
    });
  }
};
```

## Sending Outbound Email

Use the Email Service Workers binding for the first outbound message in a conversation or for any transactional email your agent needs to send.

Configure the binding in `wrangler.jsonc`:

```jsonc
{
  "send_email": [
    {
      "name": "EMAIL",
      "remote": true
    }
  ]
}
```

Then call `env.EMAIL.send()` from a callable method, scheduled task, webhook handler, or any other agent code:

```ts
@callable()
async sendReceipt(to: string, orderId: string) {
  const response = await this.env.EMAIL.send({
    to,
    from: { email: "billing@yourdomain.com", name: "Billing Bot" },
    replyTo: "billing@yourdomain.com",
    subject: `Receipt for order ${orderId}`,
    text: `Your receipt for order ${orderId} is ready.`
  });

  return response.messageId;
}
```

Set `replyTo` to the mailbox that routes back to your Worker when you want recipients to continue the conversation with the same agent.

## Routing Inbound Mail

Resolvers determine which Agent instance receives an incoming email. Choose the resolver that matches your use case.

For basic Email Service sending and receiving, `createAddressBasedEmailResolver()` is enough. The secure reply resolver below is optional and specific to Agents SDK reply signing, not a requirement of Email Service itself.

### createAddressBasedEmailResolver

**Recommended for inbound mail.** Routes emails based on the recipient address.

```ts
import { createAddressBasedEmailResolver } from "agents/email";

const resolver = createAddressBasedEmailResolver("EmailAgent");
```

**Routing logic:**

| Recipient Address                       | Agent Name             | Agent ID  |
| --------------------------------------- | ---------------------- | --------- |
| `support@example.com`                   | `EmailAgent` (default) | `support` |
| `sales@example.com`                     | `EmailAgent` (default) | `sales`   |
| `NotificationAgent+user123@example.com` | `NotificationAgent`    | `user123` |

The sub-address format (`agent+id@domain`) allows routing to different agent namespaces and instances from a single email domain.

> **Note:** Agent class names in the recipient address are matched case-insensitively. Email infrastructure often lowercases addresses, so `NotificationAgent+user123@example.com` and `notificationagent+user123@example.com` both route to the `NotificationAgent` class.

### createSecureReplyEmailResolver

**For reply flows with signature verification.** Verifies that incoming emails are authentic replies to your outbound emails, preventing attackers from routing emails to arbitrary agent instances.

```ts
import { createSecureReplyEmailResolver } from "agents/email";

const resolver = createSecureReplyEmailResolver(env.EMAIL_SECRET);
```

When your agent sends an email with `replyToEmail()` and a `secret`, it signs the routing headers with a timestamp. When a reply comes back, this resolver verifies the signature and checks that it hasn't expired before routing.

**Options:**

```ts
const resolver = createSecureReplyEmailResolver(env.EMAIL_SECRET, {
  // Maximum age of signature in seconds (default: 30 days)
  maxAge: 7 * 24 * 60 * 60, // 7 days

  // Callback for logging/debugging signature failures
  onInvalidSignature: (email, reason) => {
    console.warn(`Invalid signature from ${email.from}: ${reason}`);
    // reason can be: "missing_headers", "expired", "invalid", "malformed_timestamp"
  }
});
```

**When to use:** If your agent initiates email conversations and you need replies to route back to the same agent instance securely.

### createCatchAllEmailResolver

**For single-instance routing.** Routes all emails to a specific agent instance regardless of the recipient address.

```ts
import { createCatchAllEmailResolver } from "agents/email";

const resolver = createCatchAllEmailResolver("EmailAgent", "default");
```

**When to use:** When you have a single agent instance that handles all emails (e.g., a shared inbox).

### Combining Resolvers

You can combine resolvers to handle different scenarios:

```ts
export default {
  async email(message, env) {
    const secureReplyResolver = createSecureReplyEmailResolver(
      env.EMAIL_SECRET
    );
    const addressResolver = createAddressBasedEmailResolver("EmailAgent");

    await routeAgentEmail(message, env, {
      resolver: async (email, env) => {
        // First, check if this is a signed reply
        const replyRouting = await secureReplyResolver(email, env);
        if (replyRouting) return replyRouting;

        // Otherwise, route based on recipient address
        return addressResolver(email, env);
      },

      // Handle emails that don't match any routing rule
      onNoRoute: (email) => {
        console.warn(`No route found for email from ${email.from}`);
        email.setReject("Unknown recipient");
      }
    });
  }
};
```

## Handling Emails in Your Agent

### The AgentEmail Interface

When your agent's `onEmail` method is called, it receives an `AgentEmail` object:

```ts
type AgentEmail = {
  from: string; // Sender's email address
  to: string; // Recipient's email address
  headers: Headers; // Email headers (subject, message-id, etc.)
  rawSize: number; // Size of the raw email in bytes

  getRaw(): Promise<Uint8Array>; // Get the full raw email content
  reply(options): Promise<void>; // Send a reply
  forward(rcptTo, headers?): Promise<void>; // Forward the email
  setReject(reason): void; // Reject the email with a reason
};
```

### Parsing Email Content

Use a library like [postal-mime](https://www.npmjs.com/package/postal-mime) to parse the raw email:

```ts
import PostalMime from "postal-mime";

async onEmail(email: AgentEmail) {
  const raw = await email.getRaw();
  const parsed = await PostalMime.parse(raw);

  console.log("Subject:", parsed.subject);
  console.log("Text body:", parsed.text);
  console.log("HTML body:", parsed.html);
  console.log("Attachments:", parsed.attachments);
}
```

### Detecting Auto-Reply Emails

Use `isAutoReplyEmail()` to detect auto-reply emails and avoid mail loops:

```ts
import { isAutoReplyEmail } from "agents/email";
import PostalMime from "postal-mime";

async onEmail(email: AgentEmail) {
  const raw = await email.getRaw();
  const parsed = await PostalMime.parse(raw);

  // Detect auto-reply emails to avoid sending duplicate responses
  if (isAutoReplyEmail(parsed.headers)) {
    console.log("Skipping auto-reply email");
    return;
  }

  // Process the email...
}
```

This checks for standard RFC 3834 headers (`Auto-Submitted`, `X-Auto-Response-Suppress`, `Precedence`) that indicate an email is an auto-reply.

### Replying to Emails

`replyToEmail()` will send through `this.env.EMAIL` automatically when that binding exists. If your `send_email` binding uses a different name, pass it explicitly with `sendBinding`.

Use `this.replyToEmail()` to send a reply:

```ts
async onEmail(email: AgentEmail) {
  await this.replyToEmail(email, {
    fromName: "Support Bot",           // Display name for the sender
    subject: "Re: Your inquiry",       // Optional, defaults to "Re: <original subject>"
    body: "Thanks for contacting us!", // Email body
    contentType: "text/plain",         // Optional, defaults to "text/plain"
    sendBinding: this.env.EMAIL,        // Optional when your binding is named EMAIL
    headers: {                         // Optional custom headers
      "X-Custom-Header": "value"
    },
    secret: this.env.EMAIL_SECRET      // Optional, signs headers for secure reply routing
  });
}
```

### Forwarding Emails

```ts
async onEmail(email: AgentEmail) {
  await email.forward("admin@example.com");
}
```

### Rejecting Emails

```ts
async onEmail(email: AgentEmail) {
  if (isSpam(email)) {
    email.setReject("Message rejected as spam");
    return;
  }
  // Process the email...
}
```

## Error Handling

When sending emails via `replyToEmail()` or `env.EMAIL.send()`, handle these common errors:

```ts
async onEmail(email: AgentEmail) {
  try {
    await this.replyToEmail(email, {
      fromName: "Support Bot",
      body: "Thanks for your email!",
      sendBinding: this.env.EMAIL
    });
  } catch (error) {
    switch (error.code) {
      case "E_SENDER_NOT_VERIFIED":
        console.error("Sender domain not verified. Verify in dashboard.");
        break;
      case "E_RATE_LIMIT_EXCEEDED":
        console.error("Rate limit exceeded. Back off and retry.");
        break;
      case "E_DAILY_LIMIT_EXCEEDED":
        console.error("Daily sending quota reached.");
        break;
      case "E_CONTENT_TOO_LARGE":
        console.error("Email content exceeds size limit.");
        break;
      default:
        console.error("Email sending failed:", error.message);
    }
  }
}
```

### Common Error Codes

| Error Code | Description | Solution |
|------------|-------------|----------|
| `E_SENDER_NOT_VERIFIED` | Sender domain/address not verified | Verify in Cloudflare dashboard |
| `E_RATE_LIMIT_EXCEEDED` | Sending rate limit reached | Implement exponential backoff |
| `E_DAILY_LIMIT_EXCEEDED` | Daily quota exceeded | Wait for quota reset or upgrade plan |
| `E_CONTENT_TOO_LARGE` | Email exceeds size limit | Reduce attachments or content |
| `E_RECIPIENT_NOT_ALLOWED` | Recipient not in allowed list | Check allowed destination addresses |
| `E_RECIPIENT_SUPPRESSED` | Recipient is on suppression list | Remove from suppression list |
| `E_VALIDATION_ERROR` | Invalid email format | Check email addresses |
| `E_TOO_MANY_RECIPIENTS` | More than 50 recipients | Split into multiple sends |

## Secure Reply Routing

When your agent sends emails and expects replies, use secure reply routing to prevent attackers from forging headers to route emails to arbitrary agent instances.

### How It Works

1. **Outbound:** When you call `replyToEmail()` with a `secret`, the agent signs the routing headers (`X-Agent-Name`, `X-Agent-ID`) using HMAC-SHA256
2. **Inbound:** `createSecureReplyEmailResolver` verifies the signature before routing
3. **Enforcement:** If an email was routed via the secure resolver, `replyToEmail()` requires a secret (or explicit `null` to opt-out)

### Setup

1. Add a secret to your `wrangler.jsonc`:

```jsonc
// wrangler.jsonc
{
  "vars": {
    "EMAIL_SECRET": "change-me-in-production"
  }
}
```

For production, use Wrangler secrets instead:

```bash
wrangler secret put EMAIL_SECRET
```

2. Use the combined resolver pattern:

```ts
export default {
  async email(message, env) {
    const secureReplyResolver = createSecureReplyEmailResolver(
      env.EMAIL_SECRET
    );
    const addressResolver = createAddressBasedEmailResolver("EmailAgent");

    await routeAgentEmail(message, env, {
      resolver: async (email, env) => {
        const replyRouting = await secureReplyResolver(email, env);
        if (replyRouting) return replyRouting;
        return addressResolver(email, env);
      }
    });
  }
};
```

3. Sign outbound emails:

```ts
async onEmail(email: AgentEmail) {
  await this.replyToEmail(email, {
    fromName: "My Agent",
    body: "Thanks for your email!",
    sendBinding: this.env.EMAIL,
    secret: this.env.EMAIL_SECRET  // Signs the routing headers
  });
}
```

### Enforcement Behavior

When an email is routed via `createSecureReplyEmailResolver`, the `replyToEmail()` method enforces signing:

| `secret` value        | Behavior                                                     |
| --------------------- | ------------------------------------------------------------ |
| `"my-secret"`         | Signs headers (secure)                                       |
| `undefined` (omitted) | **Throws error** - must provide secret or explicit opt-out   |
| `null`                | Allowed but not recommended - explicitly opts out of signing |

## Complete Example

Here is a complete Email Service agent that sends outbound mail and handles secure replies:

```ts
import { Agent, routeAgentEmail } from "agents";
import {
  createAddressBasedEmailResolver,
  createSecureReplyEmailResolver,
  type AgentEmail
} from "agents/email";
import PostalMime from "postal-mime";

interface Env {
  EmailAgent: DurableObjectNamespace<EmailAgent>;
  EMAIL_SECRET: string;
}

export class EmailAgent extends Agent<Env> {
  async onEmail(email: AgentEmail) {
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);

    console.log(`Email from ${email.from}: ${parsed.subject}`);

    // Store the email in state
    const emails = this.state.emails || [];
    emails.push({
      from: email.from,
      subject: parsed.subject,
      receivedAt: new Date().toISOString()
    });
    this.setState({ ...this.state, emails });

    // Send auto-reply with signed headers
    await this.replyToEmail(email, {
      fromName: "Support Bot",
      body: `Thanks for your email! We received: "${parsed.subject}"`,
      sendBinding: this.env.EMAIL,
      secret: this.env.EMAIL_SECRET
    });
  }
}

export default {
  async email(message, env: Env) {
    const secureReplyResolver = createSecureReplyEmailResolver(
      env.EMAIL_SECRET,
      {
        maxAge: 7 * 24 * 60 * 60, // 7 days
        onInvalidSignature: (email, reason) => {
          console.warn(`Invalid signature from ${email.from}: ${reason}`);
        }
      }
    );
    const addressResolver = createAddressBasedEmailResolver("EmailAgent");

    await routeAgentEmail(message, env, {
      resolver: async (email, env) => {
        // Try secure reply routing first
        const replyRouting = await secureReplyResolver(email, env);
        if (replyRouting) return replyRouting;
        // Fall back to address-based routing
        return addressResolver(email, env);
      },
      onNoRoute: (email) => {
        console.warn(`No route found for email from ${email.from}`);
        email.setReject("Unknown recipient");
      }
    });
  }
} satisfies ExportedHandler<Env>;
```

## API Reference

### routeAgentEmail

```ts
function routeAgentEmail<Env>(
  email: ForwardableEmailMessage,
  env: Env,
  options: {
    resolver: EmailResolver<Env>;
    onNoRoute?: (email: ForwardableEmailMessage) => void | Promise<void>;
  }
): Promise<void>;
```

Routes an incoming email to the appropriate Agent based on the resolver's decision.

| Option      | Description                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolver`  | Function that determines which agent to route the email to                                                                                                                              |
| `onNoRoute` | Optional callback invoked when no routing information is found. Use this to reject the email or perform custom handling. If not provided, a warning is logged and the email is dropped. |

### createSecureReplyEmailResolver

```ts
function createSecureReplyEmailResolver<Env>(
  secret: string,
  options?: {
    maxAge?: number;
    onInvalidSignature?: (
      email: ForwardableEmailMessage,
      reason: SignatureFailureReason
    ) => void;
  }
): EmailResolver<Env>;

type SignatureFailureReason =
  | "missing_headers"
  | "expired"
  | "invalid"
  | "malformed_timestamp";
```

Creates a resolver for routing email replies with signature verification.

| Option               | Description                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `secret`             | Secret key for HMAC verification (must match the key used to sign)       |
| `maxAge`             | Maximum age of signature in seconds (default: 30 days / 2592000 seconds) |
| `onInvalidSignature` | Optional callback for logging when signature verification fails          |

### signAgentHeaders

```ts
function signAgentHeaders(
  secret: string,
  agentName: string,
  agentId: string
): Promise<Record<string, string>>;
```

Manually sign agent routing headers. Returns an object with `X-Agent-Name`, `X-Agent-ID`, `X-Agent-Sig`, and `X-Agent-Sig-Ts` headers.

Useful when sending emails through external services while maintaining secure reply routing. The signature includes a timestamp and will be valid for 30 days by default.
