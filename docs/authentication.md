# Authentication Guide

This guide covers authentication patterns for the Agents SDK, including static authentication, async authentication, cross-domain scenarios, and security best practices.

## Table of Contents

1. [Overview](#overview)
2. [Authentication Patterns](#authentication-patterns)
3. [Cross-Domain Authentication](#cross-domain-authentication)

## Overview

The Agents SDK provides a unified `useAgent` hook that automatically handles both static and async authentication patterns:

### Static Authentication

For scenarios where authentication data is available at component initialization:

- Simple, synchronous setup
- No Suspense boundary required
- Best for static tokens or pre-fetched auth data

### Async Authentication

For scenarios requiring dynamic token fetching or runtime authentication:

- Supports async query functions with automatic caching
- Requires Suspense boundary
- Best for JWT refresh, OAuth flows, or cross-domain auth

## Authentication Patterns

| Scenario            | Implementation               | Reason                      |
| ------------------- | ---------------------------- | --------------------------- |
| Static API keys     | `useAgent` with static query | Simple, no async needed     |
| Pre-fetched tokens  | `useAgent` with static query | Auth data already available |
| JWT token refresh   | `useAgent` with async query  | Dynamic token fetching      |
| OAuth flows         | `useAgent` with async query  | Async token exchange        |
| Cross-domain auth   | `useAgent` with async query  | Fetch from auth service     |
| User-dependent auth | `useAgent` with async query  | Dynamic user context        |

## Usage Examples

### Static Authentication

```typescript
function ChatComponent() {
  const agent = useAgent({
    agent: "chat",
    query: { token: staticToken }
  });

  return <div>Connected to {agent.id}</div>;
}

// Usage - no Suspense needed
<ChatComponent />
```

### Async Authentication

```typescript
function ChatComponent() {
  const agent = useAgent({
    agent: "chat",
    query: async () => ({ token: await getToken() })
  });

  return <div>Connected to {agent.id}</div>;
}

// Usage - Suspense wrapper required for async queries
<Suspense fallback={<div>Authenticating...</div>}>
  <ChatComponent />
</Suspense>
```

### JWT Token Refresh Pattern

```typescript
function useJWTAgent(agentName: string) {
  return useAgent({
    agent: agentName,
    query: async () => {
      const token = localStorage.getItem("jwt");
      if (!token || isTokenExpired(token)) {
        const newToken = await refreshToken();
        localStorage.setItem("jwt", newToken);
        return { token: newToken };
      }
      return { token };
    },
    queryDeps: [], // Re-run on component mount only
    debug: true
  });
}
```

## Cross-Domain Authentication Patterns

### WebSocket Authentication

Cross-domain WebSocket connections require authentication via query parameters:

```typescript
// Static cross-domain authentication
const agent = useAgent({
  agent: "my-agent",
  host: "https://my-agent-server.com",
  query: {
    token: "your-auth-token",
    userId: "user123"
  }
});

// Async cross-domain authentication
const agent = useAgent({
  agent: "my-agent",
  host: "https://my-agent-server.com",
  query: async () => {
    const response = await fetch("https://auth.example.com/token", {
      credentials: "include"
    });
    const { token, userId } = await response.json();
    return { token, userId };
  },
  debug: true
});
```

## Caching and Performance

The unified `useAgent` hook automatically caches async query results to improve performance and reduce redundant authentication requests.

### Caching Features

- **Automatic caching**: Query results are cached with configurable TTL (default 5 minutes)
- **Dependency tracking**: Cache invalidation based on `queryDeps` array
- **Memory management**: Automatic cleanup of expired entries and reference counting
- **Performance optimization**: Reduces redundant authentication requests

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

### Best Practices

- Use `queryDeps` to control when async queries should re-execute
- Wrap async authentication components in `<Suspense>` boundaries
- Handle authentication errors gracefully with try/catch in query functions
- Use `debug: true` during development to monitor caching behavior

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
