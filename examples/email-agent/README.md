# Email Agent Example

This example demonstrates how to build an email-processing agent using the email integration features in the agents framework.

## Features

- **Email Routing**: Routes emails to agents based on email addresses (e.g., `agent+id@domain.com`)
- **Secure Reply Routing**: HMAC-signed headers for secure reply flows
- **Email Parsing**: Uses PostalMime to parse incoming emails
- **Auto-Reply**: Automatically responds to incoming emails with loop prevention
- **State Management**: Tracks email count and stores recent emails
- **API Interface**: REST API for testing and management
- **Security Tests**: Comprehensive test suite including attack bypass attempts

## Quick Start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure the secret (required):

   Update `wrangler.jsonc` with a unique secret for local development:

   ```jsonc
   "vars": {
     "EMAIL_SECRET": "your-unique-secret-here"
   }
   ```

   For production, use Wrangler secrets:

   ```bash
   wrangler secret put EMAIL_SECRET
   ```

3. Start development server:

   ```bash
   npm start
   ```

4. Run tests:

   ```bash
   npm test
   ```

## Testing

### Automated Test Suite

The example includes a comprehensive test suite with functional and security tests:

```bash
# Run all tests (starts server automatically)
npm test

# Run with verbose output
npm run test:verbose

# Run only security tests
npm run test:security
```

Sample output:

```
═════════════════════════════════════════════════════════════════
FUNCTIONAL TESTS
═════════════════════════════════════════════════════════════════
  ✅ PASS  Basic Email                    (12ms)
  ✅ PASS  Unicode Content                (6ms)
  ✅ PASS  Long Subject                   (6ms)
  ✅ PASS  Multiline Body                 (7ms)
  ✅ PASS  Special Characters             (11ms)
  Subtotal: 5/5 passed

═════════════════════════════════════════════════════════════════
SECURITY TESTS (Attack Bypass Attempts)
═════════════════════════════════════════════════════════════════
  🛡️ BLOCKED  Forged headers (no signature)       (4ms)
  🛡️ BLOCKED  Fake signature (random)             (4ms)
  🛡️ BLOCKED  Expired signature (31 days)         (2ms)
  ...
  Subtotal: 15/15 attacks blocked

🎉 All tests passed! Security defenses are working.
```

### Manual Testing

Send test emails with different scenarios:

```bash
# Run all test scenarios
npm run test-email

# Run specific scenario
npm run test-email -- --scenario basic

# Use custom agent ID
npm run test-email -- --scenario unicode --id my-custom-id

# Show help
npm run test-email -- --help
```

Available scenarios: `basic`, `unicode`, `long-subject`, `multiline`, `special-chars`

### API Endpoints

#### Send Test Email

```bash
curl -X POST http://localhost:8787/api/test-email \
  -H "Content-Type: application/json" \
  -d '{
    "from": "user@example.com",
    "to": "EmailAgent+test123@example.com",
    "subject": "Test Email",
    "body": "Hello from test!"
  }'
```

#### Security Test Endpoint

For testing security defenses with custom headers:

```bash
curl -X POST http://localhost:8787/api/test-security \
  -H "Content-Type: application/json" \
  -d '{
    "from": "attacker@evil.com",
    "to": "victim@example.com",
    "subject": "Attack attempt",
    "body": "Trying to bypass security",
    "headers": {
      "X-Agent-Name": "EmailAgent",
      "X-Agent-ID": "admin-secret",
      "X-Agent-Sig": "fake-signature",
      "X-Agent-Sig-Ts": "1234567890"
    },
    "secureOnly": true
  }'
```

## Email Routing

The agent supports multiple routing strategies:

### 1. Secure Reply Routing (Recommended for replies)

Uses HMAC-signed headers to securely route email replies back to the correct agent instance:

```typescript
const secureResolver = createSecureReplyEmailResolver(env.EMAIL_SECRET, {
  maxAge: 7 * 24 * 60 * 60, // 7 days
  onInvalidSignature: (email, reason) => {
    console.warn(`Invalid signature from ${email.from}: ${reason}`);
  }
});
```

Security features:

- HMAC-SHA256 signatures prevent header forgery
- Timestamp validation prevents replay attacks (default: 30 day expiry)
- Future timestamp rejection prevents validity extension attacks
- Constant-time comparison prevents timing attacks

### 2. Address-Based Routing

Routes based on email address patterns:

```typescript
const resolver = createAddressBasedEmailResolver("EmailAgent");

// EmailAgent+user123@domain.com → { agentName: "EmailAgent", agentId: "user123" }
// john.doe@domain.com → { agentName: "EmailAgent", agentId: "john.doe" }
```

#### Routing Rules

For emails with **sub-addresses** (using `+`):

- `localpart+subaddress@domain.com` → `{ agentName: "localpart", agentId: "subaddress" }`

For emails **without sub-addresses**:

- `localpart@domain.com` → `{ agentName: defaultAgentName, agentId: "localpart" }`

### 3. Catch-All Routing

Routes all emails to a single agent:

```typescript
const resolver = createCatchAllEmailResolver("EmailAgent", "main");

// All emails route to EmailAgent:main
```

### Composing Resolvers

Combine multiple resolvers for flexible routing:

```typescript
await routeAgentEmail(email, env, {
  resolver: async (email, env) => {
    // Try secure reply routing first (for replies)
    const replyRouting = await secureReplyResolver(email, env);
    if (replyRouting) return replyRouting;

    // Fall back to address-based routing (for new emails)
    return addressResolver(email, env);
  }
});
```

## Agent Implementation

The `EmailAgent` class demonstrates:

- **Email Processing**: Parses emails with PostalMime
- **State Management**: Tracks emails and statistics
- **Auto-Reply**: Sends automated responses with secure signatures
- **Loop Prevention**: Detects auto-reply headers to prevent infinite loops

```typescript
class EmailAgent extends Agent<Env, EmailAgentState> {
  async onEmail(email: AgentEmail) {
    // Parse email content
    const parsed = await PostalMime.parse(await email.getRaw());

    // Update agent state
    this.setState({
      emailCount: this.state.emailCount + 1,
      emails: [...this.state.emails.slice(-9), emailData]
    });

    // Send auto-reply (with secure signature for reply routing)
    if (!this.isAutoReply(parsed)) {
      await this.replyToEmail(email, {
        fromName: "My Email Agent",
        body: "Thank you for your email!",
        secret: this.env.EMAIL_SECRET
      });
    }
  }
}
```

### Auto-Reply Loop Prevention

The agent detects auto-replies by checking:

- `Auto-Submitted` header (RFC 3834)
- `X-Auto-Response-Suppress` header (Microsoft)
- `Precedence` header values (`bulk`, `junk`, `list`, `auto_reply`)
- Subject line patterns ("auto-reply", "out of office", "automatic reply")

## Security

### Secure Reply Flow

When sending outbound emails, the agent signs headers with HMAC-SHA256:

```
X-Agent-Name: EmailAgent
X-Agent-ID: customer123
X-Agent-Sig: <HMAC signature>
X-Agent-Sig-Ts: <Unix timestamp>
```

When a reply comes back, the signature is verified before routing. This prevents:

| Attack           | Protection               |
| ---------------- | ------------------------ |
| Forged headers   | Signature verification   |
| Replay attacks   | Timestamp expiration     |
| Future timestamp | Clock skew limit (5 min) |
| Timing attacks   | Constant-time comparison |

### Security Tests

The test suite includes 15 attack scenarios:

- Forged headers without signature
- Random/fake signatures
- Expired signatures
- Future timestamps
- Malformed timestamps
- SQL injection payloads
- Path traversal attempts
- Header injection (newlines)
- Unicode normalization attacks
- Case manipulation
- Long payload DoS attempts
- Null byte injection

Run security tests: `npm run test:security`

## Deployment

1. Set production secret:

   ```bash
   wrangler secret put EMAIL_SECRET
   ```

2. Deploy:

   ```bash
   npm run deploy
   ```

3. Configure email routing in Cloudflare Dashboard:
   - Go to `https://dash.cloudflare.com/<account-id>/<domain>/email/routing/routes`
   - Add routing rules to point to your worker

4. Send emails to addresses like:
   - `support@yourdomain.com` → EmailAgent with ID "support"
   - `EmailAgent+urgent@yourdomain.com` → EmailAgent with ID "urgent"

## Project Structure

```
email-agent/
├── src/
│   └── index.ts          # Main agent and worker code
├── run-tests.ts          # Automated test runner (functional + security)
├── test-mail.ts          # Manual test script with CLI
├── wrangler.jsonc        # Cloudflare Worker configuration
├── package.json
└── README.md
```

## Scripts

| Script                  | Description                           |
| ----------------------- | ------------------------------------- |
| `npm start`             | Start development server              |
| `npm test`              | Run all tests (functional + security) |
| `npm run test:verbose`  | Run tests with detailed output        |
| `npm run test:security` | Run only security tests               |
| `npm run test-email`    | Manual test script with CLI options   |
| `npm run deploy`        | Deploy to Cloudflare                  |

## Next Steps

- Add email templates for different types of auto-replies
- Implement AI-powered response generation
- Add email attachment processing
- Integrate with external services (CRM, ticketing systems)
- Add email scheduling and delayed sending
- Implement conversation threading
