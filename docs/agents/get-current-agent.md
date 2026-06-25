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
  request: Request | undefined
}
```

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
