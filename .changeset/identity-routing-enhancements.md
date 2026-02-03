---
"agents": patch
---

Add custom URL routing with `basePath` and server-sent identity

## Custom URL Routing with `basePath`

New `basePath` option bypasses default `/agents/{agent}/{name}` URL construction, enabling custom routing patterns:

```typescript
// Client connects to /user instead of /agents/user-agent/...
const agent = useAgent({
  agent: "UserAgent",
  basePath: "user"
});
```

Server handles routing manually with `getAgentByName`:

```typescript
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/user") {
      const session = await getSession(request);
      const agent = await getAgentByName(env.UserAgent, session.userId);
      return agent.fetch(request);
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

## Server-Sent Identity

Agents now send their identity (`name` and `agent` class) to clients on connect:

- `onIdentity` callback - called when server sends identity
- `agent.name` and `agent.agent` are updated from server (authoritative)

```typescript
const agent = useAgent({
  agent: "UserAgent",
  basePath: "user",
  onIdentity: (name, agentType) => {
    console.log(`Connected to ${agentType} instance: ${name}`);
  }
});
```

## Identity State & Ready Promise

- `identified: boolean` - whether identity has been received
- `ready: Promise<void>` - resolves when identity is received
- In React, `name`, `agent`, and `identified` are reactive state

```typescript
// React - reactive rendering
return agent.identified ? `Connected to: ${agent.name}` : "Connecting...";

// Vanilla JS - await ready
await agent.ready;
console.log(agent.name);
```

## Identity Change Detection

- `onIdentityChange` callback - fires when identity differs on reconnect
- Warns if identity changes without handler (helps catch session issues)

```typescript
useAgent({
  basePath: "user",
  onIdentityChange: (oldName, newName, oldAgent, newAgent) => {
    console.log(`Session changed: ${oldName} → ${newName}`);
  }
});
```

## Sub-Paths with `path` Option

Append additional path segments:

```typescript
// /user/settings
useAgent({ basePath: "user", path: "settings" });

// /agents/my-agent/room/settings
useAgent({ agent: "MyAgent", name: "room", path: "settings" });
```

## Server-Side Identity Control

Disable identity sending for security-sensitive instance names:

```typescript
class SecureAgent extends Agent {
  static options = { sendIdentityOnConnect: false };
}
```
