# 08 — Integrations: Routing, Email, Workflows, Hono, Browser

This section covers the glue code that connects agents to the wider world: the HTTP routing layer, inbound email handling, Cloudflare Workflows, the Hono middleware, browser automation tools, and the Chat SDK state adapter.

---

## HTTP routing (`src/index.ts` — routing section)

These are the functions you put in your Worker's `fetch` handler.

[`routeAgentRequest<Env>(request, env, options?)`](../packages/agents/src/index.ts#L9836-L9846) — routes an incoming HTTP or WebSocket request to the correct Durable Object (agent) by parsing the URL. The URL shape is `/<agent-class-name>/<agent-name>`. If the agent class name is in `env` as a Durable Object namespace binding, the request is forwarded.

[`AgentNamespace<T>` type](../packages/agents/src/index.ts#L9808-L9820) — the type of `env.MY_AGENT` — a Durable Object namespace with extra routing helpers. You declare `MY_AGENT: AgentNamespace<MyAgent>` in your `Env` interface.

[`getAgentByName<T>(namespace, name, options?)`](../packages/agents/src/index.ts#L10019-L10033) — get a stub for a specific agent instance by name, without going through the HTTP routing layer. Useful for server-to-server communication.

[`EmailBridge` class and `agentMapCache`](../packages/agents/src/index.ts#L9870-L9937) — internal: `EmailBridge` (L9870-L9922) extends `RpcTarget` to wrap a `ForwardableEmailMessage`, exposing `getRaw()`, `setReject()`, `forward()`, and `reply()` as RPC methods. Using `RpcTarget` lets the runtime tear down the bidirectional session cleanly once email handling completes. `agentMapCache` (L9924-L9929) is a `WeakMap` that caches a normalised name→namespace map per `env` object to avoid rebuilding it on every email. You don't use either directly; `routeAgentEmail()` uses them internally.

---

## Sub-agent routing (`src/sub-routing.ts`)

Sub-agents (also called facets) are Durable Object *facets* — isolated compute units that share the parent agent's storage namespace but run their own code.

[`SubAgentPathMatch` type and `parseSubAgentPath(url, options?)`](../packages/agents/src/sub-routing.ts#L1-L123) — `SUB_PREFIX` constant (`"sub"`), the `SubAgentPathMatch` interface (`childClass`, `childName`, `remainingPath`), and `parseSubAgentPath()` which extracts the first `/sub/{class}/{name}` segment from a URL, converting kebab-case class names back to CamelCase against a known-classes list. Returns `null` if no matching segment is found. Internal `resolveClassName` helper is also in this range.

[`routeSubAgentRequest(req, parent, options?)`](../packages/agents/src/sub-routing.ts#L125-L241) — the sub-agent HTTP/WebSocket routing entry point. Calls `parseSubAgentPath()` then forwards the request to the parent DO's `fetch()` handler (which runs `onBeforeSubAgent` in the parent isolate). Accepts an optional `fromPath` to reroute without rewriting the full URL. Internal `rewritePathname` helper is also in this range.

[`getSubAgentByName<T>(parent, cls, name)`](../packages/agents/src/sub-routing.ts#L243-L335) — returns a typed RPC-only `Proxy` stub for a sub-agent. Each method call proxies through the parent DO via `_cf_invokeSubAgent(className, name, method, args)`. Does not support `.fetch()` (use `routeSubAgentRequest` for HTTP/WS). Does not run `onBeforeSubAgent`.

---

## Email routing (`src/email.ts`)

Agents can receive inbound emails via Cloudflare Email Workers.

[`routeAgentEmail<Env>(message, env, ctx, options?)`](../packages/agents/src/index.ts#L9938-L10018) — the top-level email handler. Parses the inbound `EmailMessage`, determines which agent should handle it (using the configured resolver), and calls `onEmail()` on that agent instance.

[`createHeaderBasedEmailResolver<Env>()` — REMOVED](../packages/agents/src/email.ts#L271-L312) — this function has been removed due to a security vulnerability (it trusted attacker-controlled email headers, enabling IDOR attacks). The stub always throws with migration guidance. Use `createAddressBasedEmailResolver` for inbound mail or `createSecureReplyEmailResolver` for reply flows instead.

[`createSecureReplyEmailResolver<Env>(options)`](../packages/agents/src/email.ts#L313-L357) — for reply threads: extracts a signed agent identifier from the reply-to address. Uses HMAC-SHA256 to verify the signature so you know replies haven't been spoofed.

[`createAddressBasedEmailResolver<Env>()`](../packages/agents/src/email.ts#L358-L393) — routes based on the recipient email address. Parses the local part (before `@`) to extract the agent name.

[`createCatchAllEmailResolver<Env>()`](../packages/agents/src/email.ts#L394-L399) — routes all emails to a single named agent.

[`isAutoReplyEmail(headers)` and internal HMAC helpers](../packages/agents/src/email.ts#L38-L103) — `isAutoReplyEmail()` (L38-L61) checks `Auto-Submitted`, `X-Auto-Response-Suppress`, and `Precedence` headers to detect automated emails that should be skipped. `computeAgentSignature()` (L81-L98) is the internal HMAC-SHA256 primitive used by both `signAgentHeaders` and `verifyAgentSignature`. `SignatureVerificationResult` discriminated union starts at L103.

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
