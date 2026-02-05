# Problems Encountered

A log of issues encountered during development and how they were resolved.

---

## 1. AI SDK v6 API Breaking Changes

**When**: Implementing Phase 4 (LLM Integration)

**Problem**: The AI SDK had been updated to v6, and several APIs had changed from the examples/documentation we were following.

**Errors**:

```
Module '"ai"' has no exported member 'CoreMessage'
Object literal may only specify known properties, and 'maxTokens' does not exist
Property 'args' does not exist on type 'TypedToolCall'
Property 'result' does not exist on type 'ToolResultPart'
Property 'promptTokens' does not exist on type 'LanguageModelUsage'
```

**Solution**: Updated to the v6 API:

| Old (v5)                 | New (v6)                   |
| ------------------------ | -------------------------- |
| `CoreMessage`            | `ModelMessage`             |
| `maxTokens: N`           | `stopWhen: stepCountIs(N)` |
| `toolCall.args`          | `toolCall.input`           |
| `toolResult.result`      | `toolResult.output`        |
| `usage.promptTokens`     | `usage.inputTokens`        |
| `usage.completionTokens` | `usage.outputTokens`       |

**Lesson**: Always check the actual installed package version and its types, don't rely on potentially outdated documentation.

---

## 2. Zod Schemas Not Working with AI SDK Tools

**When**: Defining tool input schemas for the LLM

**Problem**: The AI SDK's `tool()` function wasn't correctly interpreting Zod schemas for JSON Schema conversion.

**Errors**:

```
Agent error: Invalid schema for function 'bash': schema must be a JSON Schema of 'type: "object"', got 'type: "None"'
Agent error: Cannot read properties of undefined (reading '_zod')
```

**Attempts**:

1. Using `z.object({...})` directly - Failed with "type: None"
2. Using `import { z } from "zod/v4"` with `zodSchema(z.object(...))` - Failed with `_zod` undefined

**Solution**: Use explicit JSON Schema definitions with `jsonSchema<T>()`:

```typescript
// Instead of:
inputSchema: z.object({ command: z.string() });

// Use:
inputSchema: jsonSchema<{ command: string }>({
  type: "object",
  properties: {
    command: { type: "string", description: "..." }
  },
  required: ["command"]
});
```

**Lesson**: When integrating libraries, sometimes the "cleaner" abstraction (Zod) doesn't work, and you need to drop down to the lower-level format (JSON Schema).

---

## 3. FetchLoopback Reserved Method Name

**When**: Implementing Phase 3.3 (Controlled Fetch)

**Problem**: Named the main method `fetch()` on the `FetchLoopback` WorkerEntrypoint, but `fetch` is a reserved method on Service bindings in Cloudflare Workers.

**Errors**:

```
TypeError: url.startsWith is not a function
TypeError: Incorrect type for Promise: the Promise did not resolve to 'Response'.
```

**Root Cause**:

- The Workers runtime treats a `fetch` method on Service bindings specially
- It expects `fetch()` to return a `Response`, not our custom `FetchResult` object
- The RPC boundary was also altering the URL parameter's type

**Solution**:

1. Renamed the method from `fetch` to `request`
2. Added explicit type coercion: `const url = String(urlInput)`

```typescript
// Before:
async fetch(url: string, options?: {...}): Promise<FetchResult | FetchError>

// After:
async request(urlInput: string, options?: {...}): Promise<FetchResult | FetchError> {
  const url = String(urlInput); // Ensure string after RPC
  // ...
}
```

**Lesson**: Be aware of reserved method names on Cloudflare primitives. `fetch` is special on Workers/Service bindings.

---

## 4. vitest-pool-workers Durable Object Testing

**When**: Setting up integration tests

**Problem**: Testing Durable Objects with `vitest-pool-workers` required specific configuration that wasn't immediately obvious.

**Issues**:

- Module resolution and bundling
- Durable Object namespace bindings
- Compatibility flags needed for tests

**Solution**: Proper `vitest.config.ts` configuration:

```typescript
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          durableObjects: {
            Coder: "Coder"
          },
          compatibilityFlags: ["nodejs_compat", "experimental"]
        }
      }
    }
  }
});
```

And proper test environment declaration:

```typescript
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    Coder: DurableObjectNamespace;
  }
}
```

**Lesson**: Cloudflare's test pool has its own configuration requirements separate from wrangler.jsonc.

---

## 5. @cloudflare/playwright in Test Environment

**When**: Implementing Phase 3.5 (Browser Automation)

**Problem**: The `@cloudflare/playwright` package imports `node:child_process`, which isn't available in the `vitest-pool-workers` test environment.

**Error**:

```
Error: No such module "node:child_process".
  imported from "@cloudflare/playwright/lib/playwright-core/src/inProcessFactory.js"
```

**Root Cause**:

- `@cloudflare/playwright` is designed for the actual Workers runtime where Browser Rendering is available
- The vitest-pool-workers environment doesn't support all Node.js built-in modules
- Even type-only imports (`import type {...}`) can trigger module evaluation in some bundlers
- Exporting a class from a module causes that module to be bundled and evaluated

**Attempts**:

1. Type-only exports - Still triggered module loading
2. Separate exports file - Same issue
3. Dynamic imports - Would require async changes throughout

**Solution**:

1. Don't export `BrowserLoopback` from the main server module
2. Make browser optional in `ToolContext` interface
3. Check for browser availability at runtime
4. Return graceful error from browser tools when not available

```typescript
// In ToolContext
browser?: BrowserLoopbackInterface;

// In tool execute functions
if (!ctx.browser) {
  return { error: "Browser automation is not available", code: "NO_BROWSER" };
}

// In getToolContext
if ("BROWSER" in this.env && this.env.BROWSER) {
  // Only add browser if binding exists AND BrowserLoopback is available
  const exports = this.ctx.exports as ExportsWithBrowser;
  if (exports.BrowserLoopback) {
    context.browser = exports.BrowserLoopback({ props: { sessionId } });
  }
}
```

**Lesson**: Some Cloudflare packages are runtime-only and can't be tested in simulated environments. Design for graceful degradation.

---

## 6. RPC Boundary Type Coercion

**When**: Various loopback implementations

**Problem**: Values passed through the RPC boundary between parent Durable Object and dynamic workers sometimes have their types altered.

**Example**: A URL string might become a different type after RPC serialization/deserialization.

**Solution**: Always coerce/validate types at the beginning of loopback methods:

```typescript
async request(urlInput: string, ...): Promise<...> {
  const url = String(urlInput); // Ensure it's actually a string
  // ...
}
```

**Lesson**: Don't trust that RPC will preserve JavaScript types exactly. Validate/coerce at boundaries.

---

## 7. Static Map State in WorkerEntrypoint

**When**: Implementing loopbacks with persistent state

**Consideration**: WorkerEntrypoint classes are instantiated fresh for each RPC call, so instance properties don't persist.

**Solution**: Use `static` Maps to store state that should persist across calls:

```typescript
export class BashLoopback extends WorkerEntrypoint<Env, Props> {
  // Static - persists across RPC calls
  private static instances: Map<string, Bash> = new Map();

  // Instance - fresh each call
  private sessionId: string;
}
```

**Lesson**: Understand the lifecycle of WorkerEntrypoint instances. Use static for persistence, instance for per-call state.

---

## 8. Dual Entry Points for Browser/Test Separation

**When**: Browser automation works in production but breaks tests

**Error**: Tests fail because exporting `BrowserLoopback` causes `@cloudflare/playwright` to be bundled, which requires `node:child_process`.

**Root Cause**: ES module exports are resolved at bundle time. Any `export { X } from "..."` statement causes the entire module tree to be included in the bundle.

**Solution**: Use separate entry points for production and testing:

```
src/server-without-browser.ts - Base server (no browser) - used for tests
src/server.ts                 - Re-exports base + adds BrowserLoopback
wrangler.jsonc                - Points to server.ts (production)
wrangler.test.jsonc           - Points to server-without-browser.ts (tests)
vitest.config.ts              - Uses wrangler.test.jsonc
```

**server.ts** (production entry point):

```typescript
// Re-export all named exports from the base server
export * from "./server-without-browser";

// Re-export the default export (the Worker fetch handler)
export { default } from "./server-without-browser";

// Add BrowserLoopback for production use
export { BrowserLoopback } from "./loopbacks/browser";
```

**Key insight**: `export *` does NOT include the default export. You must explicitly re-export it with `export { default }`.

**Lesson**: When a dependency is incompatible with your test environment, use separate entry points rather than trying to configure bundler exclusions.

---

## 9. Durable Object Facets in Test Environment

**When**: Implementing Phase 5.5 (Subagent Parallel Execution)

**Problem**: The experimental Durable Object Facets API doesn't work correctly in `vitest-pool-workers` - the `ctx.facets.get()` call fails when passing a class directly.

**Error**:

```
TypeError: Incorrect type for the 'class' field on 'StartupOptions': the provided value is not
of type 'DurableObjectClass or LoopbackDurableObjectNamespace or LoopbackColoLocalActorNamespace'.
```

**Root Cause**:

- Facets require the class to be recognized as a `DurableObjectClass`
- In the vitest-pool-workers environment, the class is just a regular ES class
- The runtime expects a namespace binding or internal DO class representation
- The `experimental` compatibility flag is set, but facets have additional runtime requirements

**Attempts**:

1. Pass raw class to `facets.get()` - Failed with type error
2. Export class from main module - Same error
3. Add class to wrangler DO bindings - Would create separate DO, not facet

**Solution**: Design for graceful degradation and test in production:

```typescript
// Make SubagentManager handle missing facets gracefully
async spawnSubagent(task: Task, context?: string): Promise<string> {
  const facetName = `subagent-${task.id}`;

  // This may throw if facets aren't supported
  const facet = this.ctx.facets.get<Subagent>(facetName, () => ({
    class: Subagent
  }));

  // Catch errors from async execution to prevent unhandled rejections
  facet.execute({...}).catch((error: Error) => {
    console.error(`Subagent ${facetName} execution failed:`, error.message);
    this.activeSubagents.delete(task.id);
  });

  return facetName;
}

// Return sensible defaults when facets aren't available
async getSubagentStatus(taskId: string): Promise<SubagentStatus | null> {
  if (!this.activeSubagents.has(taskId)) return null;

  try {
    const facet = this.ctx.facets.get<Subagent>(...);
    return facet.getStatus();
  } catch {
    // Facets not available - return tracking info
    const tracking = this.activeSubagents.get(taskId);
    return tracking ? { taskId, status: "pending", startedAt: tracking.startedAt } : null;
  }
}
```

**Test Strategy**:

1. **Unit tests (run by default)**: Test types, tracking logic, task creation
2. **Infrastructure tests (run by default)**: Verify endpoints exist, tasks are created
3. **Facet tests (skip by default)**: Require `RUN_FACET_TESTS=true` and production environment
4. **LLM integration tests (skip by default)**: Require `RUN_SLOW_TESTS=true` and API key

```bash
# Regular tests (always pass)
npm test

# Test facets in production
wrangler dev  # Then test manually or with curl

# Full integration
RUN_SLOW_TESTS=true npm test -- src/__tests__/loader.subagent.test.ts
```

**Lesson**: Experimental APIs may have different behavior in test vs production environments. Design tests to degrade gracefully and document how to run full integration tests.

---

## 10. TypeScript Errors with AI SDK Tool Types

**When**: Implementing task management and subagent tools

**Problem**: TypeScript's strict type checking conflicts with the AI SDK's generic `tool()` function return type when building a dynamic tool registry.

**Error**:

```
Type 'Tool<...>' is not assignable to type 'Tool<never, never>'
```

**Root Cause**:

- Each `tool()` call returns a specific generic type based on its input/output schemas
- When collecting tools into a `Record<string, Tool>`, TypeScript can't unify the different generic parameters
- The AI SDK's type definitions are complex and don't easily compose

**Solution**: Use `any` with a biome-ignore comment:

```typescript
export function createTools(ctx: ToolContext) {
  // biome-ignore lint/suspicious/noExplicitAny: Tool types are complex and vary
  const tools: Record<string, any> = {
    bash: createBashTool(ctx),
    readFile: createReadFileTool(ctx)
    // ...
  };

  // Conditionally add tools
  if (ctx.tasks) {
    tools.createSubtask = createCreateSubtaskTool(ctx);
  }

  return tools;
}
```

**Lesson**: Sometimes strict typing gets in the way of practical code. When dealing with complex third-party types, pragmatic `any` with documentation is acceptable.

---

## 11. SQL Tagged Template vs exec() API

**When**: Implementing task management SQLite integration

**Problem**: The `this.sql` tagged template literal in Agents SDK behaves differently from raw SQL APIs.

**Errors**:

```
Property 'exec' does not exist on type '...'
Property 'toArray' does not exist on type '...'
```

**Root Cause**:

- The Agents SDK provides `this.sql` as a tagged template function
- It doesn't expose `.exec()` for DDL statements
- Query results are already arrays, no `.toArray()` needed
- This differs from the raw `DurableObjectState.storage.sql` API

**Solution**: Adapt to the tagged template pattern:

```typescript
// DDL statements - split into individual calls
this.sql`CREATE TABLE IF NOT EXISTS tasks (...)`;
this.sql`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`;

// Queries - result is already an array
const rows = this.sql`SELECT * FROM tasks WHERE session_id = ${id}`;
for (const row of rows) {
  // No .toArray() needed
}
```

**Lesson**: Different Cloudflare APIs expose SQLite differently. Check the specific API you're using, not just generic SQLite examples.

---

## Summary

| Problem                    | Category                | Impact               |
| -------------------------- | ----------------------- | -------------------- |
| AI SDK v6 changes          | API versioning          | Build errors         |
| Zod schema issues          | Library integration     | Runtime errors       |
| Reserved `fetch` method    | Platform knowledge      | Runtime errors       |
| vitest-pool-workers config | Testing                 | Tests wouldn't run   |
| Playwright in tests        | Environment limitations | Tests failing        |
| RPC type coercion          | Platform behavior       | Runtime errors       |
| Static vs instance state   | Architecture            | State not persisting |
| Dual entry points          | Build configuration     | Browser in prod only |
| Facets in test env         | Experimental APIs       | Tests need prod env  |
| AI SDK tool types          | TypeScript complexity   | Build errors         |
| SQL tagged template        | API differences         | Build errors         |

The biggest lessons:

1. **Check actual installed versions** - Don't trust docs to match your version
2. **Know platform reserved names** - `fetch` is special in Workers
3. **Design for graceful degradation** - Not all features work in all environments
4. **Validate at boundaries** - RPC, API calls, user input
5. **Use separate entry points** - When features can't work in test environments
6. **Experimental APIs need production testing** - Facets, new features may not work in vitest
7. **Pragmatic typing** - Sometimes `any` with documentation beats fighting TypeScript
8. **Know your SQL API** - Tagged templates vs raw SQL have different interfaces
