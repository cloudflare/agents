# Email Agent Example

This example demonstrates how to build an email-processing agent using the email integration features in the agents framework.

## Features

- **Email Routing**: Routes emails to agents based on email addresses (e.g., `agent+id@domain.com`)
- **Email Parsing**: Uses PostalMime to parse incoming emails
- **Auto-Reply**: Automatically responds to incoming emails
- **State Management**: Tracks email count and stores recent emails
- **API Interface**: REST API for testing and management

## Email Routing

The agent supports multiple routing strategies:

1. **Address-based routing**: `agent+agentid@domain.com` → routes to agent "agent" with ID "agentid"
2. **Header-based routing**: Uses `X-Agent-Name` and `X-Agent-ID` headers
3. **Catch-all routing**: Routes all emails to a single agent

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start development server:

   ```bash
   npm start
   ```

3. Test email parsing locally:

   ```bash
   npm run test-email
   ```

4. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

## Testing

### Local Testing

Run the email parsing test:

```bash
npm run test-email
```

This will test email creation, parsing, and routing logic without requiring a deployment.

### API Testing

Once the agent is running (dev or deployed), you can test with these endpoints:

#### Get Agent Stats

```bash
curl http://localhost:8787/api/stats/test123
```

#### Send Test Email (Simple API)

```bash
curl -X POST http://localhost:8787/api/test-email \
  -H "Content-Type: application/json" \
  -d '{
    "from": "user@example.com",
    "to": "agent+test123@example.com",
    "subject": "Test Email",
    "body": "Hello from test!"
  }'
```

### Real Email Testing

To test with real emails:

1. Deploy the worker:

   ```bash
   npm run deploy
   ```

2. Configure your domain's email routing to point to your worker

- go to `https://dash.cloudflare.com/<account id>/<domain>/email/routing/routes`

3. Send emails to addresses like:
   - `agent@yourdomain.com` (routes to agent "agent" with ID "default")
   - `support+urgent@yourdomain.com` (routes to agent "support" with ID "urgent")

## Email Routing Strategies

### 1. Address-Based Routing

```typescript
// Routes based on email address patterns
const resolver = createEmailAddressResolver("default");

// agent+id@domain.com → { agentName: "agent", agentId: "id" }
// support@domain.com → { agentName: "support", agentId: "default" }
```

### 2. Header-Based Routing

```typescript
// Routes based on custom headers
// Email with headers:
//   X-Agent-Name: EmailAgent
//   X-Agent-ID: customer-123
// → routes to EmailAgent:customer-123
```

### 3. Catch-All Routing

```typescript
// Routes all emails to a single agent
const resolver = createCatchAllResolver("EmailAgent", "main");
```

## Agent Implementation

The `EmailAgent` class demonstrates:

- **Email Processing**: Parses emails with PostalMime
- **State Management**: Tracks emails and statistics
- **Auto-Reply**: Sends automated responses
- **Loop Prevention**: Detects and prevents auto-reply loops

```typescript
class EmailAgent extends Agent<Env, EmailAgentState> {
  async onEmail(email: AgentEmail) {
    // Parse email content
    const parsed = await PostalMime.parse(emailBuffer);

    // Update agent state
    this.setState({
      emailCount: this.state.emailCount + 1,
      emails: [...this.state.emails, emailData]
    });

    // Send auto-reply
    await this.replyToEmail(email, {
      from_name: "My Agent's name",
      body: "Thank you for your email!"
      // optionally set subject, headers, etc
    });
  }
}
```

## Use Cases

This example supports:

1. **Customer Support**: Route support emails to different agents based on priority/category
2. **Auto-Responders**: Automatically acknowledge receipt of emails
3. **Email Processing**: Parse and extract data from emails
4. **Thread Management**: Maintain email conversation state
5. **Multi-tenant Systems**: Route emails to different customer/tenant agents

## Next Steps

- Add email templates for different types of auto-replies
- Implement more sophisticated routing logic
- Add email attachment processing
- Integrate with external services (CRM, ticketing systems)
- Add email scheduling and delayed sending
