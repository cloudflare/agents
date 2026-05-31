# Sessions

A `CodemodeSession` is a DurableObject facet spawned per connector per conversation. It sits between the sandbox and the connector, managing state, approvals, and action simulation.

There is one generic session class for all connector types. The session delegates tool execution back to the connector via RPC — connectors own execution, sessions own state.

## How sessions are created

`createProxyTool` spawns one session facet per connector as a child of the agent's DurableObject:

```ts
// Internal — createProxyTool does this automatically
const session = ctx.facets.get("codemode:github", () => ({
  class: CodemodeSession
}));

// Configure: session calls back to connector for execution
session.configure(connector, "github", connector.getAnnotations());
```

Users don't create sessions manually. `createProxyTool` handles it.

## What sessions hold

Each session facet has its own DurableObject storage:

- **Pending actions** — actions awaiting user approval, stored with provisional results
- **Cached data** — future: connector-specific cached state
- **Auth tokens** — future: per-session authentication state

State survives across sandbox executions within the same conversation. When the conversation ends or the agent is destroyed, session facets are cleaned up.

## Lifecycle

```
1. createProxyTool spawns session facets
2. Session is configured with connector reference + annotations
3. Sandbox calls github.foo(args)
4. Call routes to session facet via RPC
5. Session checks annotations:
   - observation / no annotation → calls connector.executeTool() immediately
   - requiresApproval → simulates result, stores pending action
6. Result returns to sandbox
7. (Later) User approves → session.applyAction() → connector.executeTool()
```

## Architecture

```
Agent DO
  ├─ facet: codemode:github    (CodemodeSession)
  │    ├─ storage: pending actions, cached state
  │    └─ delegates executeTool() → GithubConnector (RPC)
  │
  ├─ facet: codemode:repoApi   (CodemodeSession)
  │    ├─ storage: pending actions, cached state
  │    └─ delegates executeTool() → RepoApiConnector (RPC)
  │
  └─ facet: codemode:executor  (future: working memory)
```

## Session API

The session exposes these RPC methods:

### `callTool(method, args) → ActionResult`

Main entry point. Called by the sandbox proxy.

Returns `{ result }` for immediate execution, or `{ result: provisionalResult, pending }` when approval is needed.

### `applyAction(actionId) → result`

Execute a previously pending action. Called when the user approves.

### `rejectAction(actionId)`

Discard a pending action. Called when the user rejects.

### `listPendingActions() → PendingAction[]`

List all pending actions for this session.

### `configure(connector, name, annotations)`

Set up the session with a connector reference and annotations. Called once by `createProxyTool`.

## Types

```ts
type ActionResult = {
  result: unknown;
  pending?: PendingAction;
};

type PendingAction = {
  id: string;
  connector: string;
  method: string;
  args: unknown;
  description?: string;
  provisionalResult: unknown;
  createdAt: number;
};

type ApprovalRequest = {
  id: string;
  connector: string;
  method: string;
  args: unknown;
  description?: string;
};

type ApprovalResponse = {
  action: "approve" | "reject" | "cancel";
};
```

## Why one generic session

Earlier designs had `McpSession`, `OpenApiSession`, `ToolsetSession` — one per connector type. But the only difference was `executeTool()`, which just dispatches to the connector. Since functions can't be passed over Workers RPC, the session holds a reference to the connector (a `WorkerEntrypoint` / `ServiceStub`) and calls `connector.executeTool()` via RPC.

One class, all connector types. The connector owns execution logic. The session owns state.
