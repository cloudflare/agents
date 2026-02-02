---
"agents": minor
---

### Secure Email Reply Routing

This release introduces secure email reply routing with HMAC-SHA256 signed headers, preventing unauthorized routing of emails to arbitrary agent instances.

#### Breaking Changes

**Email utilities moved to `agents/email` subpath**: Email-specific resolvers and utilities have been moved to a dedicated subpath for better organization.

```ts
// Before
import { createAddressBasedEmailResolver, signAgentHeaders } from "agents";

// After
import {
  createAddressBasedEmailResolver,
  signAgentHeaders
} from "agents/email";
```

The following remain in root: `routeAgentEmail`, `createHeaderBasedEmailResolver` (deprecated).

**`createHeaderBasedEmailResolver` removed**: This function now throws an error with migration guidance. It was removed because it trusted attacker-controlled email headers for routing.

**Migration:**

- For inbound mail: use `createAddressBasedEmailResolver(agentName)`
- For reply flows: use `createSecureReplyEmailResolver(secret)` with signed headers

See https://github.com/cloudflare/agents/blob/main/docs/email.md for details.

**`EmailSendOptions` type removed**: This type was unused and has been removed.

#### New Features

**`createSecureReplyEmailResolver`**: A new resolver that verifies HMAC-SHA256 signatures on incoming emails before routing. Signatures include a timestamp and expire after 30 days by default.

```ts
const resolver = createSecureReplyEmailResolver(env.EMAIL_SECRET, {
  maxAge: 7 * 24 * 60 * 60, // Optional: 7 days (default: 30 days)
  onInvalidSignature: (email, reason) => {
    // Optional: log failures for debugging
    // reason: "missing_headers" | "expired" | "invalid" | "malformed_timestamp"
    console.warn(`Invalid signature from ${email.from}: ${reason}`);
  }
});
```

**`signAgentHeaders`**: Helper function to manually sign agent routing headers for use with external email services.

```ts
const headers = await signAgentHeaders(secret, agentName, agentId);
// Returns: { "X-Agent-Name", "X-Agent-ID", "X-Agent-Sig", "X-Agent-Sig-Ts" }
```

**`replyToEmail` signing**: The `replyToEmail` method now accepts a `secret` option to automatically sign outbound email headers.

```ts
await this.replyToEmail(email, {
  fromName: "My Agent",
  body: "Thanks!",
  secret: this.env.EMAIL_SECRET // Signs headers for secure reply routing
});
```

If an email was routed via `createSecureReplyEmailResolver`, calling `replyToEmail` without a secret will throw an error (pass explicit `null` to opt-out).

**`onNoRoute` callback**: `routeAgentEmail` now accepts an `onNoRoute` callback for handling emails that don't match any routing rule.

```ts
await routeAgentEmail(message, env, {
  resolver,
  onNoRoute: (email) => {
    email.setReject("Unknown recipient");
  }
});
```
