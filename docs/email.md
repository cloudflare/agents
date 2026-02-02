# Email Routing

Agents can receive and process emails using Cloudflare's [Email Routing](https://developers.cloudflare.com/email-routing/email-workers/). This guide covers how to route inbound emails to your Agents and handle replies securely.

## Prerequisites

1. A domain configured with [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/)
2. An Email Worker configured to receive emails
3. An Agent to process emails

## Quick Start

```ts
import { Agent, routeAgentEmail } from "agents";
import { createAddressBasedEmailResolver, type AgentEmail } from "agents/email";

// Your Agent that handles emails
export class EmailAgent extends Agent {
  async onEmail(email: AgentEmail) {
    console.log("Received email from:", email.from);
    console.log("Subject:", email.headers.get("subject"));

    // Reply to the email
    await this.replyToEmail(email, {
      fromName: "My Agent",
      body: "Thanks for your email!"
    });
  }
}

// Route emails to your Agent
export default {
  async email(message, env) {
    await routeAgentEmail(message, env, {
      resolver: createAddressBasedEmailResolver("EmailAgent")
    });
  }
};
```

## Resolvers

Resolvers determine which Agent instance receives an incoming email. Choose the resolver that matches your use case.

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

### Replying to Emails

Use `this.replyToEmail()` to send a reply:

```ts
async onEmail(email: AgentEmail) {
  await this.replyToEmail(email, {
    fromName: "Support Bot",           // Display name for the sender
    subject: "Re: Your inquiry",       // Optional, defaults to "Re: <original subject>"
    body: "Thanks for contacting us!", // Email body
    contentType: "text/plain",         // Optional, defaults to "text/plain"
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

Here's a complete email agent with secure reply routing:

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
