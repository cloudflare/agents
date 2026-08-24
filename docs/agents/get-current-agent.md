# `getCurrentAgent()`

`getCurrentAgent()` returns the Agent selected for the current invocation,
together with request-specific values such as its HTTP request or WebSocket
connection.

Import it from `agents/lifecycle`:

```ts
import { getCurrentAgent } from "agents/lifecycle";
```

The root `agents` package exports the same function as a compatibility alias.

## What is an Agent?

An Agent is any Cloudflare Durable Object with an installed `Lifecycle`:

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";

export class MyAgent extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);
}
```

The batteries-included `Agent` class exported from `agents` installs the same
Lifecycle and adds state, RPC, scheduling, MCP, workflows, fibers, and
sub-agents.

## Lifecycle hooks

Lifecycle establishes the current Agent context around capability hooks and
semantic user hooks:

| Hook                              | Available context                        |
| --------------------------------- | ---------------------------------------- |
| `onStart`, `onAlarm`              | `agent`                                  |
| `onRequest`                       | `agent`, `request`                       |
| `onConnect`                       | `agent`, `connection`, upgrade `request` |
| `onMessage`, `onClose`, `onError` | `agent`, `connection`                    |

`getConnectionTags(connection, { request })` remains argument-driven because it
already receives both values explicitly.

Code inside a hook normally uses `this` and its arguments. The ambient context
is useful for shared code whose Agent is selected only when it is invoked:

```ts
import { getCurrentAgent } from "agents/lifecycle";

function currentRequestOrigin(): string | undefined {
  const { request } = getCurrentAgent();
  return request ? new URL(request.url).origin : undefined;
}

class RequestAudit {
  onRequest(): void {
    console.log(currentRequestOrigin());
  }
}
```

The shared function is defined once and cannot capture the correct instance.
Lifecycle supplies the Agent and request dynamically for each invocation.

## Concrete Agent types

Without a type argument, `agent` uses the lifecycle `Agent` interface: a
`DurableObject` with an installed `Lifecycle` and its semantic hooks. Pass your
concrete class when shared code needs its additional APIs:

```ts
function currentState() {
  const { agent } = getCurrentAgent<MyAgent>();
  return agent?.state;
}
```

The fields are optional because the function can be called outside an Agent
invocation:

```ts
const { agent, connection, request, email } = getCurrentAgent<MyAgent>();
```

## Batteries-included Agent entry points

The batteries-included `Agent` class also establishes context for entry points
outside Lifecycle, including:

- WebSocket callable methods;
- native Durable Object RPC and cross-Agent public-method entry;
- email handlers;
- scheduled and queued callbacks;
- fiber and chat recovery;
- AI chat turns, tools, and detached work.

The public-method wrapper remains separate from Lifecycle because native Durable
Object RPC bypasses Lifecycle handlers. Lifecycle owns capability and semantic
hook context; the batteries-included class owns its additional entry surfaces.

## When context is lost

Context propagates only along the asynchronous call tree of its invocation.
Code reached through a fresh entry point starts with no context. Examples
include callbacks invoked through Worker Loader RPC, service bindings, and a
Durable Object RPC entry that is not managed by the batteries-included Agent.

Pass the required Agent explicitly, or route the call through an Agent method
that establishes the appropriate entry context. Do not retain a `request`,
`connection`, or `email` beyond its native invocation.

## API

```ts
function getCurrentAgent<T extends DurableObject = Agent>(): {
  agent: T | undefined;
  connection: Connection | undefined;
  request: Request | undefined;
  email: unknown | undefined;
};
```

The root `agents` alias retains the richer batteries-included `Agent` and
`AgentEmail` defaults for existing applications.
