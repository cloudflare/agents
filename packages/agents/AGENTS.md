# AGENTS.md — packages/agents

The core Agents SDK, published to npm as `agents`. This is the most complex package in the monorepo.

## Package exports

Each export maps to a public entry point that users `import` from. These are the boundaries of the public API — changes here need a changeset.

| Import path                  | Source file(s)               | Purpose                                                                      |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `agents`                     | `src/index.ts`               | Agent base class, routing, connections, RPC, state, scheduling, SQL          |
| `agents/client`              | `src/client.ts`              | Browser/Node WebSocket client (`AgentClient`) via partysocket                |
| `agents/react`               | `src/react.tsx`              | `useAgent` React hook, state sync, RPC from components                       |
| `agents/chat`                | `src/chat/index.ts`          | Shared chat primitives used by `@cloudflare/ai-chat` and `@cloudflare/think` |
| `agents/mcp`                 | `src/mcp/index.ts`           | `McpAgent` base class for building MCP servers                               |
| `agents/mcp/client`          | `src/mcp/client.ts`          | MCP client manager (connect to remote MCP servers from an Agent)             |
| `agents/email`               | `src/email.ts`               | Email routing, resolvers, header signing                                     |
| `agents/workflows`           | `src/workflows.ts`           | `AgentWorkflow` — Workflows integrated with Agents                           |
| `agents/schedule`            | `src/schedule.ts`            | Scheduling types                                                             |
| `agents/observability`       | `src/observability/index.ts` | Observability event types and emitters                                       |
| `agents/ai-chat-agent`       | `src/ai-chat-agent.ts`       | Legacy AI chat agent (prefer `@cloudflare/ai-chat`)                          |
| `agents/ai-react`            | `src/ai-react.tsx`           | Legacy AI React hooks (prefer `@cloudflare/ai-chat`)                         |
| `agents/tsconfig`            | `agents.tsconfig.json`       | Shared TypeScript config for all projects in the repo                        |
| `agents/vite`                | `src/vite.ts`                | Vite plugin — decorator transforms and the `agents:skills` import transform  |
| `agents/skills`              | `src/skills/index.ts`        | Framework-agnostic Agent Skills engine — sources, `SkillRegistry`, runner    |
| `agents/experimental/webmcp` | `src/experimental/webmcp.ts` | WebMCP adapter — bridges MCP tools to Chrome's `navigator.modelContext`      |
| `agents/browser`             | `src/browser/index.ts`       | Browser Run helpers — CDP sessions, connector, Quick Action primitives       |
| `agents/browser/ai`          | `src/browser/ai.ts`          | AI SDK browser tools — `createBrowserTools` (CDP) + `createQuickActionTools` |
| `agents/browser/tanstack-ai` | `src/browser/tanstack-ai.ts` | TanStack AI browser tool (`browser_execute`)                                 |

The `agents:skills` virtual-module types ship from `skills-module.d.ts` (referenced from the built `dist/index.d.ts`); `@cloudflare/think` consumes `agents/skills` and `@cloudflare/ai-chat` can too.

## Source layout

```
src/
  index.ts              # Agent class (~6000 lines) — the core of everything
  client.ts             # AgentClient (browser WebSocket client)
  react.tsx             # useAgent hook
  sub-routing.ts        # Nested /sub/... routing helpers + getSubAgentByName
  email.ts              # Email routing utilities
  workflows.ts          # AgentWorkflow base class
  schedule.ts           # Scheduling types and helpers
  serializable.ts       # RPC serialization types
  types.ts              # Shared message type enums
  utils.ts              # Helpers (camelCaseToKebabCase, etc.)
  internal_context.ts   # AsyncLocalStorage context for getCurrentAgent()

  chat/                 # Shared chat toolkit (mostly for sibling packages)
    index.ts            # Barrel for shared chat primitives
    lifecycle.ts        # Shared hook/result types (AIChatAgent + Think)
    protocol.ts         # Chat protocol constants
    turn-queue.ts       # Serialized chat turns / concurrency strategies
    resumable-stream.ts # Chunk persistence + replay
    ...                 # Sanitization, tool-state, continuation, etc.

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

  skills/               # Framework-agnostic Agent Skills engine
    index.ts            # Barrel — sources, registry, runner, types
    types.ts            # SkillSource, SkillRegistrySnapshot, SkillRunContext, etc.
    frontmatter.ts      # SKILL.md YAML frontmatter parser
    registry.ts         # SkillRegistry — catalog prompt + activation tools
    manifest.ts         # fromManifest() source (bundled skills)
    r2.ts               # r2() source (read-only R2-backed skills)
    runner.ts           # Experimental script runner + single capability bridge

  experimental/         # Experimental features (published but unstable)
    webmcp.ts           # WebMCP adapter (browser-side, uses MCP SDK client)

  browser/              # Browser Run integration (experimental)
    index.ts            # Barrel for agents/browser
    browser-run.ts      # Low-level Browser Run REST/binding calls + errors
    cdp-session.ts      # CdpSession — Chrome DevTools Protocol over WebSocket
    connector.ts        # BrowserConnector — codemode connector + session helpers
    session-manager.ts  # Durable session-id store + sweep
    spec.ts             # CDP protocol spec loader (cdp.spec())
    quick-actions.ts    # Stateless Quick Action primitives (browserMarkdown, …)
    ai.ts               # createBrowserTools + createQuickActionTools (AI SDK)
    tanstack-ai.ts      # createBrowserTools for TanStack AI

  core/                 # Internal utilities
    events.ts           # DisposableStore
```

## Build

```bash
pnpm run build          # runs tsx scripts/build.ts
```

Uses **tsdown** (ESM-only, with .d.ts generation and sourcemaps). Build entry points are explicitly listed in `scripts/build.ts` — if you add a new export, add it there too.

After build, `oxfmt --write` formats the generated `.d.ts` files.

The `check:exports` script at the repo root verifies that every `exports` entry in `package.json` has a corresponding file in `dist/`.

## Testing

Multiple separate test suites, each with its own vitest config:

### Workers tests (`src/tests/`)

```bash
pnpm run test:workers   # or: vitest -r src/tests
```

Runs inside the Workers runtime via `@cloudflare/vitest-pool-workers`. Uses a `wrangler.jsonc` to configure Durable Object bindings, queues, workflows, etc. Tests cover: state, scheduling, sub-agent routing, callable methods, WebSocket message handling, email routing, MCP protocol, workflows.

### React tests (`src/react-tests/`)

```bash
pnpm run test:react     # or: vitest -r src/react-tests
```

Runs in **Playwright (Chromium, headless)** via `vitest-browser-react`. A global setup script starts a miniflare worker on port 18787. Tests cover: `useAgent` hook, cache invalidation, cache TTL, state sync.

### CLI tests (`src/cli-tests/`)

```bash
pnpm run test:cli       # or: vitest -r src/cli-tests
```

Plain Node.js environment. Tests the `npx agents` CLI.

### WebMCP tests (`src/webmcp-tests/`)

```bash
pnpm run test:webmcp    # or: vitest --project webmcp
```

Runs in **Playwright (Chromium, headless)** via `@vitest/browser-playwright`. Tests the experimental WebMCP adapter: tool discovery, registration, execution relay, watch mode (SSE re-sync), error handling, and edge cases.

### x402 tests (`src/x402-tests/`)

```bash
pnpm run test:x402     # or: vitest --project x402
```

Focused tests for the x402 payment / auth integration.

### Browser connector e2e tests (`src/browser-tests/`)

```bash
pnpm run test:browser   # or: vitest run --config src/browser-tests/vitest.config.ts
```

Spawns a real `wrangler dev` (local Browser Rendering simulator + worker
loader) and exercises the `BrowserConnector` end to end: CDP spec queries,
`browser_execute` runs, and session lifecycle modes (one-shot, dynamic
promotion, reuse + sweep, survive-a-pause, multi-socket probe). Kept out of
the default `test` target so CI's `nx affected -t test` doesn't require
Chromium — run it locally when touching `src/browser/`.

### Chat primitive tests (`src/chat/__tests__/`)

```bash
vitest --project chat
```

Low-level tests for shared chat primitives in `src/chat/` (turn queue,
resumable streams, sanitization, etc.). These back both
`@cloudflare/ai-chat` and `@cloudflare/think`.

### Type-level tests (`src/tests-d/`)

Files ending in `.test-d.ts`. These use `expectTypeOf` / `assertType` to verify TypeScript types at compile time. They're checked by the typecheck script, not by vitest directly.

### E2E tests (`src/e2e/`)

```bash
pnpm run test:e2e       # or: vitest run src/e2e/e2e.test.ts
```

End-to-end tests that start real workers and test MCP server flows.

### Evals (`evals/`)

```bash
pnpm run evals          # runs evalite inside evals/
```

AI evaluation suite (scheduling accuracy, etc.). Requires API keys in `.env`.

## Key architecture notes

- **Agent extends partyserver's `Server`** — Durable Object lifecycle, WebSocket hibernation, and connection management come from `partyserver`. The Agent class adds state sync, RPC, scheduling, SQL, MCP client, email, and workflows on top.
- **State sync is bidirectional** — `this.setState()` on the server broadcasts to all connected clients; `agent.setState()` from the client sends to the server. Both directions use the same message format (`MessageType.CF_AGENT_STATE`).
- **RPC is reflection-based** — public methods on Agent subclasses are automatically callable from clients via `agent.call("methodName", ...args)`. Serialization constraints are enforced by the `Serializable` type system (`src/serializable.ts`).
- **Sub-agents are facets** — `subAgent(Cls, name)` creates or resolves a child DO colocated on the same machine. Clients reach a child via `/agents/{parent}/{name}/sub/{child}/{name}` and `useAgent({ sub: [...] })`. Parents gate access with `onBeforeSubAgent`; children reach their parent with `parentAgent(Cls)` or `parentPath`.
- **Scheduling uses cron-schedule** — `this.schedule()` accepts delays, Dates, or cron strings. Schedules persist in SQLite and survive hibernation.
- **MCP has two sides** — `McpAgent` (in `mcp/index.ts`) lets you _build_ an MCP server. `MCPClientManager` (in `mcp/client.ts`) lets an Agent _connect to_ external MCP servers.

## Boundaries

- Every new public export needs: an entry in `package.json` `exports`, a build entry in `scripts/build.ts`, and a changeset
- `src/index.ts` is very large (~6000 lines) — be surgical with edits, understand the full context before changing
- `agents/chat` is published and versioned, but treat it as a sibling-package support layer first, not a broad user-facing surface. Prefer documenting `@cloudflare/ai-chat` / `@cloudflare/think` directly unless a primitive is intentionally shared.
- The `partyserver`/`partysocket` dependency is foundational — don't try to replace it
- Peer dependencies (`ai`, `@ai-sdk/*`, `react`, `zod`) are optional — guard usage with runtime checks or separate entry points

## Related

- **User-facing docs** for the SDK live in `/docs` (see `/docs/AGENTS.md` for writing guidelines)
- **Design decisions** about the SDK live in `/design` (see `/design/AGENTS.md`)
