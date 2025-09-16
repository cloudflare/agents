# Cross-Domain Authentication Demo

Demonstrates **cross-domain authentication** between a React client (`127.0.0.1:5174`) and Cloudflare Worker server (`localhost:8787`) using both WebSocket and HTTP authentication, with support for both **static** and **async** authentication patterns.

## Quick Start

1. **Navigate to the example directory**:

   ```bash
   cd examples/cross-domain
   ```

2. **Install dependencies** (if not already installed):

   ```bash
   npm install
   ```

3. **Start both servers**:
   ```bash
   npm start
   ```
   This starts:
   - Client: `http://127.0.0.1:5174` (Vite)
   - Server: `http://localhost:8787` (Wrangler)

## Cross-Domain Setup

**Why this is cross-domain:**

- Client: `127.0.0.1:5174`
- Server: `localhost:8787`
- Different hostnames = different origins
- Browser triggers CORS preflight requests
- WebSocket connections cross domain boundaries

## Demo Credentials

| Type      | Field           | Valid Value                 |
| --------- | --------------- | --------------------------- |
| WebSocket | `token`         | `demo-token-123`            |
| WebSocket | `userId`        | `demo-user` (or any string) |
| HTTP      | `Authorization` | `Bearer demo-token-123`     |
| HTTP      | `X-API-Key`     | `demo-api-key`              |

## Production Usage

This pattern works for real cross-domain scenarios:

```typescript
// Production example
const agent = useAgent({
  agent: "my-agent",
  host: "https://api.mycompany.com",
  query: {
    token: jwtToken,
    userId: currentUser.id
  }
});

fetch("https://api.mycompany.com/agents/my-agent/default", {
  headers: {
    Authorization: `Bearer ${jwtToken}`,
    "X-API-Key": process.env.API_KEY
  }
});
```

Replace the demo validation logic with your actual authentication service.
