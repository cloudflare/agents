# Cross-Domain Authentication Demo

Demonstrates **cross-domain authentication** between a React client (`127.0.0.1:5174`) and Cloudflare Worker server (`localhost:8787`) using both WebSocket and HTTP authentication.

## What This Demo Shows

- **WebSocket Authentication**: Query parameters validated on connection
- **HTTP Authentication**: Bearer token + API key headers validated on requests
- **Real Cross-Domain**: Different hostnames (`127.0.0.1` vs `localhost`) trigger actual CORS
- **Token Validation**: Server accepts `demo-token-123` and rejects invalid tokens
- **Visual Feedback**: Connection status, auth results, and debug info

## Quick Start

1. **Install dependencies**:

   ```bash
   npm install
   ```

2. **Start both servers**:
   ```bash
   npm start
   ```
   This starts:
   - Client: `http://127.0.0.1:5174` (Vite)
   - Server: `http://localhost:8787` (Wrangler)

## Testing Authentication

### ✅ Valid Authentication

- **Token**: `demo-token-123`
- **Result**: Green dot, welcome message, WebSocket/HTTP work

### ❌ Invalid Authentication

- **Token**: `invalid-token` (or any other value)
- **Result**: Red dot, connection closes, HTTP returns 401

## How It Works

### WebSocket Authentication

Query parameters are extracted and validated when the WebSocket connects:

```typescript
// Client sends authentication in query parameters
const agent = useAgent({
  agent: "my-agent",
  host: "http://localhost:8787",
  query: {
    token: "demo-token-123", // Required: must be exact value
    userId: "demo-user" // Required: any non-empty string
  }
});
```

```typescript
// Server validates on connection
onConnect(connection: Connection, ctx: any) {
  const url = new URL(ctx.request.url);
  const token = url.searchParams.get('token');
  const userId = url.searchParams.get('userId');

  // Validate authentication
  if (!this.validateAuth(token, userId)) {
    connection.close(1008, 'Unauthorized: Invalid or missing authentication');
    return;
  }

  // Connection successful
}

private validateAuth(token: string | null, userId: string | null): boolean {
  // For demo: accept 'demo-token-123' as valid
  if (token === 'demo-token-123' && userId.length > 0) {
    return true;
  }
  return false;
}
```

### HTTP Authentication

Headers are validated for each HTTP request:

```typescript
// Client sends authentication in headers
fetch("http://localhost:8787/agents/my-agent/default", {
  headers: {
    Authorization: "Bearer demo-token-123", // Required
    "X-API-Key": "demo-api-key" // Required
  }
});
```

```typescript
// Server validates headers
onRequest(request: Request): Response | Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  const apiKey = request.headers.get('X-API-Key');

  if (!this.validateHttpAuth(authHeader, apiKey)) {
    return new Response('🚫 Unauthorized - Invalid or missing authentication', {
      status: 401,
      headers: { 'Access-Control-Allow-Origin': '*' }
    });
  }

  // Request successful
}

private validateHttpAuth(authHeader: string | null, apiKey: string | null): boolean {
  // Check Bearer token
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  if (token !== 'demo-token-123') {
    return false;
  }

  // Check API key
  if (apiKey !== 'demo-api-key') {
    return false;
  }

  return true;
}
```

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

## What You'll See

### Server Console Logs

```
Connection attempt - Token: demo-token-123, UserId: demo-user
✅ Valid authentication
✅ Authenticated client connected: abc123 (user: demo-user)
HTTP Request - Auth: Bearer demo-token-123, API Key: demo-api-key
✅ Valid Bearer token
✅ Valid API key
✅ HTTP Authentication successful
```

## Troubleshooting

### Red Dot (Disconnected)

- Check both servers are running
- Verify token is exactly `demo-token-123`
- Look at server console for auth errors

### HTTP Requests Fail

- Ensure server is on `localhost:8787`
- Check browser Network tab for CORS errors
- Verify both Authorization and X-API-Key headers

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
