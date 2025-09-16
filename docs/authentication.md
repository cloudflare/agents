# Authentication Guide

This guide covers authentication patterns for the Agents SDK, including static authentication, async authentication, cross-domain scenarios, and security best practices.

## Overview

The Agents SDK provides a unified `useAgent` hook that automatically handles both static and async authentication patterns:

## Usage Examples

### Static Authentication

```typescript
import { useAgent } from "agents/react";
import { useState } from "react";

function ChatComponent() {
  const [isConnected, setIsConnected] = useState(false);

  const agent = useAgent({
    agent: "my-agent",
    query: {
      token: "demo-token-123",
      userId: "demo-user"
    },
    onOpen: () => setIsConnected(true),
    onClose: () => setIsConnected(false),
    onError: (error) => console.error("Connection error:", error)
  });

  return <div>Agent: {agent.agent} - {isConnected ? "Connected" : "Disconnected"}</div>;
}
```

### Async Authentication

```typescript
import { useAgent } from "agents/react";
import { useRef, useState, Suspense, useCallback } from "react";

function ChatComponent() {
  const [isConnected, setIsConnected] = useState(false);

  // Async authentication query
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
    query: asyncQuery,
    onOpen: () => setIsConnected(true),
    onClose: () => setIsConnected(false),
    onError: (error) => console.error("Connection error:", error)
  });

  return <div>Agent: {agent.agent} - {isConnected ? "Connected" : "Disconnected"}</div>;
}

// Usage - Suspense wrapper required for async queries
<Suspense fallback={<div>Authenticating...</div>}>
  <ChatComponent />
</Suspense>
```

### JWT Token Refresh Pattern

```typescript
import { useAgent } from "agents/react";
import { useCallback } from "react";

function useJWTAgent(agentName: string) {
  const asyncQuery = useCallback(async () => {
    let token = localStorage.getItem("jwt");

    if (!token || isTokenExpired(token)) {
      token = await refreshToken();
      localStorage.setItem("jwt", token);
    }

    return {
      token,
      userId: "demo-user"
    };
  }, []);

  return useAgent({
    agent: agentName,
    query: asyncQuery,
    queryDeps: [], // Re-run on component mount only
    debug: true
  });
}
```

## Cross-Domain Authentication Patterns

### WebSocket Authentication

Cross-domain WebSocket connections require authentication via query parameters:

```typescript
import { useAgent } from "agents/react";
import { useState, useCallback } from "react";

// Static cross-domain authentication
function StaticCrossDomainAuth() {
  const [isConnected, setIsConnected] = useState(false);

  const agent = useAgent({
    agent: "my-agent",
    host: "http://localhost:8788",
    query: {
      token: "demo-token-123",
      userId: "demo-user"
    },
    onOpen: () => setIsConnected(true),
    onClose: () => setIsConnected(false),
    onError: (error) => console.error("WebSocket auth error:", error)
  });

  return <div>Cross-domain connection: {isConnected ? "Connected" : "Disconnected"}</div>;
}

// Async cross-domain authentication
function AsyncCrossDomainAuth() {
  const [isConnected, setIsConnected] = useState(false);

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
    onOpen: () => setIsConnected(true),
    onClose: () => setIsConnected(false),
    onError: (error) => console.error("WebSocket auth error:", error),
    debug: true
  });

  return <div>Cross-domain connection: {isConnected ? "Connected" : "Disconnected"}</div>;
}
```

## Caching and Performance

The unified `useAgent` hook automatically caches async query results to improve performance and reduce redundant authentication requests.

### Things caching solves for you:

- **Automatic caching**: Query results are cached with configurable TTL (default 5 minutes)
- **Dependency tracking**: Cache invalidation based on `queryDeps` array
- **Memory management**: Automatic cleanup of expired entries and reference counting

### Cache Configuration

```typescript
const agent = useAgent({
  agent: "my-agent",
  query: async () => {
    // This will be cached automatically
    const token = await fetchAuthToken();
    return { token, userId: "user123" };
  },
  queryDeps: [userId], // Cache invalidates when userId changes
  debug: true // Enable debug logging
});
```

### HTTP Authentication

HTTP requests support multiple authentication methods:

```typescript
import { useAgentChat } from "agents/ai-react";

// Bearer token authentication
const chat = useAgentChat({
  agent,
  headers: {
    Authorization: `Bearer ${token}`
  }
});

// API key authentication
const chat = useAgentChat({
  agent,
  headers: {
    "X-API-Key": apiKey
  }
});

// Session-based authentication
const chat = useAgentChat({
  agent,
  credentials: "include" // Includes cookies
});
```
