# Auth Agent

Securing a Cloudflare Agents server with [better-auth](https://www.better-auth.com/), JWT authentication, and Cloudflare D1.

## What this demonstrates

- Email/password auth with better-auth on Workers
- D1 as the auth database (users, sessions, JWKS keys)
- JWT issuance and JWKS-based verification
- Protecting WebSocket connections via `onBeforeConnect`
- Protecting HTTP agent routes via `onBeforeRequest`

## Getting started

```sh
npm install

# Create .dev.vars with your secret
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .dev.vars

# Create the D1 tables
npm run db:setup

# Start dev server
npm start
```

## Architecture

```
Browser (React SPA)
  ├── /api/auth/*   →  better-auth (sign-up, sign-in, JWT, JWKS)
  ├── /agents/*     →  routeAgentRequest() with JWT middleware
  └── /*            →  Vite SPA (wrangler assets)
```

### Auth flow

1. User signs in → better-auth sets a **session cookie** (same-origin, automatic)
2. Client calls `authClient.token()` → `GET /api/auth/token` (authenticated via cookie) → returns a short-lived **JWT**
3. JWT stored in `localStorage`
4. `useAgent({ query: { token } })` passes JWT as a WebSocket query parameter
5. Server's `onBeforeConnect` verifies JWT using JWKS read from D1

## Key decisions

### Why better-auth

[better-auth](https://www.better-auth.com/) is a framework-agnostic TypeScript auth library that runs on any runtime, including Workers. It provides email/password auth, session management, JWT issuance, and JWKS out of the box via plugins. No external auth service required — everything runs in your Worker.

### Why D1 (not memoryAdapter or stateless mode)

better-auth needs a database for user records regardless of how sessions work. D1 is Cloudflare's serverless SQLite — zero config, no connection strings, available as a binding. The `memoryAdapter` is for testing only; it loses data on every request in Workers since each invocation is stateless.

### Why kysely-d1

better-auth uses [Kysely](https://kysely.dev/) internally as its query builder. D1 has its own API surface. [`kysely-d1`](https://github.com/nickkatsios/kysely-d1) is the dialect that bridges the two:

```
better-auth → Kysely → kysely-d1 → D1
```

This is the only adapter chain that works for better-auth on D1. You pass it directly to better-auth's `database` config:

```ts
database: {
  dialect: new D1Dialect({ database: env.AUTH_DB }),
  type: "sqlite"
}
```

### Why cookies for browser auth + JWT for WebSocket auth

**Browser → auth API**: Cookies are automatic on same-origin. No manual token management needed — the browser sends them on every request. This is simpler and more reliable than managing bearer tokens in `localStorage`.

**Browser → agent WebSocket**: WebSocket upgrade requests cannot send custom headers. The JWT must be passed as a URL query parameter (`?token=...`). This is why we need both mechanisms.

### Why createLocalJWKSet (not createRemoteJWKSet)

The JWKS endpoint (`/api/auth/jwks`) lives on the same Worker that needs to verify tokens. Using `createRemoteJWKSet` would cause the Worker to `fetch()` its own URL. By default, Cloudflare routes same-zone subrequests to the origin server, bypassing Workers — so the JWKS endpoint is never reached. On `workers.dev` (where there is no origin), this fails outright. With the `global_fetch_strictly_public` compatibility flag, true loopback is possible — but it adds latency, consumes a subrequest, and requires an opt-in flag.

Instead, we read the JWKS keys directly from D1 (the `jwks` table that better-auth's JWT plugin manages) and build a local key set with [`jose`](https://github.com/panva/jose):

```ts
const result = await env.AUTH_DB.prepare(
  "SELECT id, publicKey, privateKey, createdAt FROM jwks"
).all();

const jwks = createLocalJWKSet({
  keys: result.results.map((row) => ({
    ...JSON.parse(row.publicKey),
    kid: row.id
  }))
});

const { payload } = await jwtVerify(token, jwks);
```

### Why createAuth is a factory function

Workers are stateless — `env` bindings (D1, secrets) are only available per-request. You can't create a better-auth instance at module level because there's no `env` at that point. Each request creates a fresh instance:

```ts
if (url.pathname.startsWith("/api/auth")) {
  const auth = createAuth(env);
  return auth.handler(request);
}
```

## File overview

| File | Purpose |
|---|---|
| `src/server.ts` | Worker fetch handler — routes to auth, agents, or SPA. Exports `SecuredChatAgent` DO. |
| `src/auth.ts` | `createAuth()` factory + `verifyToken()` — D1 dialect, JWT verification via jose |
| `src/auth-client.ts` | Browser auth client — `fetchAndStoreJwt()`, `clearTokens()` |
| `src/client.tsx` | React UI — auth form + chat view |
| `db/setup.sql` | Creates better-auth tables (user, session, account, jwks) |
| `db/reset.sql` | Drops and recreates all tables |

## Scripts

| Script | Description |
|---|---|
| `npm start` | Start Vite dev server |
| `npm run db:setup` | Create D1 tables locally |
| `npm run db:reset` | Drop and recreate all tables |
| `npm run deploy` | Build and deploy to Workers |
| `npm run types` | Regenerate `env.d.ts` |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `BETTER_AUTH_SECRET` | Yes | Secret for signing sessions/tokens. Min 32 chars. Put in `.dev.vars`. |
| `BETTER_AUTH_URL` | No | Set in `wrangler.jsonc`. Defaults to `http://localhost:5173`. |

## Stack

- **Runtime**: Cloudflare Workers + Durable Objects + D1
- **Auth**: [better-auth](https://www.better-auth.com/) with JWT + bearer plugins
- **JWT verification**: [jose](https://github.com/panva/jose) with `createLocalJWKSet`
- **Database adapter**: [kysely-d1](https://github.com/nickkatsios/kysely-d1)
- **UI**: React, Tailwind CSS, [Kumo](https://kumo-ui.com/) (workers theme)
- **Build**: Vite + `@cloudflare/vite-plugin`
