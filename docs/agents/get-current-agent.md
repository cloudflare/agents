# `getCurrentAgent()`

## Automatic context for custom methods

The framework detects and wraps custom Agent methods during initialization so `getCurrentAgent()` can resolve the active agent inside them and the functions they call.

## How It Works

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { getCurrentAgent } from "agents";

export class MyAgent extends AIChatAgent {
  async customMethod() {
    const { agent } = getCurrentAgent<MyAgent>();
    // ✅ agent is automatically available!
    console.log(agent.name);
  }

  async anotherMethod() {
    // ✅ This works too - no setup needed!
    const { agent } = getCurrentAgent<MyAgent>();
    return agent.state;
  }
}
```

**Zero configuration required!** The framework automatically:

1. Scans your agent class for custom methods
2. Wraps them with agent context during initialization
3. Ensures `getCurrentAgent()` works in all external functions called from your methods

## Real-World Example

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { getCurrentAgent } from "agents";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

// External utility function that needs agent context
async function processWithAI(prompt: string) {
  const { agent } = getCurrentAgent<MyAgent>();
  // ✅ External functions can access the current agent!

  return await generateText({
    model: openai("gpt-4"),
    prompt: `Agent ${agent?.name}: ${prompt}`
  });
}

export class MyAgent extends AIChatAgent {
  async customMethod(message: string) {
    // Use this.* to access agent properties directly
    console.log("Agent name:", this.name);
    console.log("Agent state:", this.state);

    // External functions automatically work!
    const result = await processWithAI(message);
    return result.text;
  }
}
```

### Built-in vs Custom Methods

- **Built-in methods** (onRequest, onEmail, onStateChanged): Already have context
- **Custom methods** (your methods): Automatically wrapped during initialization
- **External functions**: Access context through `getCurrentAgent()`

### The Context Flow

```typescript
// When you call a custom method:
agent.customMethod()
  → automatically wrapped with agentContext.run()
  → your method executes with full context
  → external functions can use getCurrentAgent()
```

## Common Use Cases

### Working with AI SDK Tools

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

export class MyAgent extends AIChatAgent {
  async generateResponse(prompt: string) {
    // AI SDK tools automatically work
    const response = await generateText({
      model: openai("gpt-4"),
      prompt,
      tools: {
        // Tools that use getCurrentAgent() work perfectly
      }
    });

    return response.text;
  }
}
```

### Calling External Libraries

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { getCurrentAgent } from "agents";

async function saveToDatabase(data: any) {
  const { agent } = getCurrentAgent<MyAgent>();
  // Can access agent info for logging, context, etc.
  console.log(`Saving data for agent: ${agent?.name}`);
}

export class MyAgent extends AIChatAgent {
  async processData(data: any) {
    // External functions automatically have context
    await saveToDatabase(data);
  }
}
```

## Calls between Agents

A stub from `getAgentByName()` tells the callee who is calling on every
method call. Inside the called method,
`getCurrentAgent().caller` is the caller's class name, Durable Object id, and
instance name, plus any `context` hints the caller attached. A call from a
Worker handler shows up as `external`. This works for any
[Lifecycle Object](./lifecycle.md), not only Agents: `Lifecycle.install` gives
the host class the entry points the stub relies on, and `getAgentByName()`
accepts any such object. A plain Lifecycle Object identifies itself on
outbound calls only while running inside a Lifecycle invocation, such as a
handler, a hook, or a call received through a contextual stub. Agent wraps its
own RPC methods in that context; a plain object's method reached over a raw
native stub has none and reports `external`.

```typescript
import { Agent, getAgentByName, getCurrentAgent } from "agents";

export class Coordinator extends Agent<Env> {
  async delegate(taskId: string) {
    const worker = await getAgentByName(this.env.WorkerAgent, taskId, {
      context: { requestId: crypto.randomUUID() }
    });
    return worker.run();
  }
}

export class WorkerAgent extends Agent<Env> {
  async run() {
    const { caller } = getCurrentAgent();
    if (caller?.kind === "agent") {
      console.log(`called by ${caller.className} ${caller.sessionName}`);
      console.log(`request ${caller.context.requestId}`);
    }
  }
}
```

The caller record is untrusted metadata. Use it for correlation, logging, and
tracing, never to decide identity, tenancy, or authorization. Each call also
opens an `agents.rpc.call` span, and the Workers runtime links the callee's
spans to the caller's trace on its own.

Dynamic agents behave the same way: stubs from `dynamicAgents.get()`,
`subAgent()`, `parentAgent()`, and `getSubAgentByName()` all carry the caller,
and a bridged `parentAgent()` call from a nested facet still reports the facet
that called, not the root that relayed it.

The stub `getAgentByName()` returns is a Proxy over the native Durable Object
stub, not a runtime `Fetcher`. It cannot be passed to a runtime API that takes
a stub, such as `evictDurableObject()`, or sent as an RPC argument or return
value. For those cases resolve the raw stub with `getStubByName()`, which has
the same startup guarantee and no caller context:

```typescript
import { getStubByName } from "agents";

const raw = await getStubByName(env.WorkerAgent, taskId);
await other.adopt(raw); // a real stub crosses RPC; caller is undefined inside
```

## When context is lost

The agent context only propagates along the call tree of the original
invocation. Code reached outside that call tree starts with an empty context,
so `getCurrentAgent()` returns an object whose fields are `undefined`. Common
cases include:

- a host callback invoked through RPC from a Worker Loader child isolate, such
  as sandboxed Codemode execution;
- a service binding or Durable Object RPC entrypoint;
- a queue consumer or another entrypoint that retains an agent reference.

Route the callback through a public method on the agent. Custom methods are
wrapped automatically, so calling `agent.someMethod()` re-enters that agent's
context:

```typescript
import { RpcTarget } from "cloudflare:workers";

class HostCallbackBridge extends RpcTarget {
  constructor(private agent: MyMcpAgent) {
    super();
  }

  // Invoked through RPC from a Worker Loader child isolate. There is no context
  // ancestry. Calling a public agent method restores it automatically.
  async invoke() {
    return this.agent.handleSandboxCallback();
  }
}

export class MyMcpAgent extends McpAgent {
  async handleSandboxCallback() {
    const { agent } = getCurrentAgent<MyMcpAgent>();
    // `agent` is available again.
  }
}
```

Context restored this way has `connection`, `request`, and `email` unset. It
is not tied to live client I/O.

Server-initiated MCP requests (`elicitInput`, `createMessage`, and `listRoots`)
on `McpAgent` do not require this indirection because the MCP transport retains
its owning agent.

## API reference

The agents package exports one main function for context management:

### `getCurrentAgent<T>()`

Gets the current agent from any context where it's available.

**Returns:**

```typescript
{
  agent: T | undefined,
  connection: Connection | undefined,
  request: Request | undefined,
  caller: AgentCaller | undefined
}
```

`caller` is set only while handling a method call from a stub returned by
`getAgentByName()` or a dynamic-agent helper. See
[Calls between Agents](#calls-between-agents).

**Usage:**

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { getCurrentAgent } from "agents";

export class MyAgent extends AIChatAgent {
  async customMethod() {
    const { agent, connection, request } = getCurrentAgent<MyAgent>();
    // agent is properly typed as MyAgent
    // connection and request available if called from a request handler
  }
}
```
