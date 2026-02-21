# Configuration

This guide covers everything you need to configure agents for local development and production deployment, including wrangler.jsonc setup, type generation, environment variables, and the Cloudflare dashboard.

## wrangler.jsonc

The `wrangler.jsonc` file configures your Cloudflare Worker and its bindings. Here's a complete example for an agents project:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-agent-app",
  "main": "src/server.ts",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],

  // Static assets (optional)
  "assets": {
    "directory": "public",
    "binding": "ASSETS"
  },

  // Durable Object bindings for agents
  "durable_objects": {
    "bindings": [
      {
        "name": "MyAgent",
        "class_name": "MyAgent"
      },
      {
        "name": "ChatAgent",
        "class_name": "ChatAgent"
      }
    ]
  },

  // Required: Enable SQLite storage for agents
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyAgent", "ChatAgent"]
    }
  ],

  // AI binding (optional, for Workers AI)
  "ai": {
    "binding": "AI"
  }
}
```

### Key Fields

#### compatibility_flags

The `nodejs_compat` flag is **required** for agents:

```jsonc
"compatibility_flags": ["nodejs_compat"]
```

This enables Node.js compatibility mode, which agents depend on for crypto, streams, and other Node.js APIs.

#### durable_objects.bindings

Each agent class needs a binding:

```jsonc
"durable_objects": {
  "bindings": [
    {
      "name": "Counter",      // Property name on `env` (env.Counter)
      "class_name": "Counter" // Exported class name (must match exactly)
    }
  ]
}
```

| Field        | Description                                                 |
| ------------ | ----------------------------------------------------------- |
| `name`       | The property name on `env`. Use this in code: `env.Counter` |
| `class_name` | Must match the exported class name exactly                  |

**When name and class_name differ:**

```jsonc
{
  "name": "COUNTER_DO", // env.COUNTER_DO
  "class_name": "CounterAgent" // export class CounterAgent
}
```

This is useful when you want environment variable-style naming (`COUNTER_DO`) but more descriptive class names (`CounterAgent`).

#### migrations

Migrations tell Cloudflare how to set up storage for your Durable Objects:

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["MyAgent"]
  }
]
```

| Field                | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `tag`                | Version identifier (e.g., "v1", "v2"). Must be unique         |
| `new_sqlite_classes` | Agent classes that use SQLite storage (state persistence)     |
| `deleted_classes`    | Classes being removed                                         |
| `renamed_classes`    | Classes being renamed (see [Migrations](#migrations-1) below) |

#### assets

For serving static files (HTML, CSS, JS):

```jsonc
"assets": {
  "directory": "public",  // Folder containing static files
  "binding": "ASSETS"     // Optional: binding for programmatic access
}
```

With a binding, you can serve assets programmatically:

```typescript
export default {
  async fetch(request: Request, env: Env) {
    // static assets are served by the worker automatically by default

    // route the request to the appropriate agent
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // add your own routing logic here if you want to handle requests that are not for agents
    return new Response("Not found", { status: 404 });
  }
};
```

#### ai

For Workers AI integration:

```jsonc
"ai": {
  "binding": "AI",
  "remote": true  // Mandatory: use remote inference (for local dev)
}
```

Access in your agent:

```typescript
const response = await this.env.AI.run("@cf/zai-org/glm-4.7-flash", {
  prompt: "Hello!"
});
```

## Generating Types

Wrangler can generate TypeScript types for your bindings.

### Automatic Generation

Run the types command:

```bash
npx wrangler types
```

This creates or updates `worker-configuration.d.ts` with your `Env` type.

### Custom Output Path

Specify a custom path:

```bash
npx wrangler types env.d.ts
```

### Without Runtime Types

For cleaner output (recommended for agents):

```bash
npx wrangler types env.d.ts --include-runtime false
```

This generates just your bindings without Cloudflare runtime types.

### Example Generated Output

```typescript
// env.d.ts (generated)
declare namespace Cloudflare {
  interface Env {
    OPENAI_API_KEY: string;
    Counter: DurableObjectNamespace<import("./src/server").Counter>;
    ChatAgent: DurableObjectNamespace<import("./src/server").ChatAgent>;
  }
}
interface Env extends Cloudflare.Env {}
```

### Manual Type Definition

You can also define types manually:

```typescript
// env.d.ts
import type { Counter } from "./src/agents/counter";
import type { ChatAgent } from "./src/agents/chat";

interface Env {
  // Secrets
  OPENAI_API_KEY: string;
  WEBHOOK_SECRET: string;

  // Agent bindings
  Counter: DurableObjectNamespace<Counter>;
  ChatAgent: DurableObjectNamespace<ChatAgent>;

  // Other bindings
  AI: Ai;
  ASSETS: Fetcher;
  MY_KV: KVNamespace;
}
```

### Adding to package.json

Add a script for easy regeneration:

```json
{
  "scripts": {
    "types": "wrangler types env.d.ts --include-runtime false"
  }
}
```

## Environment Variables & Secrets

### Local Development (.env)

Create a `.env` file for local secrets (add to `.gitignore`):

```bash
# .env
OPENAI_API_KEY=sk-...
GITHUB_WEBHOOK_SECRET=whsec_...
DATABASE_URL=postgres://...
```

Access in your agent:

```typescript
class MyAgent extends Agent<Env> {
  async onStart() {
    const apiKey = process.env.OPENAI_API_KEY;
  }
}
```

### Production Secrets

Use `wrangler secret` for production:

```bash
# Add a secret
wrangler secret put OPENAI_API_KEY
# Enter value when prompted

# List secrets
wrangler secret list

# Delete a secret
wrangler secret delete OPENAI_API_KEY
```

### Non-Secret Variables

For non-sensitive configuration, use `vars` in wrangler.jsonc:

```jsonc
{
  "vars": {
    "API_BASE_URL": "https://api.example.com",
    "MAX_RETRIES": "3",
    "DEBUG_MODE": "false"
  }
}
```

Note: All values must be strings. Parse numbers/booleans in code:

```typescript
const maxRetries = parseInt(process.env.MAX_RETRIES, 10);
const debugMode = process.env.DEBUG_MODE === "true";
```

### Environment-Specific Variables

Use `[env.{name}]` sections for different environments (e.g. staging, production):

```jsonc
{
  "name": "my-agent",
  "vars": {
    "API_URL": "https://api.example.com"
  },

  "env": {
    "staging": {
      "vars": {
        "API_URL": "https://staging-api.example.com"
      }
    },
    "production": {
      "vars": {
        "API_URL": "https://api.example.com"
      }
    }
  }
}
```

Deploy to specific environment:

```bash
wrangler deploy --env staging
wrangler deploy --env production
```

## Local Development

### Starting the Dev Server

With Vite (recommended for full stack apps):

```bash
npx vite dev
```

Without Vite:

```bash
npx wrangler dev
```

### Local State Persistence

Durable Object state is persisted locally in `.wrangler/state/`:

```
.wrangler/
└── state/
    └── v3/
        └── d1/
            └── miniflare-D1DatabaseObject/
                └── ... (SQLite files)
```

### Clearing Local State

To reset all local Durable Object state:

```bash
rm -rf .wrangler/state
```

Or restart with fresh state:

```bash
npx wrangler dev --persist-to=""
```

### Inspecting Local SQLite

You can inspect agent state directly:

```bash
# Find the SQLite file
ls .wrangler/state/v3/d1/

# Open with sqlite3
sqlite3 .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite
```

## Dashboard Setup

### Automatic Resources

When you deploy, Cloudflare automatically creates:

- **Worker** - Your deployed code
- **Durable Object namespaces** - One per agent class
- **SQLite storage** - Attached to each namespace

### Viewing Durable Objects

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Select your account → Workers & Pages
3. Click your Worker
4. Go to **Durable Objects** tab

Here you can:

- See all Durable Object namespaces
- View individual object instances
- Inspect storage (keys and values)
- Delete objects

### Real-time Logs

View live logs from your agents:

```bash
npx wrangler tail
```

Or in the dashboard:

1. Go to your Worker
2. Click **Logs** tab
3. Enable real-time logs

Filter by:

- Status (success, error)
- Search text
- Sampling rate

### Analytics

The dashboard shows:

- Request count
- Error rate
- CPU time
- Duration percentiles
- Durable Object metrics

## Production Deployment

### Basic Deploy

```bash
npx wrangler deploy
```

This:

1. Bundles your code
2. Uploads to Cloudflare
3. Applies migrations
4. Makes it live on `*.workers.dev`

### Custom Domain

Add a route in wrangler.jsonc:

```jsonc
{
  "routes": [
    {
      "pattern": "agents.example.com/*",
      "zone_name": "example.com"
    }
  ]
}
```

Or use a custom domain (simpler):

```jsonc
{
  "routes": [
    {
      "pattern": "agents.example.com",
      "custom_domain": true
    }
  ]
}
```

### Preview Deployments

Deploy without affecting production:

```bash
npx wrangler deploy --dry-run    # See what would be uploaded
npx wrangler versions upload     # Upload new version
npx wrangler versions deploy     # Gradually roll out
```

### Rollbacks

Roll back to a previous version:

```bash
npx wrangler rollback
```

## Multi-Environment Setup

### Environment Configuration

Define environments in wrangler.jsonc:

```jsonc
{
  "name": "my-agent",
  "main": "src/server.ts",

  // Base configuration (shared)
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "MyAgent", "class_name": "MyAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyAgent"] }],

  // Environment overrides
  "env": {
    "staging": {
      "name": "my-agent-staging",
      "vars": {
        "ENVIRONMENT": "staging"
      }
    },
    "production": {
      "name": "my-agent-production",
      "vars": {
        "ENVIRONMENT": "production"
      }
    }
  }
}
```

### Deploying to Environments

```bash
# Deploy to staging
npx wrangler deploy --env staging

# Deploy to production
npx wrangler deploy --env production

# Set secrets per environment
npx wrangler secret put OPENAI_API_KEY --env staging
npx wrangler secret put OPENAI_API_KEY --env production
```

### Separate Durable Objects

Each environment gets its own Durable Objects. Staging agents don't share state with production agents.

To explicitly separate:

```jsonc
{
  "env": {
    "staging": {
      "durable_objects": {
        "bindings": [
          {
            "name": "MyAgent",
            "class_name": "MyAgent",
            "script_name": "my-agent-staging" // Different namespace
          }
        ]
      }
    }
  }
}
```

## Migrations

Migrations manage Durable Object storage schema changes.

### Adding a New Agent

Add to `new_sqlite_classes` in a new migration:

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["ExistingAgent"]
  },
  {
    "tag": "v2",
    "new_sqlite_classes": ["NewAgent"]
  }
]
```

### Renaming an Agent Class

Use `renamed_classes`:

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["OldName"]
  },
  {
    "tag": "v2",
    "renamed_classes": [
      {
        "from": "OldName",
        "to": "NewName"
      }
    ]
  }
]
```

**Important:** Also update:

1. The class name in code
2. The `class_name` in bindings
3. Export statements

### Deleting an Agent Class

Use `deleted_classes`:

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["AgentToDelete", "AgentToKeep"]
  },
  {
    "tag": "v2",
    "deleted_classes": ["AgentToDelete"]
  }
]
```

**Warning:** This permanently deletes all data for that class.

### Migration Best Practices

1. **Never modify existing migrations** - Always add new ones
2. **Use sequential tags** - v1, v2, v3 (or use dates: 2025-01-15)
3. **Test locally first** - Migrations run on deploy
4. **Back up production data** - Before renaming or deleting

## Troubleshooting

### "No such Durable Object class"

The class isn't in migrations:

```jsonc
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["MissingClassName"]  // Add it here
  }
]
```

### "Cannot find module" in types

Regenerate types:

```bash
npx wrangler types env.d.ts --include-runtime false
```

### Secrets not loading locally

Check that `.env` exists and contains the variable:

```bash
cat .env
# Should show: MY_SECRET=value
```

### Migration tag conflict

Migration tags must be unique. If you see conflicts:

```jsonc
// Wrong - duplicate tags
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["A"] },
  { "tag": "v1", "new_sqlite_classes": ["B"] }  // Error!
]

// Correct - sequential tags
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["A"] },
  { "tag": "v2", "new_sqlite_classes": ["B"] }
]
```
