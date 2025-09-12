# Cross-Domain Authentication

This guide explains how to authenticate with agents when connecting from a different domain, addressing both WebSocket and HTTP authentication scenarios.

## The Problem

When using agents from a different domain, you need to handle authentication for two types of connections:

1. **WebSocket connections** - Used by `useAgent` for real-time communication
2. **HTTP requests** - Used by `useAgentChat` for operations like fetching initial messages

## Solution Overview

### WebSocket Authentication (useAgent)

WebSocket authentication is handled through the `useAgent` hook options, which are passed directly to the underlying `usePartySocket`:

```tsx
import { useAgent } from "agents/react";

const agent = useAgent({
  agent: "my-agent",
  host: "https://my-agent-server.com",
  // WebSocket authentication options
  query: {
    token: "your-auth-token",
    userId: "user123"
  }
});
```

### HTTP Authentication (`fetch` or `useAgentChat`)

HTTP authentication can be handled by making a standard `fetch` request with authentication headers, or by using the `headers` options in `useAgentChat`.

```tsx
// Example using a manual fetch request
await fetch(`https://my-agent-server.com/agents/my-agent/default`, {
  method: "GET",
  headers: {
    Authorization: `Bearer your-auth-token`,
    "X-API-Key": "your-api-key"
  }
});

// Example using the useAgentChat hook
import { useAgentChat } from "agents/react";

const chat = useAgentChat({
  agent,
  headers: {
    Authorization: "Bearer your-auth-token",
    "X-API-Key": "your-api-key"
  }
});
```

## Complete Example

Here is a conceptual example that combines `useAgent` and `useAgentChat`:

```tsx
import { useAgent, useAgentChat } from "agents/react";
import { useState } from "react";

function AuthenticatedChat() {
  const [authToken] = useState("your-auth-token");

  // 1. WebSocket connection with authentication
  const agent = useAgent({
    agent: "my-agent",
    host: "https://my-agent-server.com",
    // WebSocket auth via query parameters
    query: {
      token: authToken,
      userId: "user123"
    },
    onError: (error) => {
      console.error("WebSocket auth error:", error);
    }
  });

  // 2. Chat with HTTP authentication
  const chat = useAgentChat({
    agent,
    // HTTP auth for /get-messages and other requests
    credentials: "include",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "X-API-Key": "your-api-key"
    }
  });

  return (
    <div>
      {chat.messages.map((message) => (
        <div key={message.id}>
          <strong>{message.role}:</strong> {message.content}
        </div>
      ))}
      <button onClick={() => chat.append({ role: "user", content: "Hello!" })}>
        Send Message
      </button>
    </div>
  );
}
```

## Authentication Methods

### 1. Query Parameters (Recommended for WebSocket)

The most common and reliable method for WebSocket authentication:

```tsx
const agent = useAgent({
  agent: "my-agent",
  host: "https://api.example.com",
  query: {
    token: "abc123",
    userId: "user456",
    sessionId: "session789"
  }
});
```

### 2. Bearer Token (HTTP)

Standard for HTTP API authentication:

```tsx
const chat = useAgentChat({
  agent,
  headers: {
    Authorization: `Bearer ${token}`
  }
});
```

### 3. API Key (HTTP)

Alternative HTTP authentication method:

```tsx
const chat = useAgentChat({
  agent,
  headers: {
    "X-API-Key": apiKey
  }
});
```

### 4. Session-based (HTTP)

For cookie-based authentication:

```tsx
const chat = useAgentChat({
  agent,
  credentials: "include" // Includes cookies in requests
});
```

## Server-Side Implementation

### WebSocket Authentication

Handle authentication in your agent's `onConnect` method:

```typescript
import { Agent, Connection } from "agents";

export class MyAgent extends Agent {
  onConnect(connection: Connection, ctx: any) {
    // Extract auth from WebSocket query parameters
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get("token");
    const userId = url.searchParams.get("userId");

    if (!this.validateAuth(token, userId)) {
      connection.close(1008, "Unauthorized");
      return;
    }

    // Connection successful
  }

  private validateAuth(token: string | null, userId: string | null): boolean {
    // Example validation: check for a specific token and any userId.
    // In production, you would validate this against your auth system.
    if (token === "demo-token-123" && userId) {
      return true;
    }
    return false;
  }
}
```

### HTTP Authentication

Handle HTTP authentication in your agent's `onRequest` method:

```typescript
import { Agent } from "agents";

export class MyAgent extends Agent {
  onRequest(request: Request): Response | Promise<Response> {
    // Handle HTTP authentication for API requests
    const authHeader = request.headers.get("Authorization");
    const apiKey = request.headers.get("X-API-Key");

    if (!this.validateHttpAuth(authHeader, apiKey)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    return new Response("Authenticated request processed", {
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*"
      }
    });
  }

  private validateHttpAuth(
    authHeader: string | null,
    apiKey: string | null
  ): boolean {
    // Example validation: check for a specific Bearer token and API key.
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.substring(7)
      : null;
    if (token === "demo-token-123" && apiKey === "demo-api-key") {
      return true;
    }
    return false;
  }
}
```

## CORS Configuration

For cross-domain requests, ensure proper CORS headers:

```typescript
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://your-client-domain.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  "Access-Control-Allow-Credentials": "true"
};
```

## Troubleshooting

### WebSocket Connection Issues

1. **Authentication failures**: Check that query parameters are correctly formatted
2. **CORS issues**: Ensure your server accepts connections from your client domain
3. **Token format**: Verify tokens don't contain special characters that need URL encoding

### HTTP Request Issues

1. **Missing headers**: Ensure `Authorization` or `X-API-Key` headers are included
2. **Credentials**: Use `credentials: "include"` for cookie-based auth
3. **CORS preflight**: Handle `OPTIONS` requests properly on your server

### Common Patterns

```tsx
// Token refresh pattern
const [authToken, setAuthToken] = useState(initialToken);

useEffect(() => {
  // Refresh token logic
  const refreshToken = async () => {
    const newToken = await getNewToken();
    setAuthToken(newToken);
    // Note: WebSocket will need to reconnect with new token
  };
}, []);

// Error handling pattern
const agent = useAgent({
  agent: "my-agent",
  host: "https://api.example.com",
  query: { token: authToken },
  onError: (error) => {
    if (error.message.includes("Unauthorized")) {
      // Handle auth error - redirect to login, refresh token, etc.
      handleAuthError();
    }
  }
});
```

## Security Best Practices

1. **Use HTTPS/WSS**: Always use secure connections in production
2. **Token expiration**: Implement token refresh mechanisms
3. **Validate origins**: Restrict CORS to specific domains
4. **Rate limiting**: Implement rate limiting on your server
5. **Audit logs**: Log authentication attempts for security monitoring
