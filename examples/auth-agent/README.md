# Auth Agent

Demonstrates how to protect an Agents app with **GitHub OAuth** while keeping
the Worker, not the browser, in charge of which Durable Object instance a user
can reach.

The flow is:

- the browser signs in with GitHub
- GitHub returns an access token to the Worker
- the Worker stores that token in an httpOnly cookie
- the client connects to `/chat`
- the Worker resolves the authenticated GitHub user and forwards the request to
  that user's `ChatAgent` instance with `getAgentByName()`

## What it shows

- **GitHub OAuth** in a Worker without extra auth libraries
- **httpOnly cookie auth** instead of localStorage tokens
- **Custom `basePath` routing** so the server chooses the user-scoped agent name
- **`getAgentByName()` + `agent.fetch()`** to forward HTTP and WebSocket traffic

## Getting started

### 1. Create a GitHub OAuth App

Go to [GitHub OAuth Apps](https://github.com/settings/developers), create a new
OAuth App, and set:

- **Homepage URL:** `http://localhost:5173`
- **Authorization callback URL:** `http://localhost:5173/auth/callback`

### 2. Add your env vars

```sh
cp .env.example .env
```

Then fill in:

```sh
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
```

### 3. Start the example

```sh
npm install
npm start
```

Open the app, click **Sign in with GitHub**, approve the OAuth flow, and you
will land back in the chat UI as your GitHub user.

## The pattern you should copy

When you want the **server to own the user identity and the DO name**, custom
base-path routing is simpler than letting the browser choose an agent `name`.

### Client: connect to a stable path

The browser does not know or choose the Durable Object name. It just connects to
`/chat`:

```typescript
const agent = useAgent({
  agent: "ChatAgent",
  basePath: "chat"
});
```

### Worker: authenticate, then route by user

The Worker reads the GitHub token from an httpOnly cookie, fetches the current
GitHub user, and routes the request to the matching agent instance:

```typescript
if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
  const user = await getGitHubUserFromRequest(request);
  if (!user) {
    return createUnauthorizedResponse(request);
  }

  const agent = await getAgentByName(env.ChatAgent, user.login);
  return agent.fetch(request);
}
```

That same route covers both the WebSocket upgrade and the SDK's HTTP requests.
No query-string token juggling, no localStorage, and no browser-controlled room
names.

For simplicity, this example looks up the current GitHub user from GitHub's
`/user` API on each authenticated request. That's fine for a demo. In a
production app, you would usually cache the result or exchange the upstream
token for your own session.

## How the demo works end-to-end

```
Browser                            Worker                           Durable Object
──────                            ──────                           ──────────────
1. GET /auth/login            ──► set state cookie + redirect
                                  to GitHub authorize URL

2. GET /auth/callback         ──► exchange code for access token
   ?code=...&state=...            set httpOnly gh_access_token cookie
                                  ◄──── 302 /

3. GET /auth/me               ──► call GitHub /user with cookie token
                                  ◄──── { id, login, name, avatarUrl }

4. WS /chat + HTTP /chat/*    ──► call GitHub /user again
                                  getAgentByName(env.ChatAgent, user.login)
                                  ◄──── forward request to that user-scoped agent
```

## Why this pattern works well

- **Real identity** from GitHub for a developer-facing example
- **No localStorage auth state** in the browser
- **User-scoped routing** owned by the Worker instead of client input
- **One stable client path** for both WebSocket and HTTP traffic

## File overview

| File                 | Purpose                                                |
| -------------------- | ------------------------------------------------------ |
| `src/auth.ts`        | GitHub OAuth flow, cookie helpers, current-user lookup |
| `src/server.ts`      | Worker entry and `/chat` custom routing                |
| `src/auth-client.ts` | Client helpers for `/auth/me`, `/auth/logout`, login   |
| `src/client.tsx`     | Sign-in UI and authenticated chat                      |
| `.env.example`       | Required GitHub OAuth env vars                         |

## Environment variables

| Variable               | Required | Description                    |
| ---------------------- | -------- | ------------------------------ |
| `GITHUB_CLIENT_ID`     | Yes      | GitHub OAuth App client ID     |
| `GITHUB_CLIENT_SECRET` | Yes      | GitHub OAuth App client secret |

## Deploying

For a deployed Worker, create or update your GitHub OAuth App so it also has
your production callback URL:

```text
https://your-domain.example/auth/callback
```

Then set the secrets:

```sh
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
```

Finally deploy:

```sh
npm run deploy
```

## Notes

- This example stores the GitHub access token directly in an httpOnly cookie.
  That keeps the browser code simple and avoids a separate session layer owned
  by the app.
- The GitHub auth cookie is a session cookie, so it lasts for the current
  browser session rather than for a fixed multi-day lifetime.
- The Durable Object name uses `user.login` so the demo stays readable. In a
  production app you may prefer `user.id` if you want a stable identifier that
  does not change when a username is renamed.

## Related examples

- [ai-chat](../ai-chat/) — chat agent without auth
- [github-webhook](../github-webhook/) — GitHub integration example without browser auth
- [playground](../playground/) — broader examples including custom routing
