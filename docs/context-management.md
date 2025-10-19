# Context Management

## Automatic Context for Custom Methods

**All custom methods automatically have full agent context!** The framework automatically detects and wraps your custom methods during initialization, ensuring `getCurrentAgent()` works seamlessly everywhere.

## How It Works

```typescript
import { AIChatAgent, getCurrentAgent } from "agents";

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
import { AIChatAgent, getCurrentAgent } from "agents";
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

- **Built-in methods** (onRequest, onEmail, onStateUpdate): Already have context
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

## Troubleshooting Context Issues

### Common Causes of `getCurrentAgent()` Returning `undefined`

1. **Async Context Loss**: `AsyncLocalStorage` context doesn't automatically propagate across:
   - `setTimeout` or `setInterval` callbacks
   - Promise continuations outside the original context
   - Background tasks or scheduled jobs
   - Event handlers that aren't wrapped with context

2. **OAuth Callback Processing**: Fixed in recent versions, but ensure your agent handles OAuth callbacks properly.

3. **Custom Method Wrapping Issues**: The framework automatically wraps custom methods, but if you're calling methods directly without going through the agent instance, context may be lost.

### Best Practices for Context Management

#### Always Check for Context Availability

```typescript
import { getCurrentAgent } from "agents";

async function externalFunction() {
  const context = getCurrentAgent<MyAgent>();

  if (!context.agent) {
    console.warn("No agent context available - this function should be called from within an agent method");
    return null;
  }

  // Safe to use context.agent, context.connection, context.request
  return context.agent.state;
}
```

#### Preserve Context in Async Operations

```typescript
export class MyAgent extends AIChatAgent {
  async customMethod() {
    // ✅ Good: Context is preserved in Promise continuations
    return this.processAsync().then(result => {
      const { agent } = getCurrentAgent<MyAgent>();
      return { agent: agent?.name, result };
    });
  }

  async problematicMethod() {
    // ❌ Bad: Context is lost in setTimeout
    setTimeout(() => {
      const { agent } = getCurrentAgent<MyAgent>(); // Will be undefined
      console.log(agent?.name);
    }, 1000);
  }

  async betterAsyncMethod() {
    // ✅ Good: Preserve context explicitly
    const context = getCurrentAgent<MyAgent>();

    setTimeout(() => {
      // Manually restore context if needed
      console.log("Agent name:", context.agent?.name);
    }, 1000);
  }
}
```

#### Handle Context in External Libraries

```typescript
// In your external library/utility
export async function processWithContext<T>(
  operation: () => Promise<T>
): Promise<T> {
  const context = getCurrentAgent();

  if (!context.agent) {
    // Fallback behavior when no context is available
    return operation();
  }

  // Execute with context available for debugging/logging
  return operation();
}
```

## API Reference

The agents package exports one main function for context management:

### `getCurrentAgent<T>()`

Gets the current agent from any context where it's available.

**Returns:**

```typescript
{
  agent: T | undefined,
  connection: Connection | undefined,
  request: Request | undefined,
  email: AgentEmail | undefined
}
```

**Usage:**

```typescript
import { getCurrentAgent } from "agents";

export class MyAgent extends AIChatAgent {
  async customMethod() {
    const { agent, connection, request, email } = getCurrentAgent<MyAgent>();

    if (!agent) {
      throw new Error("This method must be called within agent context");
    }

    // agent is properly typed as MyAgent
    // connection and request available if called from a request handler
    // email available if called from an email handler
  }
}
```

**Defensive Usage:**

```typescript
async function safeExternalFunction() {
  const context = getCurrentAgent<MyAgent>();

  if (!context.agent) {
    console.error("Agent context not available");
    return null;
  }

  return context.agent.state;
}
```
