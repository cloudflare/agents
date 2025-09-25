# Cross-Domain Authentication

When your Agents are deployed, to keep things secure, send a token from the client, then verify it on the server. This mirrors the shape used in PartyKit’s auth guide.

## WebSocket authentication

WebSockets are not HTTP, so the handshake is limited when making cross-domain connections.

**What you cannot send**

- Custom headers during the upgrade
- `Authorization: Bearer ...` on connect

**What works**

- Put a signed, short-lived token in the connection URL as query parameters
- Verify the token in your server’s connect path

> Tip: never place raw secrets in URLs. Prefer a JWT or a signed token that expires quickly and is scoped to the user or room.

### Same origin

If the client and server share the origin, the browser will send cookies during the WebSocket handshake. Session based auth can work here. Prefer HTTP-only cookies.

### Cross origin

Cookies do not help across origins. Pass credentials in the URL query, then verify on the server.

## Usage examples

### Static authentication

```ts
import { useAgent } from "agents/react";

function ChatComponent() {
  const agent = useAgent({
    agent: "my-agent",
    query: {
      token: "demo-token-123",
      userId: "demo-user"
    }
  });

  // Use agent to make calls, access state, etc.
}
```

### Async authentication

Build query values right before connect. Use Suspense for async setup.

```ts
import { useAgent } from "agents/react";
import { Suspense, useCallback } from "react";

function ChatComponent() {
  const asyncQuery = useCallback(async () => {
    const [token, user] = await Promise.all([getAuthToken(), getCurrentUser()]);
    return {
      token,
      userId: user.id,
      timestamp: Date.now().toString()
    };
  }, []);

  const agent = useAgent({
    agent: "my-agent",
    query: asyncQuery
  });

  // Use agent to make calls, access state, etc.
}

<Suspense fallback={<div>Authenticating...</div>}>
  <ChatComponent />
</Suspense>
```

### JWT refresh pattern

Refresh the token when the connection fails due to authentication error.

```ts
import { useAgent } from "agents/react";
import { useCallback, useEffect } from "react";

function useJWTAgent(agentName: string) {
  const asyncQuery = useCallback(async () => {
    let token = localStorage.getItem("jwt");

    // If no token OR the token is no longer valid
    // request a fresh token
    if (!token && !(await validateToken(token))) {
      token = await refreshToken();
      localStorage.setItem("jwt", token);
    }

    return {
      token
    };
  }, []);

  const agent = useAgent({
    agent: agentName,
    query: asyncQuery,
    queryDeps: [] // Run on mount
  });

  // Handle authentication errors
  // Token expired, refresh and reconnect
}
```

## Cross-domain authentication

Pass credentials in the URL when connecting to another host, then verify on the server.

```ts
import { useAgent } from "agents/react";
import { useCallback } from "react";

// Static cross-domain auth
function StaticCrossDomainAuth() {
  const agent = useAgent({
    agent: "my-agent",
    host: "http://localhost:8788",
    query: {
      token: "demo-token-123",
      userId: "demo-user"
    }
  });

  // Use agent to make calls, access state, etc.
}

// Async cross-domain auth
function AsyncCrossDomainAuth() {
  const asyncQuery = useCallback(async () => {
    const [token, user] = await Promise.all([getAuthToken(), getCurrentUser()]);
    return {
      token,
      userId: user.id,
      timestamp: Date.now().toString()
    };
  }, []);

  const agent = useAgent({
    agent: "my-agent",
    host: "http://localhost:8788",
    query: asyncQuery,
    debug: true
  });

  // Use agent to make calls, access state, etc.
}
```

## HTTP authentication

`useAgentChat` will use the same authentication provided to `useAgent`. To further authenticate the HTTP requests `useAgentChat` can make (e.g. in `getInitialMessages`), you can use headers and credentials.

```ts
import { useAgentChat } from "agents/ai-react";

// Bearer token
const chat = useAgentChat({
  agent,
  headers: {
    Authorization: `Bearer ${token}`
  }
});

// API key
const chat = useAgentChat({
  agent,
  headers: {
    "X-API-Key": apiKey
  }
});

// Session based (same-origin only)
const chat = useAgentChat({
  agent,
  credentials: "include" // Sends cookies
});
```

\
