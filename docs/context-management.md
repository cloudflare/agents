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
    prompt: `Agent ${agent?.name}: ${prompt}`,
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

## The Technical Details

Behind the scenes, the framework uses `AsyncLocalStorage` to provide context. Here's what happens:

### Automatic Method Wrapping

During agent initialization, the framework:

```typescript
// This happens automatically in the constructor
private _autoWrapCustomMethods() {
  // 1. Identifies all custom methods (non-built-in)
  // 2. Wraps them with agentContext.run()
  // 3. Ensures getCurrentAgent() works in all called functions
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

## Advanced Usage

### Manual Context Control (Optional)

If you need fine-grained control, you can still use the manual approaches:

#### Using the `@withContext()` Decorator

```typescript
import { AIChatAgent, withContext, getCurrentAgent } from "agents";

export class MyAgent extends AIChatAgent {
  @withContext()
  async customMethod() {
    const { agent } = getCurrentAgent<MyAgent>();
    console.log(agent.name);
  }
}
```

#### Using the `withAgentContext()` Function

```typescript
import { AIChatAgent, withAgentContext, getCurrentAgent } from "agents";

export class MyAgent extends AIChatAgent {
  constructor() {
    super();
    // Manual wrapping (usually not needed)
    this.customMethod = withAgentContext(this, this.customMethod.bind(this));
  }

  async customMethod() {
    const { agent } = getCurrentAgent<MyAgent>();
    console.log(agent.name);
  }
}
```

## Why This Design

The automatic approach provides several benefits:

1. **Zero configuration** - Just write methods and they work
2. **No magic decorators** - Clean, simple code
3. **Backward compatible** - Existing code continues to work
4. **Performance optimized** - Only wraps what needs wrapping

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
      },
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

## Migration Guide

### If You Were Using Decorators

```typescript
// Before (still works, but not needed)
export class MyAgent extends AIChatAgent {
  @withContext()
  async customMethod() {
    // ...
  }
}

// After (automatic)
export class MyAgent extends AIChatAgent {
  async customMethod() {
    // Same functionality, no decorator needed
  }
}
```

### If You Were Using Manual Wrapping

```typescript
// Before (still works, but not needed)
export class MyAgent extends AIChatAgent {
  constructor() {
    super();
    this.customMethod = withAgentContext(this, this.customMethod.bind(this));
  }
}

// After (automatic)
export class MyAgent extends AIChatAgent {
  // No constructor needed - happens automatically
  async customMethod() {
    // Same functionality, no manual wrapping needed
  }
}
```

## Troubleshooting

### If getCurrentAgent() Still Returns Undefined

1. **Check if it's a built-in method**: Built-in methods already have context
2. **Verify method naming**: Methods starting with `_` are considered private and not wrapped
3. **Ensure proper inheritance**: Make sure your class extends `AIChatAgent` or `Agent`

### Performance Considerations

The automatic wrapping:

- Only happens once during initialization
- Only wraps methods that aren't already built-in
- Has minimal runtime overhead
- Doesn't affect existing functionality

**Bottom line**: The framework now "just works" - write your methods and they'll have full context automatically!
