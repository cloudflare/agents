# Codemode (Experimental)

Codemode is an experimental pattern of using LLMs to generate executable code that performs tool calls, inspired by [CodeAct](https://machinelearning.apple.com/research/codeact). Instead of directly calling predefined tools, the LLM generates Python/JavaScript code that orchestrates multiple tool calls and complex logic.

> **⚠️ Experimental Feature**: Codemode is currently experimental and may have breaking changes in future releases. Use with caution in production environments.

## Why Codemode with MCP Servers?

Codemode is particularly powerful when working with **MCP (Model Context Protocol) servers**. MCP servers provide rich, stateful interfaces to external systems, but traditional tool calling can be limiting when you need to:

- **Chain multiple MCP operations** in complex workflows
- **Handle stateful interactions** that require multiple round-trips
- **Implement error handling and retry logic** across MCP calls
- **Compose different MCP servers** in novel ways
- **Perform conditional logic** based on MCP server responses

Rather than being limited to predefined tool schemas, codemode enables agents to:

- Generate dynamic code that combines multiple MCP server calls
- Perform complex logic and control flow across MCP operations
- Self-debug and revise their approach when MCP calls fail
- Compose MCP servers in novel ways not anticipated by developers
- Handle stateful MCP interactions that require multiple steps

Our implementation brings this concept to AI SDK applications with a simple abstraction, making it especially valuable for MCP server integration.

## How It Works

1. **Tool Detection**: When the LLM needs to use tools, instead of calling them directly, it generates a `codemode` tool call
2. **Code Generation**: The system generates executable JavaScript code that uses your tools
3. **Safe Execution**: Code runs in an isolated worker environment with controlled access to your tools
4. **Result Return**: The executed code's result is returned to the user

## Demo Application

You can find a working demo of codemode in the `examples/codemode/` directory. The demo includes:

- A complete implementation showing codemode in action
- Interactive examples of tool composition
- Real-time code generation and execution

<img width="1481" height="810" alt="image" src="https://github.com/user-attachments/assets/36656642-1b0f-46d9-868b-f13c6e127b5e" />

To run the demo:

1. Install dependencies in the root (`npm install`)
2. Build dependencies in the root (`npm run build`)
3. Navigate to `examples/codemode/`
4. Create a `.env` file with your OpenAI API key (see `.env.example`)
5. Run `npm start` to start the development server
6. Visit `http://localhost:5173` to see the demo

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
import { experimental_codemode as codemode } from "@cloudflare/codemode/ai";

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

export { CodeModeProxy } from "@cloudflare/codemode/ai";

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
export { CodeModeProxy } from "@cloudflare/codemode/ai";
```

## Benefits for MCP Server Integration

- **MCP Server Orchestration**: Seamlessly chain operations across multiple MCP servers
- **Stateful Workflows**: Handle complex stateful interactions that require multiple MCP round-trips
- **Error Recovery**: Implement sophisticated retry logic and error handling for MCP server failures
- **Dynamic Composition**: Combine different MCP servers in ways not anticipated by their individual designs
- **Conditional Logic**: Generate different code paths based on MCP server responses and system state
- **Cross-Server Data Flow**: Transform and pass data between different MCP servers in complex pipelines

## Example: MCP Server Workflow

Instead of being limited to single MCP server calls, codemode enables complex workflows across multiple MCP servers:

```javascript
// Generated code might look like:
async function executeTask() {
  // Connect to file system MCP server
  const files = await codemode.listFiles({ path: "/projects" });

  // Find the most recent project
  const recentProject = files
    .filter((f) => f.type === "directory")
    .sort((a, b) => new Date(b.modified) - new Date(a.modified))[0];

  // Connect to database MCP server to check project status
  const projectStatus = await codemode.queryDatabase({
    query: "SELECT * FROM projects WHERE name = ?",
    params: [recentProject.name]
  });

  // If project needs attention, create a task in task management MCP server
  if (projectStatus.length === 0 || projectStatus[0].status === "incomplete") {
    await codemode.createTask({
      title: `Review project: ${recentProject.name}`,
      description: `Project at ${recentProject.path} needs attention`,
      priority: "high"
    });

    // Send notification via email MCP server
    await codemode.sendEmail({
      to: "team@company.com",
      subject: "Project Review Needed",
      body: `Project ${recentProject.name} requires review and status update.`
    });
  }

  return {
    success: true,
    project: recentProject,
    taskCreated:
      projectStatus.length === 0 || projectStatus[0].status === "incomplete"
  };
}
```

## Security Considerations

- Code runs in isolated worker environments
- Access to tools is controlled through the proxy
- Global outbound requests can be filtered and rate-limited

## Current Limitations

- **Experimental**: This feature is experimental and subject to breaking changes
- Requires Cloudflare Workers environment
- Limited to JavaScript execution (Python support planned)
- MCP server state updates need refinement
- Prompt engineering for optimal code generation
