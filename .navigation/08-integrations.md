# 08 — Integrations: Routing, Email, Workflows, Hono, Browser

This section covers the glue code that connects agents to the wider world: the HTTP routing layer, inbound email handling, Cloudflare Workflows, the Hono middleware, browser automation tools, and the Chat SDK state adapter.

---

## HTTP routing (`src/index.ts` — routing section)

These are the functions you put in your Worker's `fetch` handler.

[`routeAgentRequest<Env>(request, env, ctx, options?)`](../packages/agents/src/index.ts#L9836-L9937) — routes an incoming HTTP or WebSocket request to the correct Durable Object (agent) by parsing the URL. The URL shape is `/<agent-class-name>/<agent-name>`. If the agent class name is in `env` as a Durable Object namespace binding, the request is forwarded.

[`AgentNamespace<T>` type](../packages/agents/src/index.ts#L9808-L9820) — the type of `env.MY_AGENT` — a Durable Object namespace with extra routing helpers. You declare `MY_AGENT: AgentNamespace<MyAgent>` in your `Env` interface.

[`getAgentByName<T>(namespace, name, options?)`](../packages/agents/src/index.ts#L10019-L10033) — get a stub for a specific agent instance by name, without going through the HTTP routing layer. Useful for server-to-server communication.

[`EmailBridge` class](../packages/agents/src/index.ts#L9870-L9937) — internal: wraps the agent's Durable Object stub to receive email callbacks. You don't instantiate this directly; `routeAgentEmail()` uses it.

---

## Sub-agent routing (`src/sub-routing.ts`)

Sub-agents (also called facets) are Durable Object *facets* — isolated compute units that share the parent agent's storage namespace but run their own code.

[`routeSubAgentRequest<Env>(request, env, ctx, options?)`](../packages/agents/src/sub-routing.ts#L1-L100) — same as `routeAgentRequest()` but for sub-agents. The path includes the parent agent's name as a prefix, e.g. `/parent-agent/my-name/sub-agent-type/sub-agent-name`.

[`getSubAgentByName<T>(namespace, parentName, subAgentName, options?)`](../packages/agents/src/sub-routing.ts#L100-L200) — get a stub for a sub-agent instance.

[`parseSubAgentPath(pathname)` and `SubAgentPathMatch` type](../packages/agents/src/sub-routing.ts#L200-L335) — parse a URL path into its components (parent agent class, parent agent name, sub-agent class, sub-agent name). Returns `null` if the path doesn't match the expected shape.

---

## Email routing (`src/email.ts`)

Agents can receive inbound emails via Cloudflare Email Workers.

[`routeAgentEmail<Env>(message, env, ctx, options?)`](../packages/agents/src/index.ts#L9938-L10018) — the top-level email handler. Parses the inbound `EmailMessage`, determines which agent should handle it (using the configured resolver), and calls `onEmail()` on that agent instance.

[`createHeaderBasedEmailResolver<Env>()`](../packages/agents/src/email.ts#L271-L312) — the simplest resolver: looks at the `X-Agent-Name` header on the inbound email to determine which agent to route to. Works well when you control the sender.

[`createSecureReplyEmailResolver<Env>(options)`](../packages/agents/src/email.ts#L313-L357) — for reply threads: extracts a signed agent identifier from the reply-to address. Uses HMAC-SHA256 to verify the signature so you know replies haven't been spoofed.

[`createAddressBasedEmailResolver<Env>()`](../packages/agents/src/email.ts#L358-L393) — routes based on the recipient email address. Parses the local part (before `@`) to extract the agent name.

[`createCatchAllEmailResolver<Env>()`](../packages/agents/src/email.ts#L394-L399) — routes all emails to a single named agent.

[`signAgentHeaders(agentName, secret)` and `isAutoReplyEmail()`](../packages/agents/src/email.ts#L38-L103) — utilities for the secure reply resolver: generate signed headers to include in outgoing email, and detect auto-reply emails that should be ignored.

[Signature verification internals](../packages/agents/src/email.ts#L103-L400) — the complete HMAC-SHA256 signature scheme for secure replies: the signing format, clock-skew tolerance (`MAX_CLOCK_SKEW_SECONDS = 5 minutes`), nonce tracking to prevent replay attacks, and the `SignatureVerificationResult` discriminated union returned by the verifier.

---

## Cloudflare Workflows (`src/workflows.ts`, `src/workflow-types.ts`)

Cloudflare Workflows are durable, multi-step async processes that can pause and resume across restarts. The Agents SDK wraps them to add callback notifications and approval flows.

### Types

[`AgentWorkflowEvent`, `AgentWorkflowStep`, `WorkflowCallback<P>` types](../packages/agents/src/workflow-types.ts#L21-L164) — the core vocabulary. `AgentWorkflowStep` extends the Cloudflare Workflows `WorkflowStep` with extra helpers. `WorkflowCallback` is a union of progress, complete, error, and event callbacks used for status notifications.

[`WorkflowTrackingRow` type](../packages/agents/src/workflow-types.ts#L178-L203) — the shape of the SQLite row the SDK uses to track a running workflow instance inside the agent.

[`ApprovalEventPayload` and `WaitForApprovalOptions` types](../packages/agents/src/workflow-types.ts#L280-L312) — the payload exchanged when a workflow step pauses to wait for human approval. The workflow emits an approval event; an agent (or any external caller) calls `approve()` or `reject()` to resume it.

[`WorkflowRejectedError`](../packages/agents/src/workflow-types.ts#L304-L312) — thrown inside a workflow step when approval is denied.

### Implementation

[AgentWorkflow — class structure, waitForApproval(), and progress()](../packages/agents/src/workflows.ts#L62-L250) and [AgentWorkflow — complete(), error(), event callbacks, and workflow tracking](../packages/agents/src/workflows.ts#L250-L437) — extend this instead of the raw Cloudflare `WorkflowEntrypoint` to get:
- Automatic tracking of workflow state in the agent's SQLite
- `this.waitForApproval(options)` — pause the step and wait for a human decision
- `this.progress(data)` — broadcast progress updates to the agent's connected clients
- `this.complete(result)` / `this.error(err)` — terminal callbacks

[`runWorkflow()` method on `Agent`](../packages/agents/src/index.ts#L9330-L9430) — start a workflow from within an agent. Returns a `WorkflowInfo` with the instance ID. The agent subscribes to the workflow's callbacks and broadcasts them to WebSocket clients.

---

## Hono middleware (`packages/hono-agents/`)

[`agentsMiddleware<E>(options?)` function](../packages/hono-agents/src/index.ts#L21-L41) — a Hono middleware factory. Detects WebSocket upgrades (via `Upgrade: websocket` header) and routes them to `handleWebSocketUpgrade()`; routes all other requests via `handleHttpRequest()`. Both delegate to `routeAgentRequest()` from the core SDK.

Usage:
```typescript
import { agentsMiddleware } from "hono-agents";
app.use("/agents/*", agentsMiddleware({ binding: "MY_AGENT" }));
```

The middleware handles the otherwise-awkward difference between `c.req.raw` (Hono's request) and what `routeAgentRequest()` expects.

---

## Browser automation tools (`src/browser/`)

These tools let agents control a headless Chrome browser via the Chrome DevTools Protocol (CDP).

[`createBrowserTools()` for AI SDK](../packages/agents/src/browser/ai.ts#L1-L72) — returns a `ToolSet` with `browser_search` and `browser_execute` tools for use with `streamText()`. The LLM writes JavaScript that runs in a sandboxed Worker with CDP access.

[`createBrowserTools()` for TanStack AI](../packages/agents/src/browser/tanstack-ai.ts#L1-L72) — same tools in TanStack's `ServerTool` format.

[createBrowserToolHandlers() — CDP spec caching and tool option normalisation](../packages/agents/src/browser/shared.ts#L1-L180) and [createBrowserToolHandlers() — tool execution, result formatting, and error handling](../packages/agents/src/browser/shared.ts#L180-L364) — the shared implementation behind both adapters. Handles CDP spec caching (5-minute TTL), tool execution, and error formatting.

[`CdpSession` class — WebSocket setup, command dispatch, and response correlation](../packages/agents/src/browser/cdp-session.ts#L1-L300) and [`CdpSession` — session cleanup and debug logging helpers](../packages/agents/src/browser/cdp-session.ts#L301-L318) — a WebSocket-based CDP client. Manages command/response correlation, target sessions, and debug logging. This is the host-side client that talks to Chrome; the generated code runs in a separate sandbox.

[`truncateResponse()` in `truncate.ts`](../packages/agents/src/browser/truncate.ts#L1-L16) — limits browser tool output to ~6 000 tokens. Adds a notice if the response was cut.

---

## Chat SDK state adapter (`src/chat-sdk/`)

The Chat SDK state adapter bridges the Agent storage layer to the `@cloudflare/ai-chat` Chat SDK's state management protocol. Used when you need to back a Chat SDK app with Durable Object storage.

[ChatSdkStateAgent — SQL table setup, lock acquisition, and lock release](../packages/agents/src/chat-sdk/agent.ts#L1-L200) and [ChatSdkStateAgent — queue operations, list operations, and subscription management](../packages/agents/src/chat-sdk/agent.ts#L200-L400) and [ChatSdkStateAgent — lock cleanup scheduling and housekeeping](../packages/agents/src/chat-sdk/agent.ts#L400-L550) — extends `Agent` to provide SQLite-backed storage for locks, queues, subscriptions, and list structures. Each operation maps to a SQL table. Lock leases are automatically cleaned up on a schedule.

[`ChatSdkStateAdapter` class in `adapter.ts`](../packages/agents/src/chat-sdk/adapter.ts#L1-L215) — implements the Chat SDK `StateAdapter` interface on top of `ChatSdkStateAgent`. Provides `connect()`, `disconnect()`, `subscribe()`, `acquireLock()`, `releaseLock()`, `enqueue()`, `dequeue()`, `appendToList()`, and `listGet()`.

[`createChatSdkState()` factory in `index.ts`](../packages/agents/src/chat-sdk/index.ts#L1-L16) — the public entry point. Takes a config object and returns a ready-to-use `ChatSdkStateAdapter`.

[`defaultThreadShard()` and `defaultKeyShard()` sharding strategies](../packages/agents/src/chat-sdk/adapter.ts#L1-L215) — determine which shard (Durable Object instance) stores a given key. The defaults distribute by thread ID and by key prefix respectively.

---

## Think extensions module index (`packages/think/src/extensions/index.ts`)

[`extensions/index.ts` re-exports](../packages/think/src/extensions/index.ts#L1-L17) — the public surface of Think's extension system. Re-exports `ExtensionManager`, `HostBridgeLoopback`, the bridge providers, and all extension types. Import from this file rather than from individual files.

---

## Browser automation module index (`src/browser/index.ts`)

[`browser/index.ts` re-exports](../packages/agents/src/browser/index.ts#L1-L15) — re-exports `createBrowserTools()` (both adapters), `createBrowserToolHandlers()`, `CdpSession`, and `truncateResponse()`.

---

## Chat SDK types (`src/chat-sdk/types.ts`)

[`ChatSdkStateParent` and `ChatSdkStateAdapterOptions` interfaces](../packages/agents/src/chat-sdk/types.ts#L1-L17) — the minimal interfaces the Chat SDK state adapter needs from the parent agent (just `getSubAgent()`) and the full options for creating an adapter instance.

---

## Hono middleware internals

[Full `hono-agents/src/index.ts`](../packages/hono-agents/src/index.ts#L1-L84) — the complete Hono middleware implementation. Beyond `agentsMiddleware()` itself, this file defines the `AgentMiddlewareContext` type (the Hono context shape), `isWebSocketUpgrade()` detection logic, and the wrappers that adapt Hono's `Context` object to the raw `Request`/`Response` shape that `routeAgentRequest()` expects.

---

## React hooks (`src/react.tsx`)

[`useAgent<T>(agent, options?)` hook](../packages/agents/src/react.tsx#L1-L100) — connects a React component to an agent. Returns `{agent: stub, state: State}` where `state` is the latest broadcast state. The hook handles WebSocket lifecycle (connect on mount, disconnect on unmount, reconnect on network error).

[`useAgentState<T>(agent, options?)` hook](../packages/agents/src/react.tsx#L100-L200) — lighter variant: just the state, no full stub reference. Useful when you only need to read state, not call methods.

[useAgent() hook — WebSocket connection setup and state subscription](../packages/agents/src/react.tsx#L1-L300) and [useAgent() — reconnection, state updates, and AgentProvider context](../packages/agents/src/react.tsx#L300-L599) and [useAgentState(), AgentContext, and hook utility exports](../packages/agents/src/react.tsx#L600-L863) — the complete file. Also exports `AgentProvider` and `useAgentContext()` for context-based access patterns.
