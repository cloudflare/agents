# Cross-Domain Authentication Demo

Demonstrates **cross-domain authentication** between a React client (`127.0.0.1:5174`) and Cloudflare Worker server (`localhost:8787`) using both WebSocket and HTTP authentication, with support for both **static** and **async** authentication patterns.

## What This Demo Shows

- **Static Authentication** (`useAgent`): Query parameters provided at initialization
- **Async Authentication** (`useAsyncAgent`): Dynamic token fetching with React Suspense
- **Automatic Retry**: Event-driven recovery with exponential backoff
- **Connection State Management**: Real-time status feedback (`connecting`, `connected`, `retrying`, `failed`)
- **WebSocket Authentication**: Query parameters validated on connection
- **HTTP Authentication**: Bearer token + API key headers validated on requests
- **Real Cross-Domain**: Different hostnames (`127.0.0.1` vs `localhost`) trigger actual CORS
- **Token Validation**: Server accepts `demo-token-123` and rejects invalid tokens
- **Visual Feedback**: Connection status, retry progress, and error information

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

## Testing Authentication

### ✅ Valid Authentication

- **Token**: `demo-token-123`
- **Result**: Green dot, welcome message, WebSocket/HTTP work

### ❌ Invalid Authentication

- **Token**: `invalid-token` (or any other value)
- **Result**: Red dot, connection closes, HTTP returns 401

## How It Works

The demo includes two authentication patterns that you can toggle between:

### Static Authentication (`useAgent`)

Query parameters are provided at component initialization:

```typescript
// Client sends static authentication in query parameters
const agent = useAgent({
  agent: "my-agent",
  host: "http://localhost:8787",
  query: {
    token: "demo-token-123", // Required: must be exact value
    userId: "demo-user" // Required: any non-empty string
  }
});
```

### Async Authentication (`useAsyncAgent`)

Authentication data is fetched dynamically before WebSocket connection with automatic retry:

```typescript
// Client fetches authentication data asynchronously
const asyncQuery = useCallback(async () => {
  const [token, user] = await Promise.all([
    getAuthToken(), // Fetch from auth service
    getCurrentUser() // Get user context
  ]);

  return {
    token,
    userId: user.id,
    timestamp: Date.now()
  };
}, []);

const agent = useAsyncAgent({
  agent: "my-agent",
  host: "http://localhost:8787",
  query: asyncQuery, // Async function instead of static object
  autoRetry: {
    enabled: true,
    maxAttempts: 5,
    baseDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 1.5,
    stopAfterMs: 5 * 60 * 1000,
    triggers: ["focus", "online", "visibility", "periodic"],
    periodicInterval: 30000
  }
});

// Access connection state for UI feedback
const { connectionState, isRetrying, lastError } = agent;
```

### Server-Side Validation

Both patterns use the same server-side validation:

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
  if (token === 'demo-token-123' && userId && userId.length > 0) {
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

### Client UI States

The async authentication demo shows different connection states:

- **🔄 Connecting...** - Initial authentication attempt
- **✅ Connected to server** - Successfully authenticated and connected
- **🔄 Retrying authentication...** - Automatic retry in progress
- **❌ Connection failed (auto-retry enabled)** - Max retries exceeded
- **🔄 Automatic retry in progress...** - Retry indicator when `isRetrying` is true
- **Last error: [error message]** - Shows specific error when connection fails

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

### Connection Issues

**Red Dot (Disconnected)**

- Check both servers are running
- Verify token is exactly `demo-token-123`
- Look at server console for auth errors
- **Automatic retry will attempt to reconnect** - no manual action needed

**Stuck in "Retrying" State**

- Check network connectivity
- Verify auth service is responding
- Try switching browser tabs (triggers focus retry)
- Automatic retry will stop after 5 minutes by default

**"Connection failed" State**

- Max retry attempts exceeded
- Check server logs for persistent auth issues
- Refresh page to restart retry cycle
- Consider adjusting `autoRetry.maxAttempts` if needed

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
