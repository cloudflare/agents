# Codemode

Codemode is a pattern of using LLMs to generate executable code that performs tool calls, inspired by [CodeAct](https://machinelearning.apple.com/research/codeact). Instead of directly calling predefined tools, the LLM generates Python/JavaScript code that orchestrates multiple tool calls and complex logic.

Rather than being limited to predefined tool schemas, agents can:

- Generate dynamic code that combines multiple tools
- Perform complex logic and control flow
- Self-debug and revise their approach
- Compose tools in novel ways not anticipated by developers

Our implementation brings this concept to AI SDK applications with a simple abstraction.

## How It Works

1. **Tool Detection**: When the LLM needs to use tools, instead of calling them directly, it generates a `codemode` tool call
2. **Code Generation**: The system generates executable JavaScript code that uses your tools
3. **Safe Execution**: Code runs in an isolated worker environment with controlled access to your tools
4. **Result Return**: The executed code's result is returned to the user

## Usage

### Before (Traditional Tool Calling)

```typescript
const result = streamText({
  model,
  messages,
  tools: {
    getWeather: tool({
      description: "Get weather for a location",
      parameters: z.object({ location: z.string() }),
      execute: async ({ location }) => {
        return `Weather in ${location}: 72°F, sunny`;
      }
    }),
    sendEmail: tool({
      description: "Send an email",
      parameters: z.object({
        to: z.string(),
        subject: z.string(),
        body: z.string()
      }),
      execute: async ({ to, subject, body }) => {
        // Send email logic
        return `Email sent to ${to}`;
      }
    })
  }
});
```

### After (With Codemode)

```typescript
import { experimental_codemode as codemode } from "agents/codemode/ai";

// Define your tools as usual
const tools = {
  getWeather: tool({
    /* ... */
  }),
  sendEmail: tool({
    /* ... */
  })
};

// Configure codemode bindings
export const globalOutbound = {
  fetch: async (input, init) => {
    // Your custom fetch logic
    return fetch(input, init);
  }
};

export { CodeModeProxy } from "agents/codemode/ai";

// Use codemode wrapper
const { prompt, tools: wrappedTools } = await codemode({
  prompt: "You are a helpful assistant...",
  tools,
  globalOutbound: env.globalOutbound,
  loader: env.LOADER,
  proxy: this.ctx.exports.CodeModeProxy({
    props: {
      binding: "Codemode", // the class name of your agent
      name: this.name,
      callback: "callTool"
    }
  })
});

const result = streamText({
  model,
  messages,
  tools: wrappedTools, // Now uses codemode tool
  system: prompt
});
```

## Configuration

### Required Bindings

You need to define these bindings in your `wrangler.toml`:

```toml
[[bindings]]
name = "LOADER"
type = "worker-loader"

[[bindings]]
name = "globalOutbound"
type = "service"
service = "your-outbound-service"
```

### Environment Setup

```typescript
// Define your (optional) global outbound fetch handler
export const globalOutbound = {
  fetch: async (input: string | URL | RequestInfo, init?: RequestInit) => {
    // Add security policies, rate limiting, etc.
    const url = new URL(typeof input === "string" ? input : input.toString());

    // Block certain domains
    if (url.hostname === "example.com") {
      return new Response("Not allowed", { status: 403 });
    }

    return fetch(input, init);
  }
};

// Export the proxy for tool execution
export { CodeModeProxy } from "agents/codemode/ai";
```

## Benefits

- **Flexibility**: Agents can compose tools in ways you didn't anticipate
- **Complex Logic**: Support for loops, conditionals, and multi-step workflows
- **Self-Debugging**: Agents can catch errors and retry with different approaches
- **Tool Composition**: Combine multiple tools in novel ways
- **Dynamic Behavior**: Generate different code paths based on runtime conditions

## Example: Complex Workflow

Instead of being limited to single tool calls, codemode enables complex workflows:

```javascript
// Generated code might look like:
async function executeTask() {
  // Get user's location
  const location = await codemode.getUserLocation();

  // Get weather for that location
  const weather = await codemode.getWeather({ location });

  // If it's raining, send umbrella reminder
  if (weather.condition === "rainy") {
    await codemode.sendEmail({
      to: "user@example.com",
      subject: "Umbrella Reminder",
      body: `It's raining in ${location}! Don't forget your umbrella.`
    });
  }

  // Schedule a follow-up check
  await codemode.scheduleTask({
    task: "check_weather_again",
    delay: "1 hour"
  });

  return {
    success: true,
    weather,
    reminderSent: weather.condition === "rainy"
  };
}
```

## Security Considerations

- Code runs in isolated worker environments
- Access to tools is controlled through the proxy
- Global outbound requests can be filtered and rate-limited

## Current Limitations

- Requires Cloudflare Workers environment
- Limited to JavaScript execution (Python support planned)
- MCP server state updates need refinement
- Prompt engineering for optimal code generation
