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

2. Test email parsing locally:
   ```bash
   npm run test-email
   ```

3. Start development server:
   ```bash
   npm run start
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

#### Send Test Email (Real Email Worker - More Comprehensive)
```bash
curl --request POST 'http://localhost:8787/webhook/email' \
  --url-query 'from=user@example.com' \
  --url-query 'to=agent+test123@example.com' \
  --header 'Content-Type: text/plain' \
  --data-raw 'Received: from smtp.example.com (127.0.0.1) by cloudflare-email.com
From: "Test User" <user@example.com>
To: <agent+test123@example.com>
Subject: Test Email for Agent
Date: '"$(date -R)"'
Message-ID: <test-'"$(date +%s)"'@example.com>
Content-Type: text/plain; charset=UTF-8

Hello Email Agent!'
```

#### Toggle Auto-Reply
```bash
curl -X POST http://localhost:8787/api/toggle-auto-reply/test123
```

#### Clear Email History
```bash
curl -X POST http://localhost:8787/api/clear/test123
```

### Real Email Testing

To test with real emails:

1. Deploy the worker:
   ```bash
   npm run deploy
   ```

2. Configure your domain's email routing to point to your worker

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
  async onEmail(email: ForwardableEmailMessage) {
    // Parse email content
    const parsed = await PostalMime.parse(emailBuffer);
    
    // Update agent state
    this.setState({
      emailCount: this.state.emailCount + 1,
      emails: [...this.state.emails, emailData],
    });
    
    // Send auto-reply
    await this.sendEmail(this.env.EMAIL, fromEmail, fromName, {
      to: parsed.from.address,
      subject: \`Re: \${parsed.subject}\`,
      body: "Thank you for your email!",
    });
  }
}
```

## Configuration

Update `wrangler.jsonc` for your domain:

```json
{
  "send_email": [
    {
      "name": "EMAIL", 
      "destination_address": "*@yourdomain.com"
    }
  ],
  "vars": {
    "EMAIL_DOMAIN": "yourdomain.com",
    "FROM_EMAIL": "agent@yourdomain.com",
    "FROM_NAME": "Your Email Agent"
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