# AGENTS.md — packages/agents

The core Agents SDK, published to npm as `agents`. This is the most complex package in the monorepo.

## Package exports

Each export maps to a public entry point that users `import` from. These are the boundaries of the public API — changes here need a changeset.

| Import path            | Source file(s)               | Purpose                                                             |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `agents`               | `src/index.ts`               | Agent base class, routing, connections, RPC, state, scheduling, SQL |
| `agents/client`        | `src/client.ts`              | Browser/Node WebSocket client (`AgentClient`) via partysocket       |
| `agents/react`         | `src/react.tsx`              | `useAgent` React hook, state sync, RPC from components              |
| `agents/mcp`           | `src/mcp/index.ts`           | `McpAgent` base class for building MCP servers                      |
| `agents/mcp/client`    | `src/mcp/client.ts`          | MCP client manager (connect to remote MCP servers from an Agent)    |
| `agents/email`         | `src/email.ts`               | Email routing, resolvers, header signing                            |
| `agents/workflows`     | `src/workflows.ts`           | `AgentWorkflow` — Workflows integrated with Agents                  |
| `agents/schedule`      | `src/schedule.ts`            | Scheduling types                                                    |
| `agents/observability` | `src/observability/index.ts` | Observability event types and emitters                              |
| `agents/ai-chat-agent` | `src/ai-chat-agent.ts`       | Legacy AI chat agent (prefer `@cloudflare/ai-chat`)                 |
| `agents/ai-react`      | `src/ai-react.tsx`           | Legacy AI React hooks (prefer `@cloudflare/ai-chat`)                |

## Source layout

```
src/
  index.ts              # Agent class (~3500 lines) — the core of everything
  client.ts             # AgentClient (browser WebSocket client)
  react.tsx             # useAgent hook
  email.ts              # Email routing utilities
  workflows.ts          # AgentWorkflow base class
  schedule.ts           # Scheduling types and helpers
  serializable.ts       # RPC serialization types
  types.ts              # Shared message type enums
  utils.ts              # Helpers (camelCaseToKebabCase, etc.)
  internal_context.ts   # AsyncLocalStorage context for getCurrentAgent()

  mcp/                  # MCP (Model Context Protocol) subsystem
    index.ts            # McpAgent base class
    handler.ts          # HTTP/SSE/WebSocket MCP transport handler
    transport.ts        # SSE + Streamable HTTP transports
    client.ts           # MCPClientManager for connecting to remote MCP servers
    client-connection.ts
    client-storage.ts
    client-transports.ts
    do-oauth-client-provider.ts
    x402.ts             # x402 payment protocol for MCP
    types.ts
    utils.ts
    errors.ts
    auth-context.ts
    worker-transport.ts

  observability/        # Observability event system
    index.ts
    base.ts
    agent.ts            # Agent-level events
    mcp.ts              # MCP-level events

  cli/                  # `npx agents` CLI
    index.ts
    create.ts

  codemode/             # Experimental code generation
    ai.ts

  core/                 # Internal utilities
    events.ts           # DisposableStore
```

## Build

```bash
npm run build           # runs tsx scripts/build.ts
```

Uses **tsdown** (ESM-only, with .d.ts generation and sourcemaps). Build entry points are explicitly listed in `scripts/build.ts` — if you add a new export, add it there too.

After build, `oxfmt --write` formats the generated `.d.ts` files.

The `check:exports` script at the repo root verifies that every `exports` entry in `package.json` has a corresponding file in `dist/`.

## Testing

Four separate test suites, each with its own vitest config:

### Workers tests (`src/tests/`)

```bash
npm run test:workers    # or: vitest -r src/tests
```

Runs inside the Workers runtime via `@cloudflare/vitest-pool-workers`. Uses a `wrangler.jsonc` to configure Durable Object bindings, queues, workflows, etc. Tests cover: state, scheduling, routing, callable methods, WebSocket message handling, email routing, MCP protocol, workflows.

### React tests (`src/react-tests/`)

```bash
npm run test:react      # or: vitest -r src/react-tests
```

Runs in **Playwright (Chromium, headless)** via `vitest-browser-react`. A global setup script starts a miniflare worker on port 18787. Tests cover: `useAgent` hook, cache invalidation, cache TTL, state sync.

### CLI tests (`src/cli-tests/`)

```bash
npm run test:cli        # or: vitest -r src/cli-tests
```

Plain Node.js environment. Tests the `npx agents` CLI.

### Type-level tests (`src/tests-d/`)

Files ending in `.test-d.ts`. These use `expectTypeOf` / `assertType` to verify TypeScript types at compile time. They're checked by the typecheck script, not by vitest directly.

### E2E tests (`src/e2e/`)

```bash
npm run test:e2e        # or: vitest run src/e2e/e2e.test.ts
```

End-to-end tests that start real workers and test MCP server flows.

### Evals (`evals/`)

```bash
npm run evals           # runs evalite inside evals/
```

AI evaluation suite (scheduling accuracy, etc.). Requires API keys in `.env`.

## Key architecture notes

- **Agent extends partyserver's `Server`** — Durable Object lifecycle, WebSocket hibernation, and connection management come from `partyserver`. The Agent class adds state sync, RPC, scheduling, SQL, MCP client, email, and workflows on top.
- **State sync is bidirectional** — `this.setState()` on the server broadcasts to all connected clients; `agent.setState()` from the client sends to the server. Both directions use the same message format (`MessageType.CF_AGENT_STATE`).
- **RPC is reflection-based** — public methods on Agent subclasses are automatically callable from clients via `agent.call("methodName", ...args)`. Serialization constraints are enforced by the `Serializable` type system (`src/serializable.ts`).
- **Scheduling uses cron-schedule** — `this.schedule()` accepts delays, Dates, or cron strings. Schedules persist in SQLite and survive hibernation.
- **MCP has two sides** — `McpAgent` (in `mcp/index.ts`) lets you _build_ an MCP server. `MCPClientManager` (in `mcp/client.ts`) lets an Agent _connect to_ external MCP servers.

## Boundaries

- Every new public export needs: an entry in `package.json` `exports`, a build entry in `scripts/build.ts`, and a changeset
- `src/index.ts` is very large (~3500 lines) — be surgical with edits, understand the full context before changing
- The `partyserver`/`partysocket` dependency is foundational — don't try to replace it
- Peer dependencies (`ai`, `@ai-sdk/*`, `react`, `zod`) are optional — guard usage with runtime checks or separate entry points

## Related

- **User-facing docs** for the SDK live in `/docs` (see `/docs/AGENTS.md` for writing guidelines)
- **Design decisions** about the SDK live in `/design` (see `/design/AGENTS.md`)
