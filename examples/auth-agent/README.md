# Auth Agent

Demonstrates how to protect agent WebSocket and HTTP connections with **JWT authentication**.

> **This is a demo, not a production auth system.** The `/api/token` endpoint
> hands out JWTs to anyone — it simulates your existing auth service. In
> production, replace it with your own identity provider. **The patterns to
> copy are `onBeforeConnect` and `onBeforeRequest`** — those stay the same
> regardless of how you issue tokens.

## What it shows

- Protecting WebSocket connections via `onBeforeConnect`
- Protecting HTTP agent routes via `onBeforeRequest`
- Issuing JWTs with [jose](https://github.com/panva/jose) (HMAC-SHA256)
- Passing user identity from JWT claims into the agent

## Getting started

```sh
npm install

# Create .env with your secret
echo "AUTH_SECRET=$(openssl rand -base64 32)" > .env

# Start dev server
npm start
```

## The pattern you should copy

**Use `onBeforeConnect` to protect WebSocket connections and `onBeforeRequest`
to protect HTTP requests.** Everything else in this example (the token endpoint,
the login form, localStorage) is scaffolding you will replace with your own auth.

### Protect WebSocket connections

WebSocket upgrade requests do not support custom headers. Pass the JWT as a
query parameter and verify it in `onBeforeConnect`:

```typescript
routeAgentRequest(request, env, {
  onBeforeConnect: async (req) => {
    const token = new URL(req.url).searchParams.get("token");
    if (!token)
      return Response.json({ error: "Missing token" }, { status: 401 });

    const payload = await verifyToken(env, token);
    if (!payload)
      return Response.json({ error: "Unauthorized" }, { status: 401 });

    // Return the original request to allow the connection
    return req;
  },
```

On the client, pass the token via the `query` option on `useAgent`:

```typescript
const agent = useAgent({
  agent: "ChatAgent",
  name: userName,
  query: async () => ({ token: getToken() || "" })
});
```

### Protect HTTP requests

The SDK also makes HTTP requests (e.g. fetching initial messages). These use
the same `query` option, so check both the `Authorization` header and the
query parameter:

```typescript
  onBeforeRequest: async (req) => {
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : new URL(req.url).searchParams.get("token");
    if (!token)
      return Response.json({ error: "Missing token" }, { status: 401 });

    const payload = await verifyToken(env, token);
    if (!payload)
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    return req;
  }
});
```

## How the demo works end-to-end

```
Browser                          Worker                        Durable Object
──────                          ──────                        ──────────────
1. POST /api/token          ──► issueToken(name)              ← REPLACE THIS
   { "name": "Alice" }           with your own auth service
                                  ◄──── { token: "eyJ..." }

2. WebSocket /agents/*       ──► onBeforeConnect:             ← COPY THIS
   ?token=<jwt>                   jwtVerify(token, secret)
                                  ◄──── 401 or upgrade

3. HTTP /agents/*            ──► onBeforeRequest:             ← COPY THIS
   Bearer header or ?token=       jwtVerify(token, secret)
                                  ◄──── 401 or response
```

### Personalised responses

The Durable Object name is set to the user's name from the JWT `sub` claim.
The system prompt includes this name so the LLM can address the user personally:

```typescript
const userName = this.name; // DO name = user name from JWT
const result = streamText({
  system: `You are a helpful assistant. The user's name is ${userName}.`,
  ...
});
```

## File overview

| File                 | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `src/server.ts`      | Worker entry — **token endpoint (replace), JWT verify (copy)** |
| `src/auth-client.ts` | Client-side token fetch and storage (replace with your auth)   |
| `src/client.tsx`     | React UI — name form + chat                                    |
| `src/index.tsx`      | React root with ThemeProvider                                  |
| `src/styles.css`     | Tailwind + Kumo + agents-ui imports                            |

## Environment variables

| Variable      | Required | Description                                            |
| ------------- | -------- | ------------------------------------------------------ |
| `AUTH_SECRET` | Yes      | HMAC secret for signing/verifying JWTs. Put in `.env`. |

## Deploying

1. Set the secret: `wrangler secret put AUTH_SECRET`
2. Deploy: `npm run deploy`

## Related examples

- [ai-chat](../ai-chat/) — chat agent without auth
- [playground](../playground/) — kitchen-sink showcase of all SDK features
