# @cloudflare/agents

## 0.4.0

### Minor Changes

- [#848](https://github.com/cloudflare/agents/pull/848) [`a167344`](https://github.com/cloudflare/agents/commit/a167344aab6960a51901886539c206a2c937bb1e) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Upgrade MCP SDK to 1.26.0 to prevent cross-client response leakage. Updated examples for stateless MCP Servers create new `McpServer` instance per request instead of sharing a single instance. A guard is added in this version of the MCP SDK which will prevent connection to a Server instance that has already been connected to a transport. Developers will need to modify their code if they declare their `McpServer` instance as a global variable.

- [#298](https://github.com/cloudflare/agents/pull/298) [`27f4e3e`](https://github.com/cloudflare/agents/commit/27f4e3ef4471f5c523a7e2f8a0ce548daa5738f5) Thanks [@jaredhanson](https://github.com/jaredhanson)! - Add `createMcpOAuthProvider` method to the `Agent` class, allowing subclasses to override the default OAuth provider used when connecting to MCP servers. This enables custom authentication strategies such as pre-registered client credentials or mTLS, beyond the built-in dynamic client registration.

- [#610](https://github.com/cloudflare/agents/pull/610) [`f59f305`](https://github.com/cloudflare/agents/commit/f59f30533121e6e9fd41e9a2e22184d2fa9bdb1b) Thanks [@threepointone](https://github.com/threepointone)! - Deprecate `onStateUpdate` server-side hook in favor of `onStateChanged`
  - `onStateChanged` is a drop-in rename of `onStateUpdate` (same signature, same behavior)
  - `onStateUpdate` still works but emits a one-time console warning per class
  - Throws if a class overrides both hooks simultaneously
  - `validateStateChange` rejections now propagate a `CF_AGENT_STATE_ERROR` message back to the client

- [#871](https://github.com/cloudflare/agents/pull/871) [`27f8f75`](https://github.com/cloudflare/agents/commit/27f8f755f04e23a71e7a0748c48a2e7ec25cede6) Thanks [@threepointone](https://github.com/threepointone)! - Migrate x402 MCP integration from legacy `x402` package to `@x402/core` and `@x402/evm` v2

  **Breaking changes for x402 users:**
  - Peer dependencies changed: replace `x402` with `@x402/core` and `@x402/evm`
  - `PaymentRequirements` type now uses v2 fields (e.g. `amount` instead of `maxAmountRequired`)
  - `X402ClientConfig.account` type changed from `viem.Account` to `ClientEvmSigner` (structurally compatible with `privateKeyToAccount()`)

  **Migration guide:**
  1. Update dependencies:

     ```bash
     npm uninstall x402
     npm install @x402/core @x402/evm
     ```

  2. Update network identifiers — both legacy names and CAIP-2 format are accepted:

     ```typescript
     // Before
     {
       network: "base-sepolia";
     }
     // After (either works)
     {
       network: "base-sepolia";
     } // legacy name, auto-converted
     {
       network: "eip155:84532";
     } // CAIP-2 format (preferred)
     ```

  3. If you access `PaymentRequirements` fields in callbacks, update to v2 field names (see `@x402/core` docs).
  4. The `version` field on `X402Config` and `X402ClientConfig` is now deprecated and ignored — the protocol version is determined automatically.

  **Other changes:**
  - `X402ClientConfig.network` is now optional — the client auto-selects from available payment requirements
  - Server-side lazy initialization: facilitator connection is deferred until the first paid tool invocation
  - Payment tokens support both v2 (`PAYMENT-SIGNATURE`) and v1 (`X-PAYMENT`) HTTP headers
  - Added `normalizeNetwork` export for converting legacy network names to CAIP-2 format
  - Re-exports `PaymentRequirements`, `PaymentRequired`, `Network`, `FacilitatorConfig`, and `ClientEvmSigner` from `agents/x402`

### Patch Changes

- [#610](https://github.com/cloudflare/agents/pull/610) [`f59f305`](https://github.com/cloudflare/agents/commit/f59f30533121e6e9fd41e9a2e22184d2fa9bdb1b) Thanks [@threepointone](https://github.com/threepointone)! - Add readonly connections: restrict WebSocket clients from modifying agent state
  - New hooks: `shouldConnectionBeReadonly`, `setConnectionReadonly`, `isConnectionReadonly`
  - Blocks both client-side `setState()` and mutating `@callable()` methods for readonly connections
  - Readonly flag stored in a namespaced connection attachment (`_cf_readonly`), surviving hibernation without extra SQL
  - Connection state wrapping hides the internal flag from user code and preserves it across `connection.setState()` calls
  - Client-side `onStateUpdateError` callback for handling rejected state updates

- [#855](https://github.com/cloudflare/agents/pull/855) [`271a3cf`](https://github.com/cloudflare/agents/commit/271a3cffd769d646b1d6498f5676662ced94cf27) Thanks [@threepointone](https://github.com/threepointone)! - Fix `useAgent` and `AgentClient` crashing when using `basePath` routing.

- [#868](https://github.com/cloudflare/agents/pull/868) [`b3e2dc1`](https://github.com/cloudflare/agents/commit/b3e2dc1c389b0d874eee5407099d8c20fe684b8b) Thanks [@threepointone](https://github.com/threepointone)! - Fix MCP OAuth callback URL leaking instance name

  Add `callbackPath` option to `addMcpServer` to prevent instance name leakage in MCP OAuth callback URLs. When `sendIdentityOnConnect` is `false`, `callbackPath` is now required — the default callback URL would expose the instance name, undermining the security intent. Also fixes callback request detection to match via the `state` parameter instead of a loose `/callback` URL substring check, enabling custom callback paths.

- [#872](https://github.com/cloudflare/agents/pull/872) [`de71f9e`](https://github.com/cloudflare/agents/commit/de71f9ecfae019061651716cb7d2a350a4283ada) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [`8893fbe`](https://github.com/cloudflare/agents/commit/8893fbef32bea9581dd308d5b6d9c066e135feef) Thanks [@threepointone](https://github.com/threepointone)! - partykit releases

  ## partyserver

  ### `0.1.3` (Feb 8, 2026)
  - [#319](https://github.com/cloudflare/partykit/pull/319) — Add `configurable: true` to the `state`, `setState`, `serializeAttachment`, and `deserializeAttachment` property descriptors on connection objects. This allows downstream consumers (like the Cloudflare Agents SDK) to redefine these properties with `Object.defineProperty` for namespacing or wrapping internal state storage. Default behavior is unchanged.

  ### `0.1.4` (Feb 9, 2026)
  - [#320](https://github.com/cloudflare/partykit/pull/320) — **Add CORS support to `routePartykitRequest`**. Pass `cors: true` for permissive defaults or `cors: { ...headers }` for custom CORS headers. Preflight (OPTIONS) requests are handled automatically for matched routes, and CORS headers are appended to all non-WebSocket responses — including responses returned by `onBeforeRequest`.
  - [#260](https://github.com/cloudflare/partykit/pull/260) — Remove redundant initialize code as `setName` takes care of it, along with the nested `blockConcurrencyWhile` call.

  ***

  ## partysocket

  ### `1.1.12` (Feb 8, 2026)
  - [#317](https://github.com/cloudflare/partykit/pull/317) — Fix `PartySocket.reconnect()` crashing when using `basePath` without `room`. The reconnect guard now accepts either `room` or `basePath` as sufficient context to construct a connection URL.
  - [#319](https://github.com/cloudflare/partykit/pull/319) — Throw a clear error when constructing a `PartySocket` without `room` or `basePath` (and without `startClosed: true`), instead of silently connecting to a malformed URL containing `"undefined"` as the room name.

  ### `1.1.13` (Feb 9, 2026)
  - [#322](https://github.com/cloudflare/partykit/pull/322) — Fix `reconnect()` not working after `maxRetries` has been exhausted. The `_connectLock` was not released when the max retries early return was hit in `_connect()`, preventing any subsequent `reconnect()` call from initiating a new connection.

- [#869](https://github.com/cloudflare/agents/pull/869) [`fc17506`](https://github.com/cloudflare/agents/commit/fc17506a1d6fb8f6b7fed56be98ab1729d338c2c) Thanks [@threepointone](https://github.com/threepointone)! - Remove `room`/`party` workaround for `basePath` routing now that partysocket handles reconnect without requiring `room` to be set.

- [#873](https://github.com/cloudflare/agents/pull/873) [`d0579fa`](https://github.com/cloudflare/agents/commit/d0579fa13a60e47395a2dde199be3197299b8668) Thanks [@threepointone](https://github.com/threepointone)! - Remove CORS wrapping from `routeAgentRequest` and delegate to partyserver's native CORS support. The `cors` option is now passed directly through to `routePartykitRequest`, which handles preflight and response headers automatically since partyserver 0.1.4.

- [#865](https://github.com/cloudflare/agents/pull/865) [`c3211d0`](https://github.com/cloudflare/agents/commit/c3211d0b0cc36aa294c15569ae650d3afeab9926) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- Updated dependencies [[`21a7977`](https://github.com/cloudflare/agents/commit/21a79778f5150aecd890f55a164d397f70db681e), [`3de98a3`](https://github.com/cloudflare/agents/commit/3de98a398d55aeca51c7b845ed4c5d6051887d6d), [`c3211d0`](https://github.com/cloudflare/agents/commit/c3211d0b0cc36aa294c15569ae650d3afeab9926)]:
  - @cloudflare/codemode@0.0.7
  - @cloudflare/ai-chat@0.0.7

## 0.3.10

### Patch Changes

- [#839](https://github.com/cloudflare/agents/pull/839) [`68916bf`](https://github.com/cloudflare/agents/commit/68916bfa08358d4bb5d61aff37acd8dc4ffc950e) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Invalidate query cache on disconnect to fix stale auth tokens

- [#841](https://github.com/cloudflare/agents/pull/841) [`3f490d0`](https://github.com/cloudflare/agents/commit/3f490d045844e4884db741afbb66ca1fe65d4093) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Escape authError to prevent XSS attacks and store it in the connection state to avoid needing script tags to display error.

- Updated dependencies [[`83f137f`](https://github.com/cloudflare/agents/commit/83f137f7046aeafc3b480b5aa4518f6290b14406)]:
  - @cloudflare/ai-chat@0.0.6

## 0.3.9

### Patch Changes

- [#837](https://github.com/cloudflare/agents/pull/837) [`b11b9dd`](https://github.com/cloudflare/agents/commit/b11b9dda37d85a474b07e6ca48fb8cee566db9cc) Thanks [@threepointone](https://github.com/threepointone)! - Fix AgentWorkflow run() method not being called in production

  The `run()` method wrapper was being set as an instance property in the constructor, but Cloudflare's RPC system invokes methods from the prototype chain. This caused the initialization wrapper to be bypassed in production, resulting in `_initAgent` never being called.

  Changed to wrap the subclass prototype's `run` method directly with proper safeguards:
  - Uses `Object.hasOwn()` to only wrap prototypes that define their own `run` method (prevents double-wrapping inherited methods)
  - Uses a `WeakSet` to track wrapped prototypes (prevents re-wrapping on subsequent instantiations)
  - Uses an instance-level `__agentInitCalled` flag to prevent double initialization if `super.run()` is called from a subclass

## 0.3.8

### Patch Changes

- [#833](https://github.com/cloudflare/agents/pull/833) [`6c80022`](https://github.com/cloudflare/agents/commit/6c80022713a120c1a93e6afe16d20aee9ab6c9cb) Thanks [@tarushnagpal](https://github.com/tarushnagpal)! - On invalid OAuth state, clear auth_url in storage and set the MCP connection state to FAILED ready for reconnection.

- [#834](https://github.com/cloudflare/agents/pull/834) [`2b4aecd`](https://github.com/cloudflare/agents/commit/2b4aecde7e6887764b5733033b615427cd564926) Thanks [@threepointone](https://github.com/threepointone)! - Fix AgentClient.close() to immediately reject pending RPC calls instead of waiting for WebSocket close handshake timeout.

  Previously, calling `client.close()` would not reject pending RPC calls until the WebSocket close handshake completed (which could take 15+ seconds in some environments). Now pending calls are rejected immediately when `close()` is called, providing faster feedback on intentional disconnects.

## 0.3.7

# agents@0.3.7 Release Notes

This release introduces **Cloudflare Workflows integration** for durable multi-step processing, **secure email reply routing** with HMAC-SHA256 signatures, **15+ new documentation files**, and significant improvements to state management, the callable RPC system, and scheduling.

## Highlights

- **Workflows Integration** - Seamless integration between Cloudflare Agents and Cloudflare Workflows for durable, multi-step background processing
- **Secure Email Routing** - HMAC-SHA256 signed email headers prevent unauthorized routing of emails to agent instances
- **Comprehensive Documentation** - 15+ new docs covering getting started, state, routing, HTTP/WebSocket lifecycle, callable methods, MCP, and scheduling
- **Synchronous `setState()`** - State updates are now synchronous with a new `validateStateChange()` validation hook
- **`scheduleEvery()` Method** - Fixed-interval recurring tasks with overlap prevention
- **Callable System Improvements** - Client-side RPC timeouts, streaming error signaling, introspection API
- **100+ New Tests** - Comprehensive test coverage across state, routing, callable, and email utilities

---

## Cloudflare Workflows Integration

Agents excel at real-time communication and state management. Workflows excel at durable execution. Together, they enable powerful patterns where Agents handle WebSocket connections while Workflows handle long-running tasks, retries, and human-in-the-loop flows.

### AgentWorkflow Base Class

Extend `AgentWorkflow` instead of `WorkflowEntrypoint` to get typed access to the originating Agent:

```typescript
import { AgentWorkflow } from "agents/workflows";

export class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(event: AgentWorkflowEvent<TaskParams>, step: AgentWorkflowStep) {
    // Call Agent methods via RPC
    await this.agent.updateStatus(params.taskId, "processing");

    // Non-durable: progress reporting
    await this.reportProgress({ step: "process", percent: 0.5 });
    this.broadcastToClients({ type: "update", taskId: params.taskId });

    // Durable via step: idempotent, won't repeat on retry
    await step.mergeAgentState({ taskProgress: 0.5 });
    await step.reportComplete(result);

    return result;
  }
}
```

### Agent Methods for Workflows

- `runWorkflow(workflowName, params, options?)` - Start workflow with optional metadata
- `sendWorkflowEvent(workflowName, workflowId, event)` - Send events to waiting workflows
- `getWorkflow(workflowId)` / `getWorkflows(criteria?)` - Query workflows with cursor-based pagination
- `deleteWorkflow(workflowId)` / `deleteWorkflows(criteria?)` - Delete workflows by ID or criteria
- `approveWorkflow(workflowId)` / `rejectWorkflow(workflowId)` - Human-in-the-loop approval flows
- `terminateWorkflow()`, `pauseWorkflow()`, `resumeWorkflow()`, `restartWorkflow()` - Workflow control

### Lifecycle Callbacks

```typescript
async onWorkflowProgress(workflowName, workflowId, progress) {}
async onWorkflowComplete(workflowName, workflowId, result?) {}
async onWorkflowError(workflowName, workflowId, error) {}
async onWorkflowEvent(workflowName, workflowId, event) {}
```

See `docs/workflows.md` for full documentation.

---

## Secure Email Reply Routing

Prevents unauthorized routing of emails to arbitrary agent instances using HMAC-SHA256 signed headers.

### New Resolver

```typescript
import { createSecureReplyEmailResolver } from "agents/email";

const resolver = createSecureReplyEmailResolver(env.EMAIL_SECRET, {
  maxAge: 7 * 24 * 60 * 60, // Optional: 7 days (default: 30 days)
  onInvalidSignature: (email, reason) => {
    console.warn(`Invalid signature from ${email.from}: ${reason}`);
  },
});
```

### Automatic Signing on Reply

```typescript
await this.replyToEmail(email, {
  fromName: "My Agent",
  body: "Thanks!",
  secret: this.env.EMAIL_SECRET, // Signs headers for secure reply routing
});
```

### Breaking Changes

- Email utilities moved to `agents/email` subpath
- `createHeaderBasedEmailResolver` removed (security vulnerability)
- New `onNoRoute` callback for handling unmatched emails

---

## New Documentation

| Document                        | Description                                                            |
| ------------------------------- | ---------------------------------------------------------------------- |
| `getting-started.md`            | Quick start guide: installation, first agent, state basics, deployment |
| `adding-to-existing-project.md` | Integrating agents into existing Workers, React apps, Hono             |
| `state.md`                      | State management, `validateStateChange()`, persistence, client sync    |
| `routing.md`                    | URL routing patterns, `basePath`, server-sent identity                 |
| `http-websockets.md`            | HTTP/WebSocket lifecycle hooks, connection management, hibernation     |
| `callable-methods.md`           | `@callable` decorator, RPC over WebSocket, streaming responses         |
| `mcp-client.md`                 | Connecting to MCP servers, OAuth flows, transport options              |
| `scheduling.md`                 | One-time, recurring (`scheduleEvery`), and cron-based scheduling       |
| `workflows.md`                  | Complete Workflows integration guide                                   |

---

## State Management Improvements

### Synchronous `setState()`

`setState()` is now synchronous. Existing `await this.setState(...)` code continues to work.

```typescript
// Preferred (new)
this.setState({ count: 1 });

// Still works (backward compatible)
await this.setState({ count: 1 });
```

### `validateStateChange()` Hook

New synchronous validation hook that runs before state is persisted:

```typescript
validateStateChange(nextState: State, source: Connection | "server") {
  if (nextState.count < 0) {
    throw new Error("Count cannot be negative");
  }
}
```

### Execution Order

1. `validateStateChange(nextState, source)` - validation (sync, gating)
2. State persisted to SQLite
3. State broadcast to connected clients
4. `onStateUpdate(nextState, source)` - notifications (async via `ctx.waitUntil`, non-gating)

---

## Scheduling: `scheduleEvery()`

Fixed-interval recurring tasks with overlap prevention and error resilience:

```typescript
await this.scheduleEvery(60, "cleanup");
await this.scheduleEvery(300, "syncData", { source: "api" });
```

- Validates interval doesn't exceed 30 days (DO alarm limit)
- Overlap prevention with hung callback detection (configurable via `hungScheduleTimeoutSeconds`)

---

## Callable System Improvements

### Client-side RPC Timeout

```typescript
await agent.call("method", [args], {
  timeout: 5000,
  stream: { onChunk, onDone, onError },
});
```

### New Features

- `StreamingResponse.error(message)` - Graceful stream error signaling
- `getCallableMethods()` - Introspection API for callable methods
- Connection close handling - Pending calls rejected on disconnect
- `crypto.randomUUID()` for more robust RPC IDs
- Streaming observability events and error logging

---

## MCP Server API

Options-based `addMcpServer()` overload for cleaner configuration:

```typescript
await this.addMcpServer("server", url, {
  callbackHost: "https://my-worker.workers.dev",
  transport: { headers: { Authorization: "Bearer ..." } },
});
```

---

## Routing & Identity Enhancements

- **`basePath`** - Bypass default URL construction for custom routing
- **Server-sent identity** - Agents send `name` and `agent` type on connect
- **`onIdentity` / `onIdentityChange`** callbacks on the client
- **`static options = { sendIdentityOnConnect }`** for server-side control

```typescript
const agent = useAgent({
  basePath: "user",
  onIdentity: (name, agentType) => console.log(`Connected to ${name}`),
});
```

---

## Email Utilities

- **`isAutoReplyEmail(headers)`** - Detect auto-reply emails using standard RFC headers

---

## Bug Fixes

- Fixed tool error content type in `getAITools` (#781)
- Fixed React `useRef` type error
- Memory leak prevention with WeakMap for callable metadata
- Connection cleanup - pending RPC calls rejected on WebSocket close
- JSON parse error handling - graceful fallback to `initialState` on corrupted state
- Fixed resumable streaming to avoid delivering live chunks before resume ACK (#795)

---

## Migration Notes

### Email Imports

```typescript
// Before
import { createAddressBasedEmailResolver, signAgentHeaders } from "agents";

// After
import {
  createAddressBasedEmailResolver,
  signAgentHeaders,
} from "agents/email";
```

### Workflow Imports

```typescript
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowStep, WorkflowInfo } from "agents/workflows";
```

### OpenAI Provider Options

When using `scheduleSchema` with OpenAI models via the AI SDK, pass `providerOptions`:

```typescript
await generateObject({
  // ... other options
  providerOptions: { openai: { strictJsonSchema: false } },
});
```

### Patch Changes

- [#825](https://github.com/cloudflare/agents/pull/825) [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453) Thanks [@threepointone](https://github.com/threepointone)! - Add cursor-based pagination to `getWorkflows()`. Returns a `WorkflowPage` with workflows, total count, and cursor for next page. Default limit is 50 (max 100).

- [#825](https://github.com/cloudflare/agents/pull/825) [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453) Thanks [@threepointone](https://github.com/threepointone)! - Add workflow control methods: `terminateWorkflow()`, `pauseWorkflow()`, `resumeWorkflow()`, and `restartWorkflow()`.

- [#799](https://github.com/cloudflare/agents/pull/799) [`d1a0c2b`](https://github.com/cloudflare/agents/commit/d1a0c2b73b1119d71e120091753a6bcca0e2faa9) Thanks [@threepointone](https://github.com/threepointone)! - feat: Add Cloudflare Workflows integration for Agents

  Adds seamless integration between Cloudflare Agents and Cloudflare Workflows for durable, multi-step background processing.

  ### Why use Workflows with Agents?

  Agents excel at real-time communication and state management, while Workflows excel at durable execution. Together:
  - Agents handle WebSocket connections and quick operations
  - Workflows handle long-running tasks, retries, and human-in-the-loop flows

  ### AgentWorkflow Base Class

  Extend `AgentWorkflow` instead of `WorkflowEntrypoint` to get typed access to the originating Agent:

  ```typescript
  export class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
    async run(event: AgentWorkflowEvent<TaskParams>, step: AgentWorkflowStep) {
      const params = event.payload;

      // Call Agent methods via RPC
      await this.agent.updateStatus(params.taskId, "processing");

      // Non-durable: progress reporting (lightweight, for frequent updates)
      await this.reportProgress({
        step: "process",
        percent: 0.5,
        message: "Halfway done",
      });
      this.broadcastToClients({ type: "update", taskId: params.taskId });

      // Durable via step: idempotent, won't repeat on retry
      await step.mergeAgentState({ taskProgress: 0.5 });
      await step.reportComplete(result);

      return result;
    }
  }
  ```

  ### Agent Methods
  - `runWorkflow(workflowName, params, options?)` - Start workflow with optional metadata for querying
  - `sendWorkflowEvent(workflowName, workflowId, event)` - Send events to waiting workflows
  - `getWorkflow(workflowId)` - Get tracked workflow by ID
  - `getWorkflows(criteria?)` - Query by status, workflowName, or metadata with pagination
  - `deleteWorkflow(workflowId)` - Delete a workflow tracking record
  - `deleteWorkflows(criteria?)` - Delete workflows by criteria (status, workflowName, metadata, createdBefore)
  - `approveWorkflow(workflowId, data?)` - Approve a waiting workflow
  - `rejectWorkflow(workflowId, data?)` - Reject a waiting workflow

  ### AgentWorkflow Methods

  **On `this` (non-durable, lightweight):**
  - `reportProgress(progress)` - Report typed progress object to Agent
  - `broadcastToClients(message)` - Broadcast to WebSocket clients
  - `waitForApproval(step, opts?)` - Wait for approval (throws on rejection)

  **On `step` (durable, idempotent):**
  - `step.reportComplete(result?)` - Report successful completion
  - `step.reportError(error)` - Report an error
  - `step.sendEvent(event)` - Send custom event to Agent
  - `step.updateAgentState(state)` - Replace Agent state (broadcasts to clients)
  - `step.mergeAgentState(partial)` - Merge into Agent state (broadcasts to clients)
  - `step.resetAgentState()` - Reset Agent state to initialState (broadcasts to clients)

  ### Lifecycle Callbacks

  Override these methods to handle workflow events (workflowName is first for easy differentiation):

  ```typescript
  async onWorkflowProgress(workflowName, workflowId, progress) {} // progress is typed object
  async onWorkflowComplete(workflowName, workflowId, result?) {}
  async onWorkflowError(workflowName, workflowId, error) {}
  async onWorkflowEvent(workflowName, workflowId, event) {}
  ```

  ### Workflow Tracking

  Workflows are automatically tracked in `cf_agents_workflows` SQLite table:
  - Status, timestamps, errors
  - Optional `metadata` field for queryable key-value data
  - Params/output NOT stored by default (could be large)

  See `docs/workflows.md` for full documentation.

- [#812](https://github.com/cloudflare/agents/pull/812) [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa) Thanks [@threepointone](https://github.com/threepointone)! - # Bug Fixes

  This release includes three bug fixes:

  ## 1. Hung Callback Detection in scheduleEvery()

  Fixed a deadlock where if an interval callback hung indefinitely, all future interval executions would be skipped forever.

  **Fix:** Track execution start time and force reset after 30 seconds of inactivity. If a previous execution appears hung (started more than 30s ago), it is force-reset and re-executed.

  ```typescript
  // Now safe - hung callbacks won't block future executions
  await this.scheduleEvery(60, "myCallback");
  ```

  ## 2. Corrupted State Recovery

  Fixed a crash when the database contains malformed JSON state.

  **Fix:** Wrapped `JSON.parse` in try-catch with fallback to `initialState`. If parsing fails, the agent logs an error and recovers gracefully.

  ```typescript
  // Agent now survives corrupted state
  class MyAgent extends Agent {
    initialState = { count: 0 }; // Used as fallback if DB state is corrupted
  }
  ```

  ## 3. getCallableMethods() Prototype Chain Traversal

  Fixed `getCallableMethods()` to find `@callable` methods from parent classes, not just the immediate class.

  **Fix:** Walk the full prototype chain using `Object.getPrototypeOf()` loop.

  ```typescript
  class BaseAgent extends Agent {
    @callable()
    parentMethod() {
      return "parent";
    }
  }

  class ChildAgent extends BaseAgent {
    @callable()
    childMethod() {
      return "child";
    }
  }

  // Now correctly returns both parentMethod and childMethod
  const methods = childAgent.getCallableMethods();
  ```

- [#812](https://github.com/cloudflare/agents/pull/812) [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa) Thanks [@threepointone](https://github.com/threepointone)! - # Callable System Improvements

  This release includes several improvements to the `@callable` decorator and RPC system:

  ## New Features

  ### Client-side RPC Timeout

  You can now specify a timeout for RPC calls that will reject if the call doesn't complete in time:

  ```typescript
  await agent.call("slowMethod", [], { timeout: 5000 });
  ```

  ### StreamingResponse.error()

  New method to gracefully signal an error during streaming and close the stream:

  ```typescript
  @callable({ streaming: true })
  async processItems(stream: StreamingResponse, items: string[]) {
    for (const item of items) {
      try {
        const result = await this.process(item);
        stream.send(result);
      } catch (e) {
        stream.error(`Failed to process ${item}: ${e.message}`);
        return;
      }
    }
    stream.end();
  }
  ```

  ### getCallableMethods() API

  New method on the Agent class to introspect all callable methods and their metadata:

  ```typescript
  const methods = agent.getCallableMethods();
  // Returns Map<string, CallableMetadata>

  for (const [name, meta] of methods) {
    console.log(`${name}: ${meta.description || "(no description)"}`);
  }
  ```

  ### Connection Close Handling

  Pending RPC calls are now automatically rejected with a "Connection closed" error when the WebSocket connection closes unexpectedly.

  ## Internal Improvements
  - **WeakMap for metadata storage**: Changed `callableMetadata` from `Map` to `WeakMap` to prevent memory leaks when function references are garbage collected.
  - **UUID for RPC IDs**: Replaced `Math.random().toString(36)` with `crypto.randomUUID()` for more robust and unique RPC call identifiers.
  - **Streaming observability**: Added observability events for streaming RPC calls.

  ## API Enhancements

  The `agent.call()` method now accepts a unified `CallOptions` object with timeout support:

  ```typescript
  // New format (preferred, supports timeout)
  await agent.call("method", [args], {
    timeout: 5000,
    stream: { onChunk, onDone, onError },
  });

  // Legacy format (still fully supported for backward compatibility)
  await agent.call("method", [args], { onChunk, onDone, onError });
  ```

  Both formats work seamlessly - the client auto-detects which format you're using.

- [#812](https://github.com/cloudflare/agents/pull/812) [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa) Thanks [@threepointone](https://github.com/threepointone)! - feat: Add `scheduleEvery` method for fixed-interval scheduling

  Adds a new `scheduleEvery(intervalSeconds, callback, payload?)` method to the Agent class for scheduling recurring tasks at fixed intervals.

  ### Features
  - **Fixed interval execution**: Schedule a callback to run every N seconds
  - **Overlap prevention**: If a callback is still running when the next interval fires, the next execution is skipped
  - **Error resilience**: If a callback throws, the schedule persists and continues on the next interval
  - **Cancellable**: Use `cancelSchedule(id)` to stop the recurring schedule

  ### Usage

  ```typescript
  class MyAgent extends Agent {
    async onStart() {
      // Run cleanup every 60 seconds
      await this.scheduleEvery(60, "cleanup");

      // With payload
      await this.scheduleEvery(300, "syncData", { source: "api" });
    }

    cleanup() {
      // Runs every 60 seconds
    }

    syncData(payload: { source: string }) {
      // Runs every 300 seconds with payload
    }
  }
  ```

  ### Querying interval schedules

  ```typescript
  // Get all interval schedules
  const intervals = await this.getSchedules({ type: "interval" });
  ```

  ### Schema changes

  Adds `intervalSeconds` and `running` columns to `cf_agents_schedules` table (auto-migrated for existing agents).

- [#812](https://github.com/cloudflare/agents/pull/812) [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa) Thanks [@threepointone](https://github.com/threepointone)! - Add `isAutoReplyEmail()` utility to detect auto-reply emails

  Detects auto-reply emails based on standard RFC 3834 headers (`Auto-Submitted`, `X-Auto-Response-Suppress`, `Precedence`). Use this to avoid mail loops when sending automated replies.

  ```typescript
  import { isAutoReplyEmail } from "agents/email";
  import PostalMime from "postal-mime";

  async onEmail(email: AgentEmail) {
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);

    // Detect and skip auto-reply emails
    if (isAutoReplyEmail(parsed.headers)) {
      console.log("Skipping auto-reply");
      return;
    }

    // Process the email...
  }
  ```

- [#781](https://github.com/cloudflare/agents/pull/781) [`fd79481`](https://github.com/cloudflare/agents/commit/fd7948180abf066fa3d27911a83ffb4c91b3f099) Thanks [@HueCodes](https://github.com/HueCodes)! - fix: properly type tool error content in getAITools

- [#812](https://github.com/cloudflare/agents/pull/812) [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa) Thanks [@threepointone](https://github.com/threepointone)! - fix: improve type inference for RPC methods returning custom interfaces

  Previously, `RPCMethod` used `{ [key: string]: SerializableValue }` to check if return types were serializable. This didn't work with TypeScript interfaces that have named properties (like `interface CoreState { counter: number; name: string; }`), causing those methods to be incorrectly excluded from typed RPC calls.

  Now uses a recursive `CanSerialize<T>` type that checks if all properties of an object are serializable, properly supporting:
  - Custom interfaces with named properties
  - Nested object types
  - Arrays of objects
  - Optional and nullable properties
  - Union types

  Also expanded `NonSerializable` to explicitly exclude non-JSON-serializable types like `Date`, `RegExp`, `Map`, `Set`, `Error`, and typed arrays.

  ```typescript
  // Before: these methods were NOT recognized as callable
  interface MyState {
    counter: number;
    items: string[];
  }

  class MyAgent extends Agent<Env, MyState> {
    @callable()
    getState(): MyState {
      return this.state;
    } // ❌ Not typed
  }

  // After: properly recognized and typed
  const agent = useAgent<MyAgent, MyState>({ agent: "my-agent" });
  agent.call("getState"); // ✅ Typed as Promise<MyState>
  ```

- [#825](https://github.com/cloudflare/agents/pull/825) [`0c3c9bb`](https://github.com/cloudflare/agents/commit/0c3c9bb62ceff66ed38d3bbd90c767600f1f3453) Thanks [@threepointone](https://github.com/threepointone)! - Fix workflow tracking table not being updated by AgentWorkflow callbacks.

  Previously, when a workflow reported progress, completion, or errors via callbacks, the `cf_agents_workflows` tracking table was not updated. This caused `getWorkflow()` and `getWorkflows()` to return stale status (e.g., "queued" instead of "running" or "complete").

  Now, `onWorkflowCallback()` automatically updates the tracking table:
  - Progress callbacks set status to "running"
  - Complete callbacks set status to "complete" with `completed_at` timestamp
  - Error callbacks set status to "errored" with error details

  Fixes #821.

- [#812](https://github.com/cloudflare/agents/pull/812) [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa) Thanks [@threepointone](https://github.com/threepointone)! - feat: Add options-based API for `addMcpServer`

  Adds a cleaner options-based overload for `addMcpServer()` that avoids passing `undefined` for unused positional parameters.

  ### Before (still works)

  ```typescript
  // Awkward when you only need transport options
  await this.addMcpServer("server", url, undefined, undefined, {
    transport: { headers: { Authorization: "Bearer ..." } },
  });
  ```

  ### After (preferred)

  ```typescript
  // Clean options object
  await this.addMcpServer("server", url, {
    transport: { headers: { Authorization: "Bearer ..." } },
  });

  // With callback host
  await this.addMcpServer("server", url, {
    callbackHost: "https://my-worker.workers.dev",
    transport: { type: "sse" },
  });
  ```

  ### Options

  ```typescript
  type AddMcpServerOptions = {
    callbackHost?: string; // OAuth callback host (auto-derived if omitted)
    agentsPrefix?: string; // Routing prefix (default: "agents")
    client?: ClientOptions; // MCP client options
    transport?: {
      headers?: HeadersInit; // Custom headers for auth
      type?: "sse" | "streamable-http" | "auto";
    };
  };
  ```

  The legacy 5-parameter signature remains fully supported for backward compatibility.

- [#812](https://github.com/cloudflare/agents/pull/812) [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa) Thanks [@threepointone](https://github.com/threepointone)! - Add custom URL routing with `basePath` and server-sent identity

  ## Custom URL Routing with `basePath`

  New `basePath` option bypasses default `/agents/{agent}/{name}` URL construction, enabling custom routing patterns:

  ```typescript
  // Client connects to /user instead of /agents/user-agent/...
  const agent = useAgent({
    agent: "UserAgent",
    basePath: "user",
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
    },
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
    },
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
    },
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

- [#827](https://github.com/cloudflare/agents/pull/827) [`e20da53`](https://github.com/cloudflare/agents/commit/e20da5319eb46bac6ac580edf71836b00ac6f8bb) Thanks [@threepointone](https://github.com/threepointone)! - Move workflow exports to `agents/workflows` subpath for better separation of concerns.

  ```typescript
  import { AgentWorkflow } from "agents/workflows";
  import type { AgentWorkflowStep, WorkflowInfo } from "agents/workflows";
  ```

- [#811](https://github.com/cloudflare/agents/pull/811) [`f604008`](https://github.com/cloudflare/agents/commit/f604008957f136241815909319a552bad6738b58) Thanks [@threepointone](https://github.com/threepointone)! - ### Secure Email Reply Routing

  This release introduces secure email reply routing with HMAC-SHA256 signed headers, preventing unauthorized routing of emails to arbitrary agent instances.

  #### Breaking Changes

  **Email utilities moved to `agents/email` subpath**: Email-specific resolvers and utilities have been moved to a dedicated subpath for better organization.

  ```ts
  // Before
  import { createAddressBasedEmailResolver, signAgentHeaders } from "agents";

  // After
  import {
    createAddressBasedEmailResolver,
    signAgentHeaders,
  } from "agents/email";
  ```

  The following remain in root: `routeAgentEmail`, `createHeaderBasedEmailResolver` (deprecated).

  **`createHeaderBasedEmailResolver` removed**: This function now throws an error with migration guidance. It was removed because it trusted attacker-controlled email headers for routing.

  **Migration:**
  - For inbound mail: use `createAddressBasedEmailResolver(agentName)`
  - For reply flows: use `createSecureReplyEmailResolver(secret)` with signed headers

  See https://github.com/cloudflare/agents/blob/main/docs/email.md for details.

  **`EmailSendOptions` type removed**: This type was unused and has been removed.

  #### New Features

  **`createSecureReplyEmailResolver`**: A new resolver that verifies HMAC-SHA256 signatures on incoming emails before routing. Signatures include a timestamp and expire after 30 days by default.

  ```ts
  const resolver = createSecureReplyEmailResolver(env.EMAIL_SECRET, {
    maxAge: 7 * 24 * 60 * 60, // Optional: 7 days (default: 30 days)
    onInvalidSignature: (email, reason) => {
      // Optional: log failures for debugging
      // reason: "missing_headers" | "expired" | "invalid" | "malformed_timestamp"
      console.warn(`Invalid signature from ${email.from}: ${reason}`);
    },
  });
  ```

  **`signAgentHeaders`**: Helper function to manually sign agent routing headers for use with external email services.

  ```ts
  const headers = await signAgentHeaders(secret, agentName, agentId);
  // Returns: { "X-Agent-Name", "X-Agent-ID", "X-Agent-Sig", "X-Agent-Sig-Ts" }
  ```

  **`replyToEmail` signing**: The `replyToEmail` method now accepts a `secret` option to automatically sign outbound email headers.

  ```ts
  await this.replyToEmail(email, {
    fromName: "My Agent",
    body: "Thanks!",
    secret: this.env.EMAIL_SECRET, // Signs headers for secure reply routing
  });
  ```

  If an email was routed via `createSecureReplyEmailResolver`, calling `replyToEmail` without a secret will throw an error (pass explicit `null` to opt-out).

  **`onNoRoute` callback**: `routeAgentEmail` now accepts an `onNoRoute` callback for handling emails that don't match any routing rule.

  ```ts
  await routeAgentEmail(message, env, {
    resolver,
    onNoRoute: (email) => {
      email.setReject("Unknown recipient");
    },
  });
  ```

- [#813](https://github.com/cloudflare/agents/pull/813) [`7aebab3`](https://github.com/cloudflare/agents/commit/7aebab369d1bef6c685e05a4a3bd6627edcb87db) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#800](https://github.com/cloudflare/agents/pull/800) [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

- [#818](https://github.com/cloudflare/agents/pull/818) [`7c74336`](https://github.com/cloudflare/agents/commit/7c743360d7e3639e187725391b9d5c114838bd18) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#812](https://github.com/cloudflare/agents/pull/812) [`6218541`](https://github.com/cloudflare/agents/commit/6218541e9c1e40ccbaa25b2d9d93858c0ad81ffa) Thanks [@threepointone](https://github.com/threepointone)! - # Synchronous `setState` with validation hook

  `setState()` is now synchronous instead of async. This improves ergonomics and aligns with the expected mental model for state updates.

  ## Breaking Changes

  ### `setState()` returns `void` instead of `Promise<void>`

  ```typescript
  // Before (still works - awaiting a non-promise is harmless)
  await this.setState({ count: 1 });

  // After (preferred)
  this.setState({ count: 1 });
  ```

  Existing code that uses `await this.setState(...)` will continue to work without changes.

  ### `onStateUpdate()` no longer gates state broadcasts

  Previously, if `onStateUpdate()` threw an error, the state update would be aborted. Now, `onStateUpdate()` runs asynchronously via `ctx.waitUntil()` after the state is persisted and broadcast. Errors in `onStateUpdate()` are routed to `onError()` but do not prevent the state from being saved or broadcast.

  If you were using `onStateUpdate()` for validation, migrate to `validateStateChange()`.

  ## New Features

  ### `validateStateChange()` validation hook

  A new synchronous hook that runs before state is persisted or broadcast. Use this for validation:

  ```typescript
  validateStateChange(nextState: State, source: Connection | "server") {
    if (nextState.count < 0) {
      throw new Error("Count cannot be negative");
    }
  }
  ```

  - Runs synchronously before persistence and broadcast
  - Throwing aborts the state update entirely
  - Ideal for validation logic

  ### Execution order
  1. `validateStateChange(nextState, source)` - validation (sync, gating)
  2. State persisted to SQLite
  3. State broadcast to connected clients
  4. `onStateUpdate(nextState, source)` - notifications (async via `ctx.waitUntil`, non-gating)

- [#815](https://github.com/cloudflare/agents/pull/815) [`ded8d3e`](https://github.com/cloudflare/agents/commit/ded8d3e8aeba0358ebd4aecb5ba15344b5a21db1) Thanks [@threepointone](https://github.com/threepointone)! - docs: add OpenAI provider options documentation to scheduleSchema

  When using `scheduleSchema` with OpenAI models via the AI SDK, users must now pass `providerOptions: { openai: { strictJsonSchema: false } }` to `generateObject`. This is documented in the JSDoc for `scheduleSchema`.

  This is required because `@ai-sdk/openai` now defaults `strictJsonSchema` to `true`, which requires all schema properties to be in the `required` array. The `scheduleSchema` uses optional fields which are not compatible with this strict mode.

- Updated dependencies [[`7aebab3`](https://github.com/cloudflare/agents/commit/7aebab369d1bef6c685e05a4a3bd6627edcb87db), [`77be4f8`](https://github.com/cloudflare/agents/commit/77be4f8149e41730148a360adfff9e66becdd5ed), [`a54edf5`](https://github.com/cloudflare/agents/commit/a54edf56b462856d1ef4f424c2363ac43a53c46e), [`7c74336`](https://github.com/cloudflare/agents/commit/7c743360d7e3639e187725391b9d5c114838bd18), [`99cbca0`](https://github.com/cloudflare/agents/commit/99cbca0847d0d6c97f44b73f2eb155dabe590032)]:
  - @cloudflare/codemode@0.0.6
  - @cloudflare/ai-chat@0.0.5

## 0.3.6

### Patch Changes

- [#786](https://github.com/cloudflare/agents/pull/786) [`395f461`](https://github.com/cloudflare/agents/commit/395f46105d3affb5a2e2ffd28c516a0eefe45bb4) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - fix: allow callable methods to return this.state

- [#783](https://github.com/cloudflare/agents/pull/783) [`f27e62c`](https://github.com/cloudflare/agents/commit/f27e62c24f586abb285843db183198230ddd47ca) Thanks [@Muhammad-Bin-Ali](https://github.com/Muhammad-Bin-Ali)! - fix saving initialize params for stateless MCP server (effects eliciations and other optional features)

- Updated dependencies [[`93c613e`](https://github.com/cloudflare/agents/commit/93c613e077e7aa16e78cf9b0b53e285577e92ce5)]:
  - @cloudflare/codemode@0.0.5

## 0.3.5

### Patch Changes

- [#752](https://github.com/cloudflare/agents/pull/752) [`473e53c`](https://github.com/cloudflare/agents/commit/473e53cb2d954caba03f530776ee61433b8113ba) Thanks [@mattzcarey](https://github.com/mattzcarey)! - bump mcp sdk version to 1.25.2. changes error handling for not found see: https://github.com/cloudflare/agents/pull/752/changes#diff-176ef2d2154e76a8eb7862efb323210f8f1b434f6a9ff3f06abc87d8616855c9R25-R31

## 0.3.4

### Patch Changes

- [#768](https://github.com/cloudflare/agents/pull/768) [`cf8a1e7`](https://github.com/cloudflare/agents/commit/cf8a1e7a24ecaac62c2aefca7b0fd5bf1373e8bd) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - pipe SQL errors into the existing onError method using a new SqlError class

- [#771](https://github.com/cloudflare/agents/pull/771) [`87dc96d`](https://github.com/cloudflare/agents/commit/87dc96d19de1d26dbb2badecbb9955a4eb8e9e2e) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- Updated dependencies [[`0e8fc1e`](https://github.com/cloudflare/agents/commit/0e8fc1e8cca3ad5acb51f5a0c92528c5b6beb358), [`87dc96d`](https://github.com/cloudflare/agents/commit/87dc96d19de1d26dbb2badecbb9955a4eb8e9e2e)]:
  - @cloudflare/ai-chat@0.0.4
  - @cloudflare/codemode@0.0.4

## 0.3.3

### Patch Changes

- [`a5d0137`](https://github.com/cloudflare/agents/commit/a5d01379b9ad2d88bc028c50f1858b4e69f106c5) Thanks [@threepointone](https://github.com/threepointone)! - trigger a new release

- Updated dependencies [[`a5d0137`](https://github.com/cloudflare/agents/commit/a5d01379b9ad2d88bc028c50f1858b4e69f106c5)]:
  - @cloudflare/codemode@0.0.3
  - @cloudflare/ai-chat@0.0.3

## 0.3.2

### Patch Changes

- [#756](https://github.com/cloudflare/agents/pull/756) [`0c4275f`](https://github.com/cloudflare/agents/commit/0c4275f8f4b71c264c32c3742d151ef705739c2f) Thanks [@threepointone](https://github.com/threepointone)! - feat: split ai-chat and codemode into separate packages

  Extract @cloudflare/ai-chat and @cloudflare/codemode into their own packages
  with comprehensive READMEs. Update agents README to remove chat-specific
  content and point to new packages. Fix documentation imports to reflect
  new package structure.

  Maintains backward compatibility, no breaking changes.

- [#758](https://github.com/cloudflare/agents/pull/758) [`f12553f`](https://github.com/cloudflare/agents/commit/f12553f2fa65912c68d9a7620b9a11b70b8790a2) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Implement createStubProxy function to fix RPC method call handling

- Updated dependencies [[`0c4275f`](https://github.com/cloudflare/agents/commit/0c4275f8f4b71c264c32c3742d151ef705739c2f)]:
  - @cloudflare/codemode@0.0.2
  - @cloudflare/ai-chat@0.0.2

## 0.3.1

### Patch Changes

- [#754](https://github.com/cloudflare/agents/pull/754) [`e21051d`](https://github.com/cloudflare/agents/commit/e21051d798a5de5f2af33b9fb0e12ea6d648d2e9) Thanks [@threepointone](https://github.com/threepointone)! - fix: don't mark ai as optional under peerDependenciesMeta

## 0.3.0

### Minor Changes

- [`accdd78`](https://github.com/cloudflare/agents/commit/accdd78688a71287153687907f682b0feeacd155) Thanks [@threepointone](https://github.com/threepointone)! - update to ai sdk v6

  via @whoiskatrin in https://github.com/cloudflare/agents/pull/733

## 0.2.35

### Patch Changes

- [#742](https://github.com/cloudflare/agents/pull/742) [`29938d4`](https://github.com/cloudflare/agents/commit/29938d42f177b9c5600370c03231ed398d03ed07) Thanks [@threepointone](https://github.com/threepointone)! - mark AgentNamespace as deprecated

  It only makes things harder, especially for autogenned types.

- [#747](https://github.com/cloudflare/agents/pull/747) [`17a0346`](https://github.com/cloudflare/agents/commit/17a034676b871ed30172f46f9a4160723c537ee0) Thanks [@threepointone](https://github.com/threepointone)! - fix: scheduling should work

  since we updated to zod v4, the schedule schema was broken. ai sdk's .jsonSchema function doesn't correctly work on tools created with zod v4. The fix, is to use the v3 version of zod for the schedule schema.

## 0.2.34

### Patch Changes

- [#739](https://github.com/cloudflare/agents/pull/739) [`e9b6bb7`](https://github.com/cloudflare/agents/commit/e9b6bb7ea2727e4692d9191108c5609c6a44d9d9) Thanks [@threepointone](https://github.com/threepointone)! - update all dependencies
  - remove the changesets cli patch, as well as updating node version, so we don't need to explicitly install newest npm
  - lock mcp sdk version till we figure out how to do breaking changes correctly
  - removes stray permissions block from release.yml

- [#740](https://github.com/cloudflare/agents/pull/740) [`087264c`](https://github.com/cloudflare/agents/commit/087264cd3b3bebff3eb6e59d850e091d086ff591) Thanks [@threepointone](https://github.com/threepointone)! - update zod

- [#737](https://github.com/cloudflare/agents/pull/737) [`b8c0595`](https://github.com/cloudflare/agents/commit/b8c0595b22ef6421370d3d14e74ddc9ed708d719) Thanks [@threepointone](https://github.com/threepointone)! - update partyserver (and some other cf packages)

  specifically updating partyserver so it gets a better default type for Env, defaulting to Cloudflare.Env

- [#732](https://github.com/cloudflare/agents/pull/732) [`9fbb1b6`](https://github.com/cloudflare/agents/commit/9fbb1b6587176a70296b30592eaba5f821c68208) Thanks [@Scalahansolo](https://github.com/Scalahansolo)! - Setup proper peer deps for zod v4

- [#722](https://github.com/cloudflare/agents/pull/722) [`57b7f2e`](https://github.com/cloudflare/agents/commit/57b7f2e26e4d5e6eb370b2b8a690a542c3c269c9) Thanks [@agcty](https://github.com/agcty)! - fix: move AI SDK packages to peer dependencies

## 0.2.32

### Patch Changes

- [#729](https://github.com/cloudflare/agents/pull/729) [`79843bd`](https://github.com/cloudflare/agents/commit/79843bdc6c7da825f0fe0b8a9c1faef1c6f7a0c0) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add client-defined tools and prepareSendMessagesRequest options

- [#726](https://github.com/cloudflare/agents/pull/726) [`59ac254`](https://github.com/cloudflare/agents/commit/59ac254b0abc84d4b24f46bf52a972c691b170e0) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - fix cache ttl

## 0.2.31

### Patch Changes

- [#720](https://github.com/cloudflare/agents/pull/720) [`380c597`](https://github.com/cloudflare/agents/commit/380c5977622563441dd28af6e70dc479bd86ccf0) Thanks [@mattzcarey](https://github.com/mattzcarey)! - MCP WorkerTransport accepts any supported protocol version in request headers and only rejects truly unsupported versions. This aligns with the move by MCP community to stateless transports and fixes an isse with 'mcp-protocol-version': '2025-11-25'

## 0.2.30

### Patch Changes

- [#716](https://github.com/cloudflare/agents/pull/716) [`569e184`](https://github.com/cloudflare/agents/commit/569e1840966c8c537bca1a6cf01b04cf3567972b) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix elicitation response handling in MCP StreamableHTTP transport by adding a message interceptor

## 0.2.29

### Patch Changes

- [#712](https://github.com/cloudflare/agents/pull/712) [`cd8b7fd`](https://github.com/cloudflare/agents/commit/cd8b7fdfcadd8da310aee8adeecc018d1b5144ad) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - fix connection inside tool execution

- [#710](https://github.com/cloudflare/agents/pull/710) [`d08612f`](https://github.com/cloudflare/agents/commit/d08612f57ef8fec9d8ecd3031e09211f86812c84) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - fix cachetll + test

## 0.2.28

### Patch Changes

- [#696](https://github.com/cloudflare/agents/pull/696) [`6a930ef`](https://github.com/cloudflare/agents/commit/6a930ef02c411a036dc647a3763c2598e00a942f) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Enables connecting to multiple MCP servers simultaneously and hardens OAuth state handling against replay/DoS attacks.

  **Note:** Inflight OAuth flows that were initiated on a previous version will not complete after upgrading, as the state parameter format has changed. Users will need to restart the authentication flow.

- [#702](https://github.com/cloudflare/agents/pull/702) [`10d453d`](https://github.com/cloudflare/agents/commit/10d453d7379e1110a3255d137e38e6eeae964f80) Thanks [@mattzcarey](https://github.com/mattzcarey)! - broadcast auth_url as soon as its returned

## 0.2.27

### Patch Changes

- [#691](https://github.com/cloudflare/agents/pull/691) [`d7b2f14`](https://github.com/cloudflare/agents/commit/d7b2f1471f9e336edae165d73f0247ac86b094df) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - fixed schedule handling and added tests for this bug

## 0.2.26

### Patch Changes

- [#689](https://github.com/cloudflare/agents/pull/689) [`64a6ac3`](https://github.com/cloudflare/agents/commit/64a6ac3df08b6ca2b527e0315044fef453cfcc3f) Thanks [@mattzcarey](https://github.com/mattzcarey)! - add patch to fix mcp sdk oauth discovery fallback to root domain for some servers (better-auth powered)

- [#681](https://github.com/cloudflare/agents/pull/681) [`0035951`](https://github.com/cloudflare/agents/commit/0035951104b7decf13ef50922d5ea6e7c09ccc18) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#684](https://github.com/cloudflare/agents/pull/684) [`5e80ca6`](https://github.com/cloudflare/agents/commit/5e80ca68cc6bd23af0836c85b194ea03b000ed9c) Thanks [@threepointone](https://github.com/threepointone)! - fix: make agents cli actually run

## 0.2.25

### Patch Changes

- [#679](https://github.com/cloudflare/agents/pull/679) [`e173b41`](https://github.com/cloudflare/agents/commit/e173b41af61bbea24d6952287ebb00726c6ba1b9) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - enhance request ID tracking and stream handling in useAgentChat

## 0.2.24

### Patch Changes

- [#673](https://github.com/cloudflare/agents/pull/673) [`603b825`](https://github.com/cloudflare/agents/commit/603b825f90b20b61a0fe08275b063d8d4474c622) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - added resumable streaming with minimal setup

- [#665](https://github.com/cloudflare/agents/pull/665) [`4c0838a`](https://github.com/cloudflare/agents/commit/4c0838a28e707b7a69abea14b9df5dd1b78d53ae) Thanks [@threepointone](https://github.com/threepointone)! - Add default JSON schema validator to MCP client

- [#664](https://github.com/cloudflare/agents/pull/664) [`36d03e6`](https://github.com/cloudflare/agents/commit/36d03e63fe51e6bf7296928bfac11ef6d91c3103) Thanks [@threepointone](https://github.com/threepointone)! - Refactor MCP server table management in Agent class

  Moved creation and deletion of the cf_agents_mcp_servers table from AgentMCPClientStorage to the Agent class. Removed redundant create and destroy methods from AgentMCPClientStorage and updated MCPClientManager to reflect these changes. Added comments to clarify usage in demo and test code.

- [#653](https://github.com/cloudflare/agents/pull/653) [`412321b`](https://github.com/cloudflare/agents/commit/412321bc9f8d58e3f8aa11a2aa6d646b7cb6c7ec) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Allow `this.destroy` inside a schedule by including a `destroyed` flag and yielding `ctx.abort` instead of calling it directly
  Fix issue where schedules would not be able to run for more 30 seconds due to `blockConccurencyWhile`. `alarm()` isn't manually called anymore, getting rid of the bCW.
  Fix an issue where immediate schedules (e.g. `this.schedule(0, "foo"))`) would not get immediately scheduled.

- [#652](https://github.com/cloudflare/agents/pull/652) [`c07b2c0`](https://github.com/cloudflare/agents/commit/c07b2c05ae6a9b5ac4f87f24e80a145e3d2f8aaa) Thanks [@mattzcarey](https://github.com/mattzcarey)! - ### New Features
  - **`MCPClientManager` API changes**:
    - New `registerServer()` method to register servers (replaces part of `connect()`)
    - New `connectToServer()` method to establish connection (replaces part of `connect()`)
    - `connect()` method deprecated (still works for backward compatibility)
  - **Connection state observability**: New `onServerStateChanged()` event for tracking all server state changes
  - **Improved reconnect logic**: `restoreConnectionsFromStorage()` handles failed connections

  ### Bug Fixes
  - Fixed failed connections not being recreated on restore
  - Fixed redundant storage operations during connection restoration
  - Fixed potential OAuth storage initialization issue by excluding non-serializable authProvider from stored server options
  - Added defensive checks for storage initialization in MCPClientManager and DurableObjectOAuthClientProvider
  - Fixed initialization order: MCPClientManager is now created AFTER database tables are created to prevent possible table-not-found errors during DO restart

- [#678](https://github.com/cloudflare/agents/pull/678) [`cccbd0f`](https://github.com/cloudflare/agents/commit/cccbd0f0ffdbdf9af520c495c27a6d975dfd11d2) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - convert internal AI SDK stream events to UIMessageStreamPart format

- [#672](https://github.com/cloudflare/agents/pull/672) [`7c9f8b0`](https://github.com/cloudflare/agents/commit/7c9f8b0aed916701bcd97faa2747ee288bdb40d6) Thanks [@mattzcarey](https://github.com/mattzcarey)! - - `MCPClientConnection.init()` no longer triggers discovery automatically. Discovery should be done via `discover()` or through `MCPClientManager.discoverIfConnected()`

  ### Features
  - New `discover()` method on `MCPClientConnection` with full lifecycle management:
    - Handles state transitions (CONNECTED → DISCOVERING → READY on success, CONNECTED on failure)
    - Supports cancellation via AbortController (cancels previous in-flight discovery)
    - Configurable timeout (default 15s)
  - New `cancelDiscovery()` method to abort in-flight discoveries
  - New `discoverIfConnected()` on `MCPClientManager` for simpler capability discovery per server
  - `createConnection()` now returns the connection object for immediate use
  - Created `MCPConnectionState` enum to formalize possible states: `idle`, `connecting`, `authenticating`, `connected`, `discovering`, `ready`, `failed`

  ### Fixes
  - **Fixed discovery hanging on repeated requests** - New discoveries now cancel previous in-flight ones via AbortController
  - **Fixed Durable Object crash-looping** - `restoreConnectionsFromStorage()` now starts connections in background (fire-and-forget) to avoid blocking `onStart` and causing `blockConcurrencyWhile` timeouts
  - **Fixed OAuth callback race condition** - When `auth_url` exists in storage during restoration, state is set to AUTHENTICATING directly instead of calling `connectToServer()` which was overwriting the state
  - **Set discovery timeout to 15s**
  - MCP Client Discovery failures now throw errors immediately instead of continuing with empty arrays
  - Added "connected" state to represent a connected server with no tools loaded yet

- [#654](https://github.com/cloudflare/agents/pull/654) [`a315e86`](https://github.com/cloudflare/agents/commit/a315e86693d81a3ad4d8b3acb21f0f67b4b59ef4) Thanks [@mattzcarey](https://github.com/mattzcarey)! - When handling MCP server requests use relatedRequestId in TransportOptions to send the response down a POST stream if supported (streamable-http)

- [#661](https://github.com/cloudflare/agents/pull/661) [`93589e5`](https://github.com/cloudflare/agents/commit/93589e5dd0c580be0823df42a3e3220d3f88e7a7) Thanks [@naji247](https://github.com/naji247)! - fix: add session ID and header support to SSE transport

  The SSE transport now properly forwards session IDs and request headers to MCP message handlers, achieving closer header parity with StreamableHTTP transport. This allows MCP servers using SSE to access request headers for session management.

- [#659](https://github.com/cloudflare/agents/pull/659) [`48849be`](https://github.com/cloudflare/agents/commit/48849bea45b96a45f55046e18f0c7d87e022765e) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.2.23

### Patch Changes

- [#649](https://github.com/cloudflare/agents/pull/649) [`e135cf5`](https://github.com/cloudflare/agents/commit/e135cf5539eb0a4557fda5cf27730818ab2c664d) Thanks [@mattzcarey](https://github.com/mattzcarey)! - fix auth url not being cleared on a successful oauth callback causing endless reconnection

## 0.2.22

### Patch Changes

- [#637](https://github.com/cloudflare/agents/pull/637) [`1e3b8c9`](https://github.com/cloudflare/agents/commit/1e3b8c9d7ffcec623d3eb95863959e25de109abe) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Removed client edge transports and added deprecation warnings to update imports to the mcp typescript sdk

- [#641](https://github.com/cloudflare/agents/pull/641) [`b2187b4`](https://github.com/cloudflare/agents/commit/b2187b44269f5568d79f269848e0eb98aa781d16) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.2.21

### Patch Changes

- [#631](https://github.com/cloudflare/agents/pull/631) [`6ddabb7`](https://github.com/cloudflare/agents/commit/6ddabb71a2b1df9bb270ad632fc6714c41b931e4) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Handle OAuth errors and validate redirect URLs

- [#626](https://github.com/cloudflare/agents/pull/626) [`cec3cca`](https://github.com/cloudflare/agents/commit/cec3cca32076cc314937f4894556ac2a3a4e7ee9) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Remove url field from RequestExtra in WorkerTransport. It is non standard and goes against the MCP spec types.

- [#630](https://github.com/cloudflare/agents/pull/630) [`636aaf9`](https://github.com/cloudflare/agents/commit/636aaf99f8ecd7a6f4d445efe9a59f698cdb963e) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix OAuth redirect handling in MCP clients

- [#624](https://github.com/cloudflare/agents/pull/624) [`3bb54bf`](https://github.com/cloudflare/agents/commit/3bb54bfbdea9cba5928e233b03680dfc6993fc40) Thanks [@threepointone](https://github.com/threepointone)! - Add CLI entry point and tests for agents package

  Introduces a new CLI for the agents package using yargs with the following commands (currently stubs, not yet implemented):
  - `init` / `create` - Initialize an agents project
  - `dev` - Start development server
  - `deploy` - Deploy agents to Cloudflare
  - `mcp` - The agents mcp server

  Adds CLI test suite with comprehensive coverage for all commands and configurations. Updates package.json to register the CLI binary, adds test scripts for CLI testing, and includes yargs dependencies.

## 0.2.20

### Patch Changes

- [#619](https://github.com/cloudflare/agents/pull/619) [`e7d0d4d`](https://github.com/cloudflare/agents/commit/e7d0d4d847debe828d93f0d78cf18b60fecc2b24) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Adds request info to the extra argument in onmessage. Adds a url parm which we will try push upstream to the MCP SDK as it is useful with OpenAI Apps SDK

## 0.2.19

### Patch Changes

- [#607](https://github.com/cloudflare/agents/pull/607) [`c9b76cd`](https://github.com/cloudflare/agents/commit/c9b76cd50d82f3016395fa1d55a3ca7017bf3501) Thanks [@threepointone](https://github.com/threepointone)! - Add jurisdiction support to MCP agent and handlers

  Introduces a `jurisdiction` option to MCP agent server and streaming/SSE handlers, allowing Durable Object instances to be created in specific geographic regions for compliance (e.g., GDPR). Documentation updated to explain usage and available jurisdictions.

## 0.2.18

### Patch Changes

- [#602](https://github.com/cloudflare/agents/pull/602) [`aed8e18`](https://github.com/cloudflare/agents/commit/aed8e1800bdc0881d939b086aaacc3d9f03f180d) Thanks [@threepointone](https://github.com/threepointone)! - Add CORS support to MCP handler and tests

  Introduces CORS configuration to experimental_createMcpHandler, including handling OPTIONS preflight requests and adding CORS headers to responses and errors. Exports corsHeaders from utils. Adds comprehensive tests for CORS behavior in handler.test.ts.

- [#603](https://github.com/cloudflare/agents/pull/603) [`4da191c`](https://github.com/cloudflare/agents/commit/4da191ca9f99674710175c8ad6c6f85dda33fa89) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Drop the experimental\_ prefix on createMcpHandler

## 0.2.17

### Patch Changes

- [#592](https://github.com/cloudflare/agents/pull/592) [`8e9d714`](https://github.com/cloudflare/agents/commit/8e9d714d7550d9d858296026ae4f8a05671863ec) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Fix oauth2 client again

## 0.2.16

### Patch Changes

- [#578](https://github.com/cloudflare/agents/pull/578) [`829866c`](https://github.com/cloudflare/agents/commit/829866c5ed6eebb264f119b862a7f61e095dce83) Thanks [@threepointone](https://github.com/threepointone)! - udpate dependencies

## 0.2.15

### Patch Changes

- [#582](https://github.com/cloudflare/agents/pull/582) [`a215bb2`](https://github.com/cloudflare/agents/commit/a215bb2f926d532e19773e76b7f2c00757e6a656) Thanks [@mattzcarey](https://github.com/mattzcarey)! - chore: remove main field from agents package.json

- [#576](https://github.com/cloudflare/agents/pull/576) [`026696f`](https://github.com/cloudflare/agents/commit/026696f0d6c05e6f81ff6036f9aacf0f8510b9a1) Thanks [@mattzcarey](https://github.com/mattzcarey)! - createMcpHandler for stateless MCP Worker

## 0.2.14

### Patch Changes

- [#566](https://github.com/cloudflare/agents/pull/566) [`7f4616c`](https://github.com/cloudflare/agents/commit/7f4616cb4262637520303c432f14333ccfff5a84) Thanks [@mattzcarey](https://github.com/mattzcarey)! - fix: Oauth2 client flow

## 0.2.13

### Patch Changes

- [#531](https://github.com/cloudflare/agents/pull/531) [`cdfc590`](https://github.com/cloudflare/agents/commit/cdfc590640bcc08da888d8707f923b926ca73225) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - update our cache key in useAgentChat to include agent name (fix for #420)

## 0.2.12

### Patch Changes

- [#559](https://github.com/cloudflare/agents/pull/559) [`3667584`](https://github.com/cloudflare/agents/commit/3667584792aba94aa47760160ef573af4a33a9a9) Thanks [@threepointone](https://github.com/threepointone)! - use lazy imports for ai sdk

## 0.2.11

### Patch Changes

- [#554](https://github.com/cloudflare/agents/pull/554) [`2cc0f02`](https://github.com/cloudflare/agents/commit/2cc0f020323f6e8e363002cebcc6516f7da75c01) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

- [#554](https://github.com/cloudflare/agents/pull/554) [`2cc0f02`](https://github.com/cloudflare/agents/commit/2cc0f020323f6e8e363002cebcc6516f7da75c01) Thanks [@threepointone](https://github.com/threepointone)! - move to tsdown, slim down generated bundles

## 0.2.10

### Patch Changes

- [#550](https://github.com/cloudflare/agents/pull/550) [`336602f`](https://github.com/cloudflare/agents/commit/336602fe3b2eeb9933822b690c8626024da669dd) Thanks [@ainergiz](https://github.com/ainergiz)! - encode MCP message headers with Base64

- [#544](https://github.com/cloudflare/agents/pull/544) [`afd9efd`](https://github.com/cloudflare/agents/commit/afd9efd6da74a9e8f961aa55e87328c9b18fab12) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Startup time optimisations

## 0.2.9

### Patch Changes

- [#545](https://github.com/cloudflare/agents/pull/545) [`70499f1`](https://github.com/cloudflare/agents/commit/70499f1cb30d71af621ec6e16e5d43786559f75d) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Update mcp sdk

## 0.2.8

### Patch Changes

- [#527](https://github.com/cloudflare/agents/pull/527) [`b060233`](https://github.com/cloudflare/agents/commit/b060233cf16c80b4f5b2718afa6358aea8db45ae) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - remove isToolCallInProgress

- [#535](https://github.com/cloudflare/agents/pull/535) [`75865eb`](https://github.com/cloudflare/agents/commit/75865ebae6c1550aea3a130944df35de203a7ef9) Thanks [@threepointone](https://github.com/threepointone)! - move x402 to peerDependencies

- [#525](https://github.com/cloudflare/agents/pull/525) [`789141e`](https://github.com/cloudflare/agents/commit/789141efa79be3d20ac1c098ff1452da488a9f2d) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - use INSERT OR REPLACE for message persistence to allow tool call updates

- [#529](https://github.com/cloudflare/agents/pull/529) [`c41ebbc`](https://github.com/cloudflare/agents/commit/c41ebbcd148b5bab30883fea763401219e66bdcd) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - persist and stream reply in saveMessages

## 0.2.7

### Patch Changes

- [#521](https://github.com/cloudflare/agents/pull/521) [`1bd0c75`](https://github.com/cloudflare/agents/commit/1bd0c75f44bc164e16f81bd20c9c9bd6fe790898) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix OAuth state parameter security vulnerability by replacing client_id with secure random tokens

- [#524](https://github.com/cloudflare/agents/pull/524) [`06b2ab0`](https://github.com/cloudflare/agents/commit/06b2ab0b7fe1a981441a590ad8779e30a4f0e924) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.2.6

### Patch Changes

- [`b388447`](https://github.com/cloudflare/agents/commit/b3884475a7c3a268fe27fae2eb55f30c73cef4ab) Thanks [@threepointone](https://github.com/threepointone)! - fix: getAITools shouldn't include hyphens in tool names

## 0.2.5

### Patch Changes

- [`a90de5d`](https://github.com/cloudflare/agents/commit/a90de5d23d99246da8a1bef0bfa557316f75585f) Thanks [@threepointone](https://github.com/threepointone)! - codemode: remove stray logs, fix demo

## 0.2.4

### Patch Changes

- [`9a8fed7`](https://github.com/cloudflare/agents/commit/9a8fed774c263778bb51840e3b2d4891125ccaec) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.2.3

### Patch Changes

- [#458](https://github.com/cloudflare/agents/pull/458) [`d3e7a68`](https://github.com/cloudflare/agents/commit/d3e7a6853ca60bfbe998785ec63938e5b4d7fe90) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add unified async authentication support to useAgent hook
  The useAgent hook now automatically detects and handles both sync and async query patterns

- [#512](https://github.com/cloudflare/agents/pull/512) [`f9f03b4`](https://github.com/cloudflare/agents/commit/f9f03b447a6e48eb3fad1c22a91d46d5b147da4c) Thanks [@threepointone](https://github.com/threepointone)! - codemode: a tool that generates code to run your tools

- [#499](https://github.com/cloudflare/agents/pull/499) [`fb62d22`](https://github.com/cloudflare/agents/commit/fb62d2280fe2674bd4893e4e3d720fc7b3bb13a7) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - handle all message types in the reply streaming handler

- [#509](https://github.com/cloudflare/agents/pull/509) [`71def6b`](https://github.com/cloudflare/agents/commit/71def6b8b9bfc75ed0b6e905bc204a78de63c772) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix OAuth authentication for MCP servers and add transport configuration
  - Fix authorization codes being consumed during transport fallback
  - Add transport type option to addMcpServer() for explicit control
  - Add configurable OAuth callback handling (redirects, custom responses)
  - Fix callback URL persistence across Durable Object hibernation

## 0.2.2

### Patch Changes

- [#504](https://github.com/cloudflare/agents/pull/504) [`da56baa`](https://github.com/cloudflare/agents/commit/da56baa831781ee1f31026daabf2f79c51e3c897) Thanks [@threepointone](https://github.com/threepointone)! - fix attribution

## 0.2.1

### Patch Changes

- [`5969a16`](https://github.com/cloudflare/agents/commit/5969a162b89eb7a8506e63b5a829a2df7ccae77e) Thanks [@threepointone](https://github.com/threepointone)! - trigger a release

## 0.2.0

### Minor Changes

- [#495](https://github.com/cloudflare/agents/pull/495) [`ff9329f`](https://github.com/cloudflare/agents/commit/ff9329f4fbcdcf770eeaaa0c9d2adb27e72bb0f6) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix OAuth callback handling and add HOST auto-detection
  - Fix OAuth callback "Not found" errors by removing MCPClientManager
    override
  - Add OAuth callback URL persistence across Durable Object hibernation
  - Fix OAuth connection reuse during reconnect to prevent state loss
  - Add OAuth transport tracking to prevent authorization code consumption
    during auto-fallback
  - Preserve PKCE verifier across transport attempts
  - Make callbackHost parameter optional with automatic request-based
    detection
  - Add URL normalization for consistent transport endpoint handling

### Patch Changes

- [#465](https://github.com/cloudflare/agents/pull/465) [`6db2cd6`](https://github.com/cloudflare/agents/commit/6db2cd6f1497705f8636b1761a2db364d49d4861) Thanks [@BeiXiao](https://github.com/BeiXiao)! - fix(ai-react): prevent stale agent capture in aiFetch; ensure active connection is used

- [#440](https://github.com/cloudflare/agents/pull/440) [`9ef35e2`](https://github.com/cloudflare/agents/commit/9ef35e218e711b7ba6d7f40d20573944ae68b44a) Thanks [@axuj](https://github.com/axuj)! - fix: pass agent.\_pk as id to useChat to prevent stale WebSocket instances

## 0.1.6

### Patch Changes

- [#492](https://github.com/cloudflare/agents/pull/492) [`00ba881`](https://github.com/cloudflare/agents/commit/00ba88115d62b608564e783faac18754dc8a79cc) Thanks [@threepointone](https://github.com/threepointone)! - fix: this.mcp.getAITools now includes outputSchema

- [#494](https://github.com/cloudflare/agents/pull/494) [`ecbd795`](https://github.com/cloudflare/agents/commit/ecbd7950dd0656e27ca3fcd8cdf69aa7292ec5ba) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.1.5

### Patch Changes

- [#478](https://github.com/cloudflare/agents/pull/478) [`8234d41`](https://github.com/cloudflare/agents/commit/8234d413538add212738d4e9436ace3d0fd222d1) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Refactor streamable HTTP transport

- [#486](https://github.com/cloudflare/agents/pull/486) [`4abd78a`](https://github.com/cloudflare/agents/commit/4abd78af111d297fc1a3a7763728ca36b14a0a29) Thanks [@threepointone](https://github.com/threepointone)! - fix: don't context wrap methods on Agents that have already been wrapped

- [#480](https://github.com/cloudflare/agents/pull/480) [`23db655`](https://github.com/cloudflare/agents/commit/23db65588effe698a77cc9514857dd9611def927) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Update mcp tools and client for x402 support

## 0.1.4

### Patch Changes

- [#470](https://github.com/cloudflare/agents/pull/470) [`28013ba`](https://github.com/cloudflare/agents/commit/28013ba700f6c2c0ce09dd3406f6da95569d68bf) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Store initialize requests and set them in onStart

- [#467](https://github.com/cloudflare/agents/pull/467) [`b8eba58`](https://github.com/cloudflare/agents/commit/b8eba582af89cc119ff15f155636fe7ba05d8534) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Silently handle writer close errors

- [`bfc9c75`](https://github.com/cloudflare/agents/commit/bfc9c75bbe8be4f078051cab9a4b95d3cab73ffc) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add response metadata

- [#469](https://github.com/cloudflare/agents/pull/469) [`fac1fe8`](https://github.com/cloudflare/agents/commit/fac1fe879892711b6e91760c45780fcbfc56f602) Thanks [@umgefahren](https://github.com/umgefahren)! - Include reasoning parts in finalized and persistet message.

- [#472](https://github.com/cloudflare/agents/pull/472) [`2d0d2e1`](https://github.com/cloudflare/agents/commit/2d0d2e1e1a0883bd71c6e250da5f007a2dce0229) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - use header for session ids in streamable http GET streams

- [`7d9b939`](https://github.com/cloudflare/agents/commit/7d9b9398e982737b4caa7f99c3a521e36df4961d) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.1.3

### Patch Changes

- [#459](https://github.com/cloudflare/agents/pull/459) [`0ffa9eb`](https://github.com/cloudflare/agents/commit/0ffa9ebeb9a03eae86d167c0624c19858600dd5c) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - update mcp sdk

## 0.1.2

### Patch Changes

- [#415](https://github.com/cloudflare/agents/pull/415) [`f7bd395`](https://github.com/cloudflare/agents/commit/f7bd3959a49ac732baaa2ee9a92cd5544fa0ec29) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Make McpAgent extend Agent + Streaming HTTP protocol features

## 0.1.1

### Patch Changes

- [#451](https://github.com/cloudflare/agents/pull/451) [`9beccdd`](https://github.com/cloudflare/agents/commit/9beccdd7cb4299222eaed72b79278986ef256a73) Thanks [@threepointone](https://github.com/threepointone)! - udpate dependencies

- [#447](https://github.com/cloudflare/agents/pull/447) [`3e523ea`](https://github.com/cloudflare/agents/commit/3e523ea3ed249416b8a464756086bcf3056edd6d) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add support for plain text responses alongside SSE streaming

## 0.1.0

### Minor Changes

- [#391](https://github.com/cloudflare/agents/pull/391) [`ecf8926`](https://github.com/cloudflare/agents/commit/ecf89262da1acc3874bb9aec9effc3be3c1c5a87) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - update to ai sdk v5

### Patch Changes

- [#445](https://github.com/cloudflare/agents/pull/445) [`14616d3`](https://github.com/cloudflare/agents/commit/14616d3254df1c292730d09a69846d5cffbb1590) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Fix MCP client to treat `client_uri` as a valid URL

- [#410](https://github.com/cloudflare/agents/pull/410) [`25b261e`](https://github.com/cloudflare/agents/commit/25b261e6d7ac2e5cb1b1b7df7dcc9fdef84e9931) Thanks [@amorriscode](https://github.com/amorriscode)! - docs: minor fixes

- [`2684ade`](https://github.com/cloudflare/agents/commit/2684adeb3f545c9c48d23e3a004050efe94735ce) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [`01b919d`](https://github.com/cloudflare/agents/commit/01b919db6ab6bb0fd3895e1f6c7c2fdb0905bca2) Thanks [@threepointone](https://github.com/threepointone)! - remove unstable\_ prefixes with deprecation warnings

  This deprecates all unstable\_ prefixes with deprecation warnings. Specifically:
  - unstable_callable -> callable
  - unstable_getAITools -> getAITools
  - unstable_getSchedulePrompt -> getSchedulePrompt
  - unstable_scheduleSchema -> scheduleSchema

  Using the unstable\_ prefixed versions will now emit a deprecation warning. In the next major version, the unstable\_ prefixed versions will be removed.

- [#434](https://github.com/cloudflare/agents/pull/434) [`f0c6dce`](https://github.com/cloudflare/agents/commit/f0c6dceea9eaf4a682d3b0f3ecdbedcf3cc93c19) Thanks [@threepointone](https://github.com/threepointone)! - don't autowrap getters on an agent

- [#446](https://github.com/cloudflare/agents/pull/446) [`696d33e`](https://github.com/cloudflare/agents/commit/696d33e5fcc0821317276b6b18231818f5c54772) Thanks [@Flouse](https://github.com/Flouse)! - fix: use Object.getOwnPropertyDescriptor for property check

- [`1e4188c`](https://github.com/cloudflare/agents/commit/1e4188cb1256bd920ed9dcdb224a7437ac415506) Thanks [@threepointone](https://github.com/threepointone)! - update workers-ai-provider

- [#436](https://github.com/cloudflare/agents/pull/436) [`8dac62c`](https://github.com/cloudflare/agents/commit/8dac62c6f6c513d7fd481eb3b519b533bac17f1f) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - Fix onConnect race condition

- [#409](https://github.com/cloudflare/agents/pull/409) [`352d62c`](https://github.com/cloudflare/agents/commit/352d62c6383797512be112ff3efcb462c0e44395) Thanks [@MrgSub](https://github.com/MrgSub)! - Refactor message types to use enum in AIChatAgent and related files

- [#442](https://github.com/cloudflare/agents/pull/442) [`0dace6e`](https://github.com/cloudflare/agents/commit/0dace6e34cb32a018f0122c036e87d6c7f47d318) Thanks [@threepointone](https://github.com/threepointone)! - fix: don't wrap a method with an agent context if it's already wrapped

## 0.0.113

### Patch Changes

- [`fd59ae2`](https://github.com/cloudflare/agents/commit/fd59ae225019ed8f3b20aa23f853d70d6d36b5db) Thanks [@threepointone](https://github.com/threepointone)! - fix: prefix mcp tool names with tool\_

## 0.0.112

### Patch Changes

- [#404](https://github.com/cloudflare/agents/pull/404) [`2a6e66e`](https://github.com/cloudflare/agents/commit/2a6e66e9e54e14e00a06c87065980bdeefd85369) Thanks [@threepointone](https://github.com/threepointone)! - udpate dependencies

- [#404](https://github.com/cloudflare/agents/pull/404) [`2a6e66e`](https://github.com/cloudflare/agents/commit/2a6e66e9e54e14e00a06c87065980bdeefd85369) Thanks [@threepointone](https://github.com/threepointone)! - log less data

  as part of our observability impl, we were logging way too much data, making it a probable data leak, but also blowing past the max size limit on o11y messages. This reduces the amount of data logged.

## 0.0.111

### Patch Changes

- [`0cf8e80`](https://github.com/cloudflare/agents/commit/0cf8e802b29fed4d83d7ff2c55fdfb72a1fa5a0f) Thanks [@threepointone](https://github.com/threepointone)! - trigegr a release

## 0.0.110

### Patch Changes

- [#392](https://github.com/cloudflare/agents/pull/392) [`669a2b0`](https://github.com/cloudflare/agents/commit/669a2b0d75844495da7fcefed2127d5bd820c551) Thanks [@Maximo-Guk](https://github.com/Maximo-Guk)! - fix: Ensure McpAgent props stay current

- [#394](https://github.com/cloudflare/agents/pull/394) [`e4a2352`](https://github.com/cloudflare/agents/commit/e4a2352b04a588f3e593ebe8bbf78df9cb2ecff8) Thanks [@threepointone](https://github.com/threepointone)! - update state incrementally as mcp servers connect

- [#390](https://github.com/cloudflare/agents/pull/390) [`b123357`](https://github.com/cloudflare/agents/commit/b123357202884e2610cbcdb5857e38b94944fca9) Thanks [@threepointone](https://github.com/threepointone)! - update (most) dependencies

- [#376](https://github.com/cloudflare/agents/pull/376) [`1eac06e`](https://github.com/cloudflare/agents/commit/1eac06e1f3ad61a91227ef54351521435762182d) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add elicitation support and examples

- [`3bcb134`](https://github.com/cloudflare/agents/commit/3bcb134710d6e7db7830281e29c91c504e6841b9) Thanks [@threepointone](https://github.com/threepointone)! - update partysocket

- [#374](https://github.com/cloudflare/agents/pull/374) [`b63b4a6`](https://github.com/cloudflare/agents/commit/b63b4a6740a8d437109a138d7bea64615afdc1c6) Thanks [@laulauland](https://github.com/laulauland)! - Improve MCP client connection resilience with Promise.allSettled

- [#378](https://github.com/cloudflare/agents/pull/378) [`c69f616`](https://github.com/cloudflare/agents/commit/c69f616c15db81c09916cbd68eb6d07abe023a0b) Thanks [@amorriscode](https://github.com/amorriscode)! - add auto transport option

- [#387](https://github.com/cloudflare/agents/pull/387) [`8c2713f`](https://github.com/cloudflare/agents/commit/8c2713f59f5ba04af7ae06e2f6c28f6fcf6d6d37) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix/mcp agent error handling

## 0.0.109

### Patch Changes

- [#372](https://github.com/cloudflare/agents/pull/372) [`a45f8f3`](https://github.com/cloudflare/agents/commit/a45f8f3cd8f4f392d585cc13c721570e263094d7) Thanks [@threepointone](https://github.com/threepointone)! - default Agent's Env to cloudflare's Env

## 0.0.108

### Patch Changes

- [#357](https://github.com/cloudflare/agents/pull/357) [`40bd73c`](https://github.com/cloudflare/agents/commit/40bd73cbb29e5fc4a2625ce7d895b9e8c70d76a3) Thanks [@davemurphysf](https://github.com/davemurphysf)! - Pass incoming headers to the DO fetch method

## 0.0.107

### Patch Changes

- [#364](https://github.com/cloudflare/agents/pull/364) [`885b3db`](https://github.com/cloudflare/agents/commit/885b3db8af3f482b2892764077c05afc491f0b35) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - add HTTP Streamable support

## 0.0.106

### Patch Changes

- [#359](https://github.com/cloudflare/agents/pull/359) [`14bb798`](https://github.com/cloudflare/agents/commit/14bb798a1f79ef4052a9134dc5f5a4baee042812) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix email routing to be case-insensitive for agent names

## 0.0.105

### Patch Changes

- [#354](https://github.com/cloudflare/agents/pull/354) [`f31397c`](https://github.com/cloudflare/agents/commit/f31397cb7f8b67fc736faece51364edeaf52e5a0) Thanks [@jahands](https://github.com/jahands)! - fix: dequeue items in DB after each task is complete

  Prevents a single failure from causing all items in the queue from being retried (including previously processed items that were successful).

## 0.0.104

### Patch Changes

- [#319](https://github.com/cloudflare/agents/pull/319) [`e48e5f9`](https://github.com/cloudflare/agents/commit/e48e5f928030e3cc8d8a73cfa8783354be0b7648) Thanks [@threepointone](https://github.com/threepointone)! - add lightweight .queue

- [#352](https://github.com/cloudflare/agents/pull/352) [`0bb74b8`](https://github.com/cloudflare/agents/commit/0bb74b89db99c7c31a1b7a9a35e0f2aa9814962d) Thanks [@threepointone](https://github.com/threepointone)! - email adaptor

- [#345](https://github.com/cloudflare/agents/pull/345) [`c5e3a32`](https://github.com/cloudflare/agents/commit/c5e3a324b16c75ace2b48a5842a2755546db4539) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add automatic context wrapping for custom Agent methods

## 0.0.103

### Patch Changes

- [#350](https://github.com/cloudflare/agents/pull/350) [`70ed631`](https://github.com/cloudflare/agents/commit/70ed6317bc50d32115f39119133fea5f154cde94) Thanks [@ghostwriternr](https://github.com/ghostwriternr)! - Fix TypeScript types resolution by reordering export conditions

## 0.0.102

### Patch Changes

- [#238](https://github.com/cloudflare/agents/pull/238) [`dc7a99c`](https://github.com/cloudflare/agents/commit/dc7a99ca3cc60a8be069bb1094c6dd15bd2555f2) Thanks [@zebp](https://github.com/zebp)! - Basic observability instrumentation

## 0.0.101

### Patch Changes

- [#339](https://github.com/cloudflare/agents/pull/339) [`22d140b`](https://github.com/cloudflare/agents/commit/22d140b360365ac51ed9ebdad2beab6bc7095c9e) Thanks [@threepointone](https://github.com/threepointone)! - udpate dependencies

## 0.0.100

### Patch Changes

- [#331](https://github.com/cloudflare/agents/pull/331) [`7acfd65`](https://github.com/cloudflare/agents/commit/7acfd654bc1773c975fd8f61111c76e83c132fe5) Thanks [@geelen](https://github.com/geelen)! - Adding a new MCP header to the CORS allowlist to follow the updated spec

## 0.0.99

### Patch Changes

- [#332](https://github.com/cloudflare/agents/pull/332) [`75614c2`](https://github.com/cloudflare/agents/commit/75614c2532ab3e9f95e4a45e6e5b4a62be33a846) Thanks [@mchockal](https://github.com/mchockal)! - MCP connect / reconnect refactor

## 0.0.98

### Patch Changes

- [`b4ebb44`](https://github.com/cloudflare/agents/commit/b4ebb44196ff423e06beb347bb0e7b16f08773b4) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.97

### Patch Changes

- [`efffe3e`](https://github.com/cloudflare/agents/commit/efffe3e2e42a7cf3d97f05122cfd5ffc3ab1ad64) Thanks [@threepointone](https://github.com/threepointone)! - trigger release

## 0.0.96

### Patch Changes

- [#325](https://github.com/cloudflare/agents/pull/325) [`7e0777b`](https://github.com/cloudflare/agents/commit/7e0777b12624cb6903053976742a33ef54ba65d7) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.95

### Patch Changes

- [#316](https://github.com/cloudflare/agents/pull/316) [`7856b4d`](https://github.com/cloudflare/agents/commit/7856b4d90afbd3faf59f2d264b59f878648153dd) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add fallback message when agent returns no response

## 0.0.94

### Patch Changes

- [`9c6b2d7`](https://github.com/cloudflare/agents/commit/9c6b2d7c79ff91c1d73279608fa55568f8b91a5a) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [#311](https://github.com/cloudflare/agents/pull/311) [`8a4558c`](https://github.com/cloudflare/agents/commit/8a4558cd9f95c1194f3d696bcb23050c3db7d257) Thanks [@threepointone](https://github.com/threepointone)! - Added a call to `this.ctx.abort('destroyed')` in the `destroy` method to ensure the agent is properly evicted during cleanup.

## 0.0.93

### Patch Changes

- [#302](https://github.com/cloudflare/agents/pull/302) [`b57e1d9`](https://github.com/cloudflare/agents/commit/b57e1d918d02607dcb68e1ca55790b6362964090) Thanks [@cmsparks](https://github.com/cmsparks)! - Fix an error where MCP servers pending connection would trigger an error

## 0.0.92

### Patch Changes

- [#299](https://github.com/cloudflare/agents/pull/299) [`eeb70e2`](https://github.com/cloudflare/agents/commit/eeb70e256594d688bb291fd49d96faa6839e4d8a) Thanks [@courtney-sims](https://github.com/courtney-sims)! - Prevent auth url from being regenerated during oauth flow

## 0.0.91

### Patch Changes

- [`7972da4`](https://github.com/cloudflare/agents/commit/7972da40a639611f253c4b4e27d18d4ff3c5a5e2) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.90

### Patch Changes

- [#295](https://github.com/cloudflare/agents/pull/295) [`cac66b8`](https://github.com/cloudflare/agents/commit/cac66b824c6dbfeb81623eed18c0e0d13db6d363) Thanks [@threepointone](https://github.com/threepointone)! - duck typing DurableObjectNamespace type

## 0.0.89

### Patch Changes

- [`87b44ab`](https://github.com/cloudflare/agents/commit/87b44ab1e277d691181eabcebde878bedc30bc2d) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [#292](https://github.com/cloudflare/agents/pull/292) [`aacf837`](https://github.com/cloudflare/agents/commit/aacf8375ccafad2b3004ee8dca2077e589eccfe7) Thanks [@cmsparks](https://github.com/cmsparks)! - Fix issue where stray MCP connection state is left after closing connection

## 0.0.88

### Patch Changes

- [#289](https://github.com/cloudflare/agents/pull/289) [`86cae6f`](https://github.com/cloudflare/agents/commit/86cae6f7d2190c6b2442bdc2682f75a504f39ae8) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Type-safe serializable RPC methods

- [#287](https://github.com/cloudflare/agents/pull/287) [`94d9a2e`](https://github.com/cloudflare/agents/commit/94d9a2e362fe10764c85327d700ee4c90a0f957e) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Improve agent types

## 0.0.87

### Patch Changes

- [#283](https://github.com/cloudflare/agents/pull/283) [`041b40f`](https://github.com/cloudflare/agents/commit/041b40f7022af097288cc3a29c1b421cde434bb9) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Improve Agent stub

## 0.0.86

### Patch Changes

- [#274](https://github.com/cloudflare/agents/pull/274) [`93ccdbd`](https://github.com/cloudflare/agents/commit/93ccdbd254c083dad9f24f34b524006ce02572ed) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Stub for Agent RPC

## 0.0.85

### Patch Changes

- [#273](https://github.com/cloudflare/agents/pull/273) [`d1f6c02`](https://github.com/cloudflare/agents/commit/d1f6c02fb425ab3f699da77693f70ad3f05652a0) Thanks [@cmsparks](https://github.com/cmsparks)! - Expose getMcpServerState internally in agent

- [#276](https://github.com/cloudflare/agents/pull/276) [`b275dea`](https://github.com/cloudflare/agents/commit/b275dea97ebb96f2a103ee34d8c53d32a02ae5c0) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Fix non-optional parameters after undefined ones

- [#279](https://github.com/cloudflare/agents/pull/279) [`2801d35`](https://github.com/cloudflare/agents/commit/2801d35ff03fb41c75904fe96690766457e6b307) Thanks [@threepointone](https://github.com/threepointone)! - rename getMcpServerState/getMcpServers

## 0.0.84

### Patch Changes

- [#269](https://github.com/cloudflare/agents/pull/269) [`0ac89c6`](https://github.com/cloudflare/agents/commit/0ac89c62b8e829e28034a9eae91d08fc280b93b9) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Add type support to react useAgent().call

## 0.0.83

### Patch Changes

- [#270](https://github.com/cloudflare/agents/pull/270) [`d6a4eda`](https://github.com/cloudflare/agents/commit/d6a4eda221bc36fd9f1bb13f5240697e153ce619) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.82

### Patch Changes

- [`04d925e`](https://github.com/cloudflare/agents/commit/04d925ee6795b907de19bcd40940062fb9e99b1b) Thanks [@threepointone](https://github.com/threepointone)! - convert two missed #methods to a private \_methods

## 0.0.81

### Patch Changes

- [#265](https://github.com/cloudflare/agents/pull/265) [`ac0e999`](https://github.com/cloudflare/agents/commit/ac0e999652919600f087f0314ce61c98d3eaf069) Thanks [@threepointone](https://github.com/threepointone)! - refactor #method/#property to private method/private property

- [#267](https://github.com/cloudflare/agents/pull/267) [`385f0b2`](https://github.com/cloudflare/agents/commit/385f0b29c716f8fa1c9719b0c68e5c830767953e) Thanks [@threepointone](https://github.com/threepointone)! - prefix private methods/properties with \_

## 0.0.80

### Patch Changes

- [#254](https://github.com/cloudflare/agents/pull/254) [`25aeaf2`](https://github.com/cloudflare/agents/commit/25aeaf24692bb82601c5df9fdce215cf2c509711) Thanks [@cmsparks](https://github.com/cmsparks)! - Move MCP lifecycle+auth handling into the Agents class

## 0.0.79

### Patch Changes

- [#261](https://github.com/cloudflare/agents/pull/261) [`881f11e`](https://github.com/cloudflare/agents/commit/881f11ec71d539c0bc53fd754662a40c9b9dc090) Thanks [@geelen](https://github.com/geelen)! - update dependencies

- [#253](https://github.com/cloudflare/agents/pull/253) [`8ebc079`](https://github.com/cloudflare/agents/commit/8ebc07945d9c282bc0b6bfd5c41f69380a82f7e6) Thanks [@adesege](https://github.com/adesege)! - fix: allow overriding fetch and request headers in SSEEdgeClientTransport

- [#260](https://github.com/cloudflare/agents/pull/260) [`ca44ae8`](https://github.com/cloudflare/agents/commit/ca44ae8257eac71170540221ddd7bf88ff8756a1) Thanks [@nickfujita](https://github.com/nickfujita)! - Update Agent.alarm to readonly, linking to schedule-task docs

- [#261](https://github.com/cloudflare/agents/pull/261) [`881f11e`](https://github.com/cloudflare/agents/commit/881f11ec71d539c0bc53fd754662a40c9b9dc090) Thanks [@geelen](https://github.com/geelen)! - Adding `mcp-session-id` to McpAgents' CORS headers to permit web-based MCP clients

## 0.0.78

### Patch Changes

- [#258](https://github.com/cloudflare/agents/pull/258) [`eede2bd`](https://github.com/cloudflare/agents/commit/eede2bd61532abeb403417dbbfe1f8e6424b39dc) Thanks [@threepointone](https://github.com/threepointone)! - wrap onRequest so getCurrentAgent works

  Fixes https://github.com/cloudflare/agents/issues/256

## 0.0.77

### Patch Changes

- [#249](https://github.com/cloudflare/agents/pull/249) [`c18c28a`](https://github.com/cloudflare/agents/commit/c18c28a253be85e582a71172e074eb97884894e9) Thanks [@dexxiez](https://github.com/dexxiez)! - chore: add top level default types to package.json

- [#246](https://github.com/cloudflare/agents/pull/246) [`c4d53d7`](https://github.com/cloudflare/agents/commit/c4d53d786da3adf67a658b8a343909ce0f3fb70d) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Ensure we are passing ctx.props to McpAgent for the Streamable transport

- [#251](https://github.com/cloudflare/agents/pull/251) [`96a8138`](https://github.com/cloudflare/agents/commit/96a81383f6b48be0cc854b8cc72f33317824721c) Thanks [@brettimus](https://github.com/brettimus)! - Ensure isLoading is false after you `stop` an ongoing chat agent request

## 0.0.76

### Patch Changes

- [#242](https://github.com/cloudflare/agents/pull/242) [`c8f53b8`](https://github.com/cloudflare/agents/commit/c8f53b860b40a27f5d2ccfe119b37945454e6576) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [#240](https://github.com/cloudflare/agents/pull/240) [`9ff62ed`](https://github.com/cloudflare/agents/commit/9ff62ed03a08837845056adb054b3cb3fda71405) Thanks [@threepointone](https://github.com/threepointone)! - mcp: Log when an error is caught inside onSSEMcpMessage

- [#239](https://github.com/cloudflare/agents/pull/239) [`7bd597a`](https://github.com/cloudflare/agents/commit/7bd597ad453a704bca98204ca2de5dc610808fcf) Thanks [@sushichan044](https://github.com/sushichan044)! - fix(types): explicitly annotate this with void to avoid unbound method warning

## 0.0.75

### Patch Changes

- [`6c24007`](https://github.com/cloudflare/agents/commit/6c240075fb435642407f3a8751a12f3c8df53b6c) Thanks [@threepointone](https://github.com/threepointone)! - Revert "fool typescript into thinking agent will always be defined in ge…

## 0.0.74

### Patch Changes

- [`ad0054b`](https://github.com/cloudflare/agents/commit/ad0054be3b6beffcf77dff616b02a3ab1e60bbb5) Thanks [@threepointone](https://github.com/threepointone)! - fool typescript into thinking agent will always be defined in getCurrentAgent()

## 0.0.73

### Patch Changes

- [#231](https://github.com/cloudflare/agents/pull/231) [`ba99b7c`](https://github.com/cloudflare/agents/commit/ba99b7c789df990ca82191fbd174402dbce79b42) Thanks [@threepointone](https://github.com/threepointone)! - update deps to pick up a potential fix for onStart not firing

## 0.0.72

### Patch Changes

- [`a25eb55`](https://github.com/cloudflare/agents/commit/a25eb55790f8be7b47d4aabac91e167c49ac18a4) Thanks [@threepointone](https://github.com/threepointone)! - don't throw if no current agent

## 0.0.71

### Patch Changes

- [#228](https://github.com/cloudflare/agents/pull/228) [`f973b54`](https://github.com/cloudflare/agents/commit/f973b540fc2b5fdd1a4a7a0d473bb26c785fa2c3) Thanks [@threepointone](https://github.com/threepointone)! - mcp client: fix tool name generation

## 0.0.70

### Patch Changes

- [#226](https://github.com/cloudflare/agents/pull/226) [`5b7f03e`](https://github.com/cloudflare/agents/commit/5b7f03e6126498da25b4e84f83569c06f76b4cbd) Thanks [@threepointone](https://github.com/threepointone)! - mcp client: closeConnection(id) and closeAllConnections()

## 0.0.69

### Patch Changes

- [#224](https://github.com/cloudflare/agents/pull/224) [`b342dcf`](https://github.com/cloudflare/agents/commit/b342dcfcce1192935d83585312b777cd96c33e71) Thanks [@threepointone](https://github.com/threepointone)! - getCurrentAgent()

## 0.0.68

### Patch Changes

- [#222](https://github.com/cloudflare/agents/pull/222) [`44dc3a4`](https://github.com/cloudflare/agents/commit/44dc3a428a7026650c60af95aff64e5b12c76b04) Thanks [@threepointone](https://github.com/threepointone)! - prepend mcp tool names with server id, use nanoid everywhere

- [#221](https://github.com/cloudflare/agents/pull/221) [`f59e6a2`](https://github.com/cloudflare/agents/commit/f59e6a222fffe1422340b43ccab33c2db5251f0b) Thanks [@ruifigueira](https://github.com/ruifigueira)! - Support server as promises in McpAgent

## 0.0.67

### Patch Changes

- [#219](https://github.com/cloudflare/agents/pull/219) [`aa5f972`](https://github.com/cloudflare/agents/commit/aa5f972ee2942107addafd45d6163ae56579f862) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Fix type error for McpAgent.serve and McpAgent.serveSSE

## 0.0.66

### Patch Changes

- [#215](https://github.com/cloudflare/agents/pull/215) [`be4b7a3`](https://github.com/cloudflare/agents/commit/be4b7a38e7f462cfeed2da0812f0782b23767b9d) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [`843745d`](https://github.com/cloudflare/agents/commit/843745dfd5cec77463aa00021d841c2ed1abf51d) Thanks [@threepointone](https://github.com/threepointone)! - Thanks @brettimus for #105: Propagate cancellation signals from useAgentChat to ChatAgent

- [#217](https://github.com/cloudflare/agents/pull/217) [`8d8216c`](https://github.com/cloudflare/agents/commit/8d8216c1e233fabf779994578da6447f1d20cf2b) Thanks [@threepointone](https://github.com/threepointone)! - Add .mcp to the Agent class, and add a helper to McpClientManager to convert tools to work with AI SDK

- [#212](https://github.com/cloudflare/agents/pull/212) [`5342ce4`](https://github.com/cloudflare/agents/commit/5342ce4f67485b2199eed6f4cd6027330964c60f) Thanks [@pbteja1998](https://github.com/pbteja1998)! - do not remove search params and hash from mcp endpoint message

## 0.0.65

### Patch Changes

- [#205](https://github.com/cloudflare/agents/pull/205) [`3f532ba`](https://github.com/cloudflare/agents/commit/3f532bafda1a24ab6a2e8872302093bbc5b51b61) Thanks [@threepointone](https://github.com/threepointone)! - Let .server on McpAgent be a Server or McpServer

- [#208](https://github.com/cloudflare/agents/pull/208) [`85d8edd`](https://github.com/cloudflare/agents/commit/85d8eddc7ab62499cc27100adcd0894be0c8c974) Thanks [@a-type](https://github.com/a-type)! - Fix: resolved a problem in useAgentChat where initial messages would be refetched on re-render when using React StrictMode

## 0.0.64

### Patch Changes

- [#206](https://github.com/cloudflare/agents/pull/206) [`0c4b61c`](https://github.com/cloudflare/agents/commit/0c4b61cc78d6520523eed23a41b0b851ac763753) Thanks [@threepointone](https://github.com/threepointone)! - mcp client: result schema and options are optional

## 0.0.63

### Patch Changes

- [#202](https://github.com/cloudflare/agents/pull/202) [`1e060d3`](https://github.com/cloudflare/agents/commit/1e060d361d1b49aef3717f9d760d521577c06ff9) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - await stream writer calls in websocket handlers

- [#199](https://github.com/cloudflare/agents/pull/199) [`717b21f`](https://github.com/cloudflare/agents/commit/717b21f7763362c8c1321e9befb037dc6664f433) Thanks [@pauldraper](https://github.com/pauldraper)! - Add missing dependencies to agents

- [#203](https://github.com/cloudflare/agents/pull/203) [`f5b5854`](https://github.com/cloudflare/agents/commit/f5b5854aee4f3487974f4ac6452c1064181c1809) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Jmorrell/fix streamable hibernation issue

- [#186](https://github.com/cloudflare/agents/pull/186) [`90db5ba`](https://github.com/cloudflare/agents/commit/90db5ba878b48ad831ba889d0dff475268971943) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Rename McpAgent.mount to McpAgent.serveSSE with McpAgent.mount serving as an alias for backward compatibility

- [#186](https://github.com/cloudflare/agents/pull/186) [`90db5ba`](https://github.com/cloudflare/agents/commit/90db5ba878b48ad831ba889d0dff475268971943) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Update dependencies

## 0.0.62

### Patch Changes

- [#197](https://github.com/cloudflare/agents/pull/197) [`b30ffda`](https://github.com/cloudflare/agents/commit/b30ffda6d7bfd11f5346310c8cdb0f369f505560) Thanks [@threepointone](https://github.com/threepointone)! - fix websocket missing message trigger

## 0.0.61

### Patch Changes

- [#196](https://github.com/cloudflare/agents/pull/196) [`ba5a5fe`](https://github.com/cloudflare/agents/commit/ba5a5fedae6b8ea6e83a3116ea115f5a9465ef0a) Thanks [@threepointone](https://github.com/threepointone)! - expose persistMessages on AIChatAgent

- [#126](https://github.com/cloudflare/agents/pull/126) [`1bfd6a7`](https://github.com/cloudflare/agents/commit/1bfd6a77f2c2019b54f40f5a72ff7e4b4df57157) Thanks [@nickfujita](https://github.com/nickfujita)! - Add ai-types to esm exports

## 0.0.60

### Patch Changes

- [#173](https://github.com/cloudflare/agents/pull/173) [`49fb428`](https://github.com/cloudflare/agents/commit/49fb4282870c77ab9f3ab2a4ae49b7b60cabbfb2) Thanks [@cmsparks](https://github.com/cmsparks)! - fix: require authProvider on client connect and handle client "Method not found" initialization errors

## 0.0.59

### Patch Changes

- [#168](https://github.com/cloudflare/agents/pull/168) [`2781f7d`](https://github.com/cloudflare/agents/commit/2781f7d7275bfada743c6c5531aab42db5e675a7) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.58

### Patch Changes

- [`33b22fe`](https://github.com/cloudflare/agents/commit/33b22fe146bb8b721b4d33c607a044ea64c0706a) Thanks [@threepointone](https://github.com/threepointone)! - don't import WorkflowEntrypoint

  fixes https://github.com/cloudflare/agents/issues/166

## 0.0.57

### Patch Changes

- [#163](https://github.com/cloudflare/agents/pull/163) [`956c772`](https://github.com/cloudflare/agents/commit/956c772712962dfeef21d2b7ab6740600b308596) Thanks [@brishin](https://github.com/brishin)! - Fix: Missing agent dep in useCallback

- [#164](https://github.com/cloudflare/agents/pull/164) [`3824fd4`](https://github.com/cloudflare/agents/commit/3824fd4dfdd99c80cba5ea031e950a460d495256) Thanks [@threepointone](https://github.com/threepointone)! - revert https://github.com/cloudflare/agents/pull/161

## 0.0.56

### Patch Changes

- [#161](https://github.com/cloudflare/agents/pull/161) [`1f6598e`](https://github.com/cloudflare/agents/commit/1f6598eda2d6c4528797870fe74529e41142ff96) Thanks [@threepointone](https://github.com/threepointone)! - mcp: remove duplicate agent init, await root .init()

## 0.0.55

### Patch Changes

- [#159](https://github.com/cloudflare/agents/pull/159) [`b8377c1`](https://github.com/cloudflare/agents/commit/b8377c1efcd00fa2719676edc9e8d2ef02a20a23) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - Fix issues with McpAgent and setState introduced by hibernation changes

## 0.0.54

### Patch Changes

- [#140](https://github.com/cloudflare/agents/pull/140) [`2f5cb3a`](https://github.com/cloudflare/agents/commit/2f5cb3ac4a9fbb9dc79b137b74336681f60be5a0) Thanks [@cmsparks](https://github.com/cmsparks)! - Remote MCP Client with auth support

  This PR adds:
  - Support for authentication for MCP Clients (Via a DO based auth provider)
  - Some improvements to the client API per #135
  - A more in depth example of MCP Client, which allows you to add any number of remote MCP servers with or without auth

## 0.0.53

### Patch Changes

- [#149](https://github.com/cloudflare/agents/pull/149) [`49e8b36`](https://github.com/cloudflare/agents/commit/49e8b362d77a68f2e891f655b9971b737e394f9e) Thanks [@irvinebroque](https://github.com/irvinebroque)! - Automatically change "/" path to "/\*" in MCP server mount() method

## 0.0.52

### Patch Changes

- [#151](https://github.com/cloudflare/agents/pull/151) [`e376805`](https://github.com/cloudflare/agents/commit/e376805ccd88b08e853b1894cc703e6f67f2ed1d) Thanks [@threepointone](https://github.com/threepointone)! - useAgent: don't throw when `query` is an async url provider

## 0.0.51

### Patch Changes

- [#146](https://github.com/cloudflare/agents/pull/146) [`316f98c`](https://github.com/cloudflare/agents/commit/316f98c3f70792f6daa86d3e92f8a466b5509bb5) Thanks [@threepointone](https://github.com/threepointone)! - remove lowercase warning for agent names

## 0.0.50

### Patch Changes

- [#142](https://github.com/cloudflare/agents/pull/142) [`1461795`](https://github.com/cloudflare/agents/commit/146179598b05945ee07e95261e6a83979c9a07d9) Thanks [@threepointone](https://github.com/threepointone)! - ai-chat-agent: pass query params correctly in /get-messages

## 0.0.49

### Patch Changes

- [#138](https://github.com/cloudflare/agents/pull/138) [`3bbbf81`](https://github.com/cloudflare/agents/commit/3bbbf812bbe3d1a2c3252e88a0ca49c7127b4820) Thanks [@geelen](https://github.com/geelen)! - Fixed internal build issue that caused incomplete package to be published

## 0.0.48

### Patch Changes

- [#125](https://github.com/cloudflare/agents/pull/125) [`62d4e85`](https://github.com/cloudflare/agents/commit/62d4e854e76204737c8b3bd7392934f37abeb3ca) Thanks [@cmsparks](https://github.com/cmsparks)! - MCP Client x Agents Implementation

- [#128](https://github.com/cloudflare/agents/pull/128) [`df716f2`](https://github.com/cloudflare/agents/commit/df716f2911acfc0e7461d3698f8e1b06947ea38b) Thanks [@jmorrell-cloudflare](https://github.com/jmorrell-cloudflare)! - MCP: Hibernate-able transport

- [#137](https://github.com/cloudflare/agents/pull/137) [`c3e8618`](https://github.com/cloudflare/agents/commit/c3e8618fbe64565e3bf039331a445c12945bf9ed) Thanks [@threepointone](https://github.com/threepointone)! - convert input `agent` in clients to kebab-case as expected by the server

## 0.0.47

### Patch Changes

- [#133](https://github.com/cloudflare/agents/pull/133) [`6dc3b6a`](https://github.com/cloudflare/agents/commit/6dc3b6aa2b4137f0a3022932d2038def9e03f5d2) Thanks [@threepointone](https://github.com/threepointone)! - remove description as an arg from getSchedules

- [#130](https://github.com/cloudflare/agents/pull/130) [`7ff0509`](https://github.com/cloudflare/agents/commit/7ff050994c223bbd1cb390e3a085b31023c2554f) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.46

### Patch Changes

- [`7c40201`](https://github.com/cloudflare/agents/commit/7c402012fa43c606e5455a13604ef7a6369989ed) Thanks [@threepointone](https://github.com/threepointone)! - mark context as unstable\_

## 0.0.45

### Patch Changes

- [#122](https://github.com/cloudflare/agents/pull/122) [`d045755`](https://github.com/cloudflare/agents/commit/d045755a3f465481531ca7556317c0a0be811438) Thanks [@threepointone](https://github.com/threepointone)! - `import {context} from 'agents';`

  Export the current agent, request, and connection from a shared context. Particularly useful for tool calls that might not have access to the current agent in their module scope.

## 0.0.44

### Patch Changes

- [#118](https://github.com/cloudflare/agents/pull/118) [`6e66bd4`](https://github.com/cloudflare/agents/commit/6e66bd4471d1eef10043297208033bd172898f10) Thanks [@max-stytch](https://github.com/max-stytch)! - fix: Pass Env param thru to DurableObject definition

- [#121](https://github.com/cloudflare/agents/pull/121) [`82d5412`](https://github.com/cloudflare/agents/commit/82d54121a6fa8c035a1e2d6b036165eae0624899) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.43

### Patch Changes

- [#111](https://github.com/cloudflare/agents/pull/111) [`eb6827a`](https://github.com/cloudflare/agents/commit/eb6827a8b97b3ce5f7e06afbe83a01201350d26a) Thanks [@threepointone](https://github.com/threepointone)! - update deps

  replace the beta release of partysocket with a real one

## 0.0.42

### Patch Changes

- [#107](https://github.com/cloudflare/agents/pull/107) [`4f3dfc7`](https://github.com/cloudflare/agents/commit/4f3dfc710797697aedaa29cef64923533a2cb071) Thanks [@threepointone](https://github.com/threepointone)! - update deps, allow sub/path/prefix, AND_BINDINGS_LIKE_THIS

  of note,
  - the partyserver update now allows for prefixes that/have/sub/paths
  - bindings THAT_LOOK_LIKE_THIS are correctly converted to kebabcase now

## 0.0.41

### Patch Changes

- [#106](https://github.com/cloudflare/agents/pull/106) [`1d1b74c`](https://github.com/cloudflare/agents/commit/1d1b74ce9f4a5f5fc698da280da71c08f0a7c7ce) Thanks [@geelen](https://github.com/geelen)! - Adding the first iteration of McpAgent

- [#103](https://github.com/cloudflare/agents/pull/103) [`9be8008`](https://github.com/cloudflare/agents/commit/9be80083a80a89c1b106599bda28d4a8aa7292f2) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.40

### Patch Changes

- [#100](https://github.com/cloudflare/agents/pull/100) [`ee727ca`](https://github.com/cloudflare/agents/commit/ee727caf52071221fbf79fd651f37ce12185bdae) Thanks [@danieljvdm](https://github.com/danieljvdm)! - Pass state generic through `useAgentChat`

## 0.0.39

### Patch Changes

- [#96](https://github.com/cloudflare/agents/pull/96) [`d7d2876`](https://github.com/cloudflare/agents/commit/d7d287608fcdf78a4c914ee0590ea4ef8e81623f) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.38

### Patch Changes

- [#94](https://github.com/cloudflare/agents/pull/94) [`fb4d0a6`](https://github.com/cloudflare/agents/commit/fb4d0a6a564824a7faba02d7a181ae4b170ba820) Thanks [@threepointone](https://github.com/threepointone)! - better error handling (based on #65 by @elithrar)
  - implement `this.onError` for custom error handling
  - log errors from more places
  - catch some missed async errors and log them
  - mark some methods as actually private

## 0.0.37

### Patch Changes

- [#92](https://github.com/cloudflare/agents/pull/92) [`fbaa8f7`](https://github.com/cloudflare/agents/commit/fbaa8f799d1c666aba57b38bfc342580f19be70e) Thanks [@threepointone](https://github.com/threepointone)! - Renamed agents-sdk -> agents

## 0.0.36

### Patch Changes

- [#74](https://github.com/cloudflare/agents/pull/74) [`7bcdd83`](https://github.com/cloudflare/agents/commit/7bcdd8396d6789b1fc7323be465fbd61311c5181) Thanks [@gingerhendrix](https://github.com/gingerhendrix)! - Replace discriminatedUnion with simple object for Gemini models

## 0.0.35

### Patch Changes

- [#88](https://github.com/cloudflare/agents/pull/88) [`7532166`](https://github.com/cloudflare/agents/commit/7532166ecfc2bcf4f169907d0dd9c399336212ac) Thanks [@threepointone](https://github.com/threepointone)! - pass `cors:true` to `routeAgentRequest` to automatically use across domains

## 0.0.34

### Patch Changes

- [`39197ab`](https://github.com/cloudflare/agents/commit/39197ab65a08784b4d5851d5844cb5287c43040e) Thanks [@threepointone](https://github.com/threepointone)! - remove `cf_agent_chat_init` message

## 0.0.33

### Patch Changes

- [#85](https://github.com/cloudflare/agents/pull/85) [`acbc34e`](https://github.com/cloudflare/agents/commit/acbc34e0122835fbeae3a18b88932cc1b0a1802d) Thanks [@threepointone](https://github.com/threepointone)! - Add RPC support with `unstable_callable` decorator for method exposure. This feature enables:
  - Remote procedure calls from clients to agents
  - Method decoration with `@unstable_callable` to expose agent methods
  - Support for both regular and streaming RPC calls
  - Type-safe RPC calls with automatic response handling
  - Real-time streaming responses for long-running operations

  Note: The `callable` decorator has been renamed to `unstable_callable` to indicate its experimental status.

## 0.0.32

### Patch Changes

- [#83](https://github.com/cloudflare/agents/pull/83) [`a9248c7`](https://github.com/cloudflare/agents/commit/a9248c74c3b7af2a0085d15f02712c243e870cc3) Thanks [@threepointone](https://github.com/threepointone)! - add state sync to the regular agent client

  fixes https://github.com/cloudflare/agents/issues/9

## 0.0.31

### Patch Changes

- [`2c077c7`](https://github.com/cloudflare/agents/commit/2c077c7e800d20679afe23a37b6bbbec87ed53ac) Thanks [@threepointone](https://github.com/threepointone)! - warn if agent/name passed to client isn't in lowercase

## 0.0.30

### Patch Changes

- [`db70ceb`](https://github.com/cloudflare/agents/commit/db70ceb22e8d27717ca13cbdcf9d6364a792d1ab) Thanks [@threepointone](https://github.com/threepointone)! - fix async/await error for useAgentChat

## 0.0.29

### Patch Changes

- [#79](https://github.com/cloudflare/agents/pull/79) [`1dad549`](https://github.com/cloudflare/agents/commit/1dad5492fbf7e07af76da83767b48af56c503763) Thanks [@threepointone](https://github.com/threepointone)! - clear initial message cache on unmount, add getInitialMessages

  This clears the initial messages cache whenever useAgentChat is unmounted. Additionally, it adds a getInitialMessages option to pass your own custom method for setting initial messages. Setting getInitialMessages:null disables any fetch for initial messages, so that the user can populate initialMessages by themselves if they'd like.

  I also added a chat example to the playground.

## 0.0.28

### Patch Changes

- [`8ade3af`](https://github.com/cloudflare/agents/commit/8ade3af36d1b18636adfeb2491805e1368fba9d7) Thanks [@threepointone](https://github.com/threepointone)! - export Schedule type

- [#77](https://github.com/cloudflare/agents/pull/77) [`82f277d`](https://github.com/cloudflare/agents/commit/82f277d118b925af822e147240aa9918a5f3851e) Thanks [@threepointone](https://github.com/threepointone)! - pass credentials to get-messages call

## 0.0.27

### Patch Changes

- [`5b96c8a`](https://github.com/cloudflare/agents/commit/5b96c8a2cb26c683b34d41783eaced74216092e1) Thanks [@threepointone](https://github.com/threepointone)! - unstable\_ scheduling prompt helper shouldn't take input text

## 0.0.26

### Patch Changes

- [`06c4386`](https://github.com/cloudflare/agents/commit/06c438620873068499d757fb9fcef11c48c0e558) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [#62](https://github.com/cloudflare/agents/pull/62) [`2d680f3`](https://github.com/cloudflare/agents/commit/2d680f3cccc200afdfe456e9432b645247fbce9a) Thanks [@threepointone](https://github.com/threepointone)! - unstable\_ scheduling helpers

- [`48ff237`](https://github.com/cloudflare/agents/commit/48ff2376087c71e6e7316c85c86e7e0559d57222) Thanks [@threepointone](https://github.com/threepointone)! - (for @sam-goodwin, #58) fix: pass headers to /get-messages

## 0.0.25

### Patch Changes

- [#53](https://github.com/cloudflare/agents/pull/53) [`877d551`](https://github.com/cloudflare/agents/commit/877d55169a49a767b703e39e0032a4df6681709f) Thanks [@deathbyknowledge](https://github.com/deathbyknowledge)! - fix onMessage not getting called

## 0.0.24

### Patch Changes

- [#51](https://github.com/cloudflare/agents/pull/51) [`b244068`](https://github.com/cloudflare/agents/commit/b244068c7266f048493b3796393cfa74bbbd9ec1) Thanks [@elithrar](https://github.com/elithrar)! - Fixes a bug with JSON parsing and the React state hooks.

## 0.0.23

### Patch Changes

- [#46](https://github.com/cloudflare/agents/pull/46) [`6efb950`](https://github.com/cloudflare/agents/commit/6efb9502612189f4a6f06435fc908e65af65eb88) Thanks [@threepointone](https://github.com/threepointone)! - update deps

- [#49](https://github.com/cloudflare/agents/pull/49) [`653ebad`](https://github.com/cloudflare/agents/commit/653ebadcfd49b57595a6ecb010467d3810742b93) Thanks [@threepointone](https://github.com/threepointone)! - add linting, fix a bunch of bugs.

## 0.0.22

### Patch Changes

- [#39](https://github.com/cloudflare/agents/pull/39) [`2afea20`](https://github.com/cloudflare/agents/commit/2afea2023d96204fbe6829c400c7a22baedbad2f) Thanks [@elithrar](https://github.com/elithrar)! - adds JSDoc to public symbols.

## 0.0.21

### Patch Changes

- [#37](https://github.com/cloudflare/agents/pull/37) [`ff0679f`](https://github.com/cloudflare/agents/commit/ff0679f638d377c8629a1fd2762c58045ec397b5) Thanks [@threepointone](https://github.com/threepointone)! - `Agent::initialState`

  You can now set an initial state for an agent

  ```ts
  type State = {
    counter: number;
    text: string;
    color: string;
  };

  class MyAgent extends Agent<Env, State> {
    initialState = {
      counter: 0,
      text: "",
      color: "#3B82F6",
    };

    doSomething() {
      console.log(this.state); // {counter: 0, text: "", color: "#3B82F6"}, if you haven't set the state yet
    }
  }
  ```

  As before, this gets synced to useAgent, so you can do:

  ```ts
  const [state, setState] = useState<State>();
  const agent = useAgent<State>({
    agent: "my-agent",
    onStateUpdate: (state) => {
      setState(state);
    },
  });
  ```

## 0.0.20

### Patch Changes

- [#32](https://github.com/cloudflare/agents/pull/32) [`3d4e0f9`](https://github.com/cloudflare/agents/commit/3d4e0f9db69303dd2f93de37b4f54fefacb18a33) Thanks [@Cherry](https://github.com/Cherry)! - fix: add repo/bug tracker links to packages

## 0.0.19

### Patch Changes

- [`9938444`](https://github.com/cloudflare/agents/commit/9938444b0d8d1b4910fc50647ed223a22af564a4) Thanks [@threepointone](https://github.com/threepointone)! - scheduling: do a typecheck/throw error if not a valid method on this

## 0.0.18

### Patch Changes

- [`7149fd2`](https://github.com/cloudflare/agents/commit/7149fd27371cd13ae9814bb52f777c6ffc99af62) Thanks [@threepointone](https://github.com/threepointone)! - don't log when state updates on the server

## 0.0.17

### Patch Changes

- [`54962fe`](https://github.com/cloudflare/agents/commit/54962fe37c09be752fb8d713827337986ad6343a) Thanks [@threepointone](https://github.com/threepointone)! - trigger a release

## 0.0.16

### Patch Changes

- [`d798d99`](https://github.com/cloudflare/agents/commit/d798d9959030337dce50602ab3fbd23586379e69) Thanks [@threepointone](https://github.com/threepointone)! - don't bork if connection disconnects

- [`fd17e02`](https://github.com/cloudflare/agents/commit/fd17e021a2aacf8c55b2d2ad181589d5bce79893) Thanks [@threepointone](https://github.com/threepointone)! - respond to server saved messages

- [`90fe787`](https://github.com/cloudflare/agents/commit/90fe7878ff0be64a41023070cc77742e49ec542e) Thanks [@threepointone](https://github.com/threepointone)! - fix scheduler implementation/types

## 0.0.15

### Patch Changes

- [`9075920`](https://github.com/cloudflare/agents/commit/9075920b732160ca7456ae394812a30f32c99f70) Thanks [@threepointone](https://github.com/threepointone)! - change onChatMessage signature

## 0.0.14

### Patch Changes

- [`2610509`](https://github.com/cloudflare/agents/commit/26105091622cef2c2f8aae60d4e673587d142739) Thanks [@threepointone](https://github.com/threepointone)! - Hono Agents

- [`7a3a1a0`](https://github.com/cloudflare/agents/commit/7a3a1a049adfe3d125696ce65881d04eb0ebe8df) Thanks [@threepointone](https://github.com/threepointone)! - AgentContext

## 0.0.13

### Patch Changes

- [`066c378`](https://github.com/cloudflare/agents/commit/066c378f4bcfaf2aa231e4e898bf2e22dc81f9f1) Thanks [@threepointone](https://github.com/threepointone)! - setState() doesn't take source anymore

## 0.0.12

### Patch Changes

- [`2864acf`](https://github.com/cloudflare/agents/commit/2864acfeab983efa3316c44f339cddb5bc86cd14) Thanks [@threepointone](https://github.com/threepointone)! - chat agent can now saveMessages explicitly

## 0.0.11

### Patch Changes

- [`7035ef5`](https://github.com/cloudflare/agents/commit/7035ef5327b650a11f721c08b57373a294354e9a) Thanks [@threepointone](https://github.com/threepointone)! - trigger a release

## 0.0.10

### Patch Changes

- [#15](https://github.com/cloudflare/agents/pull/15) [`ecd9324`](https://github.com/cloudflare/agents/commit/ecd9324d8470c521dd3566446d7afae1fa0c1b9f) Thanks [@elithrar](https://github.com/elithrar)! - env type fixes

## 0.0.9

### Patch Changes

- [`8335b4b`](https://github.com/cloudflare/agents/commit/8335b4bdfc17d4cc47ca5b03d0dad7f9c64ce6a1) Thanks [@threepointone](https://github.com/threepointone)! - fix some types

## 0.0.8

### Patch Changes

- [`619dac5`](https://github.com/cloudflare/agents/commit/619dac55e11543609f2a0869b6a3f05a78fa83fd) Thanks [@threepointone](https://github.com/threepointone)! - new useChat, with multiplayer, syncing, persistence; updated HITL guide with useChat

## 0.0.7

### Patch Changes

- [`0680a02`](https://github.com/cloudflare/agents/commit/0680a0245c41959588895c0d2bd39c98ca189a38) Thanks [@threepointone](https://github.com/threepointone)! - remove email mentions from readme

## 0.0.6

### Patch Changes

- [`acbd0f6`](https://github.com/cloudflare/agents/commit/acbd0f6e1375a42ba1ad577b68f6a8264f6e9827) Thanks [@threepointone](https://github.com/threepointone)! - .state/.setState/.onStateUpdate

## 0.0.5

### Patch Changes

- [`7dab6bc`](https://github.com/cloudflare/agents/commit/7dab6bcb4429cfa02dfdb62bbce59fd29e94308f) Thanks [@threepointone](https://github.com/threepointone)! - more on agentFetch

## 0.0.4

### Patch Changes

- [`411c149`](https://github.com/cloudflare/agents/commit/411c1490c79373d8e7959fd90cfcdc4a0d87290f) Thanks [@threepointone](https://github.com/threepointone)! - actually fix client fetch

## 0.0.3

### Patch Changes

- [`40bfbef`](https://github.com/cloudflare/agents/commit/40bfbefb3d7a0b15ae83e91d76bba8c8bb62be92) Thanks [@threepointone](https://github.com/threepointone)! - fix client.fetch

## 0.0.2

### Patch Changes

- [`3f1ad74`](https://github.com/cloudflare/agents/commit/3f1ad7466bb74574131cd4ffdf7ce4d116f03d70) Thanks [@threepointone](https://github.com/threepointone)! - export some types, use a default agent name

## 0.0.1

### Patch Changes

- [`eaba262`](https://github.com/cloudflare/agents/commit/eaba262167e8b10d55fc88e4bcdb26ba17879261) Thanks [@threepointone](https://github.com/threepointone)! - do a release
