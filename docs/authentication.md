# Authentication Guide

This guide covers authentication patterns for the Agents SDK, including static authentication, async authentication, cross-domain scenarios, and security best practices.

## Table of Contents

1. [Overview](#overview)
2. [When to Use Each Approach](#when-to-use-each-approach)
3. [Static vs Async Authentication](#static-vs-async-authentication)
4. [Cross-Domain Authentication Patterns](#cross-domain-authentication-patterns)

## Overview

The Agents SDK provides two main approaches for authentication:

### Static Authentication (`useAgent`)

For scenarios where authentication data is available at component initialization:

- Simple, synchronous setup
- No Suspense boundary required
- Best for static tokens or pre-fetched auth data

### Async Authentication (`useAsyncAgent`)

For scenarios requiring dynamic token fetching or runtime authentication:

- Supports async query functions
- **Automatic retry with event-driven recovery**
- **Connection state management for better UX**
- Requires Suspense boundary
- Best for JWT refresh, OAuth flows, or cross-domain auth

## When to Use Each Approach

| Scenario            | Recommended Hook | Reason                      |
| ------------------- | ---------------- | --------------------------- |
| Static API keys     | `useAgent`       | Simple, no async needed     |
| Pre-fetched tokens  | `useAgent`       | Auth data already available |
| JWT token refresh   | `useAsyncAgent`  | Dynamic token fetching      |
| OAuth flows         | `useAsyncAgent`  | Async token exchange        |
| Cross-domain auth   | `useAsyncAgent`  | Fetch from auth service     |
| User-dependent auth | `useAsyncAgent`  | Dynamic user context        |

## Static vs Async Authentication

### Basic Migration

**Before (useAgent):**

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

**After (useAsyncAgent):**

```typescript
function ChatComponent() {
  const agent = useAsyncAgent({
    agent: "chat",
    query: async () => ({ token: await getToken() })
  });

  return <div>Connected to {agent.id}</div>;
}

// Usage - Suspense wrapper required
<Suspense fallback={<div>Authenticating...</div>}>
  <ChatComponent />
</Suspense>
```

### JWT Token Refresh Pattern

```typescript
function useJWTAgent(agentName: string) {
  return useAsyncAgent({
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
    onAuthError: (error) => {
      // Redirect to login on auth failure
      window.location.href = "/login";
    },
    autoRetry: {
      enabled: true,
      maxAttempts: 5,
      baseDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 1.5,
      stopAfterMs: 5 * 60 * 1000, // Stop after 5 minutes
      triggers: ["focus", "online", "visibility", "periodic"],
      periodicInterval: 30000 // Retry every 30 seconds
    }
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

// Async cross-domain authentication with automatic retry
const agent = useAsyncAgent({
  agent: "my-agent",
  host: "https://my-agent-server.com",
  query: async () => {
    const response = await fetch("https://auth.example.com/token", {
      credentials: "include"
    });
    const { token, userId } = await response.json();
    return { token, userId };
  },
  onAuthError: (error) => {
    console.error("Cross-domain auth failed:", error);
  },
  autoRetry: {
    enabled: true,
    maxAttempts: 3,
    baseDelay: 2000,
    triggers: ["focus", "online", "visibility"]
  },
  debug: true
});

// Access connection state for UI feedback
const { connectionState, isRetrying, lastError } = agent;
// connectionState: 'connecting' | 'connected' | 'retrying' | 'failed'
```

## Automatic Retry and Connection State

The `useAsyncAgent` hook provides robust automatic retry functionality that handles common network issues without manual intervention.

### Automatic Retry Features

- **Event-driven recovery**: Automatically retries on window focus, network online, page visibility, and periodic intervals
- **Exponential backoff**: Smart delay increases to avoid overwhelming servers
- **Configurable limits**: Control max attempts, delays, and total retry duration
- **Connection state tracking**: Real-time feedback for UI components

### Connection States

| State        | Description                 | UI Recommendation             |
| ------------ | --------------------------- | ----------------------------- |
| `connecting` | Initial connection attempt  | Show loading spinner          |
| `connected`  | Successfully authenticated  | Show success indicator        |
| `retrying`   | Automatic retry in progress | Show retry indicator          |
| `failed`     | Max retries exceeded        | Show error with manual action |

### Retry Configuration

```typescript
const agent = useAsyncAgent({
  agent: "my-agent",
  query: asyncAuthQuery,
  autoRetry: {
    enabled: true, // Enable automatic retry
    maxAttempts: 5, // Max retry attempts
    baseDelay: 1000, // Initial delay (1s)
    maxDelay: 30000, // Maximum delay (30s)
    backoffMultiplier: 1.5, // Exponential backoff factor
    stopAfterMs: 300000, // Stop after 5 minutes
    triggers: [
      // When to trigger retry
      "focus", // Window gains focus
      "online", // Network comes online
      "visibility", // Tab becomes visible
      "periodic" // Periodic background retry
    ],
    periodicInterval: 30000 // Background retry interval
  }
});
```

### UI Integration

```typescript
function AuthenticatedComponent() {
  const agent = useAsyncAgent({ /* config */ });

  return (
    <div>
      <div className="connection-status">
        {agent.connectionState === 'connecting' && "🔄 Connecting..."}
        {agent.connectionState === 'connected' && "✅ Connected"}
        {agent.connectionState === 'retrying' && "🔄 Retrying..."}
        {agent.connectionState === 'failed' && "❌ Connection failed"}
      </div>

      {agent.isRetrying && (
        <div>Automatic retry in progress...</div>
      )}

      {agent.lastError && agent.connectionState === 'failed' && (
        <div>Error: {agent.lastError.message}</div>
      )}

      {/* Your app content */}
    </div>
  );
}
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
