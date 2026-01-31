# GitHub Webhook Dashboard

A real-time GitHub repository activity monitor built with Cloudflare Agents. This example demonstrates how to handle webhooks with Agents, verify signatures, store events in SQLite, and stream updates to connected clients.

## Features

- **Webhook Handling** - Receive and process GitHub webhooks
- **Signature Verification** - HMAC-SHA256 verification of webhook payloads
- **Agent-per-Repository** - Each repo gets its own isolated agent instance
- **Real-time Updates** - WebSocket connection streams events as they arrive
- **Event History** - Events stored in SQLite for persistence
- **Beautiful Dashboard** - Dark-themed UI with live event feed

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure webhook secret

Copy `.dev.vars.example` to `.dev.vars` and set your webhook secret:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

```
GITHUB_WEBHOOK_SECRET=your-secret-here
```

### 3. Start the development server

```bash
npm start
```

### 4. Expose your local server (for testing)

Since GitHub needs to reach your webhook endpoint, use a tool like ngrok:

```bash
ngrok http 5173
```

Copy the ngrok URL (e.g., `https://abc123.ngrok.io`).

### 5. Configure GitHub Webhook

1. Go to your GitHub repository → **Settings** → **Webhooks**
2. Click **Add webhook**
3. Configure:
   - **Payload URL**: `https://your-ngrok-url.ngrok.io/webhooks/github/owner/repo`
   - **Content type**: `application/json`
   - **Secret**: Same value as `GITHUB_WEBHOOK_SECRET`
   - **Events**: Select which events to receive (or "Send me everything")
4. Click **Add webhook**

### 6. Connect to your repo

Open `http://localhost:5173` in your browser, enter your repository name (e.g., `cloudflare/agents`), and click Connect.

## How It Works

### Architecture

```
GitHub → POST /webhooks/github/owner/repo → Worker → RepoAgent (Durable Object)
                                                            ↓
Browser ← WebSocket ← Agent broadcasts state updates ←─────┘
```

### Key Patterns Demonstrated

1. **Webhook Routing**

   ```typescript
   // Route webhooks to the right agent based on repository
   const agentName = sanitizeRepoName(payload.repository.full_name);
   const agent = await getAgentByName(env.RepoAgent, agentName);
   return agent.fetch(request);
   ```

2. **Signature Verification**

   ```typescript
   // Verify GitHub's HMAC-SHA256 signature
   const key = await crypto.subtle.importKey(
     "raw",
     secret,
     { name: "HMAC", hash: "SHA-256" },
     false,
     ["sign"]
   );
   const signature = await crypto.subtle.sign("HMAC", key, payload);
   ```

3. **Event Storage in SQLite**

   ```typescript
   this.sql`INSERT INTO events (id, type, title, ...) VALUES (...)`;
   ```

4. **Real-time State Broadcasting**
   - When a webhook arrives, the agent updates its state
   - Connected clients receive the update via WebSocket

## Supported Events

| Event Type      | Description                         |
| --------------- | ----------------------------------- |
| `push`          | Commits pushed to a branch          |
| `pull_request`  | PR opened, closed, merged, etc.     |
| `issues`        | Issue opened, closed, labeled, etc. |
| `issue_comment` | Comment on an issue or PR           |
| `star`          | Repository starred/unstarred        |
| `fork`          | Repository forked                   |
| `release`       | Release published                   |
| `ping`          | Webhook configured                  |

## Deployment

```bash
npm run deploy
```

After deploying:

1. Set the webhook secret in Cloudflare:

   ```bash
   wrangler secret put GITHUB_WEBHOOK_SECRET
   ```

2. Update your GitHub webhook URL to your deployed worker URL

## Extending This Example

Ideas for enhancements:

- **AI PR Summaries** - Use OpenAI to summarize PR diffs
- **Slack Notifications** - Forward important events to Slack
- **Multi-Repo Dashboard** - Monitor all your repos in one view
- **Custom Alerts** - Schedule reminders for stale PRs
- **Webhook Replay** - Re-send events for testing

## Project Structure

```
examples/github-webhook/
├── src/
│   ├── server.ts        # RepoAgent + webhook routing
│   ├── client.tsx       # React dashboard
│   ├── github-types.ts  # TypeScript types for GitHub payloads
│   └── styles.css       # Dashboard styles
├── public/
│   └── normalize.css
├── index.html
├── wrangler.jsonc
└── package.json
```
