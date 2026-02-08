### 💻 `@cloudflare/codemode` - Code Mode: The Better Way to Use MCP

Instead of asking LLMs to call tools directly, Code Mode lets them write executable code that orchestrates multiple operations. **LLMs are better at writing code than calling tools** - they've seen millions of lines of real-world TypeScript but only contrived tool-calling examples.

Code Mode converts your tools (especially MCP servers) into TypeScript APIs, enabling complex workflows, error handling, and multi-step operations that are natural in code but difficult with traditional tool calling.

Built on Cloudflare's Worker Loader API, Code Mode executes generated code in secure, isolated sandboxes with millisecond startup times.

> **⚠️ Experimental Feature**: Code Mode is currently experimental and may have breaking changes in future releases. Use with caution in production environments.

---

### 🌱 Installation

```sh
npm install @cloudflare/codemode agents ai
```

### 📝 Your First Code Mode Agent

Transform your tool-calling agent into a code-generating one:

#### Before (Traditional Tool Calling)

```ts
import { streamText } from "ai";
import { tool } from "ai";
import { z } from "zod";

const result = streamText({
  model: openai("gpt-4o"),
  messages,
  tools: {
    getWeather: tool({
      description: "Get weather for a location",
      inputSchema: z.object({ location: z.string() }),
      execute: async ({ location }) => {
        return `Weather in ${location}: 72°F, sunny`;
      }
    }),
    sendEmail: tool({
      description: "Send an email",
      inputSchema: z.object({
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

#### After (With Code Mode)

```ts
import { experimental_codemode as codemode } from "@cloudflare/codemode/ai";
import { streamText } from "ai";
import { tool } from "ai";
import { z } from "zod";

// Define your tools as usual
const tools = {
  getWeather: tool({
    description: "Get weather for a location",
    inputSchema: z.object({ location: z.string() }),
    execute: async ({ location }) => {
      return `Weather in ${location}: 72°F, sunny`;
    }
  }),
  sendEmail: tool({
    description: "Send an email",
    inputSchema: z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string()
    }),
    execute: async ({ to, subject, body }) => {
      // Send email logic
      return `Email sent to ${to}`;
    }
  })
};

// Configure Code Mode
const { prompt, tools: wrappedTools } = await codemode({
  model: openai("gpt-4o"), // optional, defaults to openai("gpt-4.1")
  prompt: "You are a helpful assistant...",
  tools,
  globalOutbound: env.globalOutbound,
  loader: env.LOADER,
  proxy: this.ctx.exports.CodeModeProxy({
    props: {
      binding: "MyAgent",
      name: this.name,
      callback: "callTool"
    }
  })
});

// Use the wrapped tools - now the LLM will generate code instead!
const result = streamText({
  model: openai("gpt-4o"),
  system: prompt,
  messages,
  tools: wrappedTools // Single "codemode" tool that generates code
});
```

That's it! Your agent now generates executable code that orchestrates your tools.

### 🏰 Configuration

Define the required bindings in your `wrangler.toml`:

```jsonc
{
  "compatibility_flags": ["experimental", "enable_ctx_exports"],
  "worker_loaders": [
    {
      "binding": "LOADER"
    }
  ],
  "services": [
    {
      "binding": "globalOutbound",
      "service": "your-service",
      "entrypoint": "globalOutbound"
    },
    {
      "binding": "CodeModeProxy",
      "service": "your-service",
      "entrypoint": "CodeModeProxy"
    }
  ]
}
```

### 🎭 Agent Integration

#### With MCP Servers

```ts
import { Agent } from "agents";
import { experimental_codemode as codemode } from "@cloudflare/codemode/ai";
import { streamText, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";

export class CodeModeAgent extends Agent<Env> {
  async onChatMessage() {
    const allTools = {
      ...regularTools,
      ...this.mcp.getAITools() // Include MCP tools
    };

    const { prompt, tools: wrappedTools } = await codemode({
      model: openai("gpt-4o"), // optional, defaults to openai("gpt-4.1")
      prompt: "You are a helpful assistant...",
      tools: allTools,
      globalOutbound: env.globalOutbound,
      loader: env.LOADER,
      proxy: this.ctx.exports.CodeModeProxy({
        props: {
          binding: "CodeModeAgent",
          name: this.name,
          callback: "callTool"
        }
      })
    });

    const result = streamText({
      model: openai("gpt-4o"),
      system: prompt,
      messages: await convertToModelMessages(this.messages),
      tools: wrappedTools
    });

    return result.toUIMessageStreamResponse();
  }

  callTool(functionName: string, args: unknown[]) {
    return this.tools[functionName]?.execute?.(args, {
      abortSignal: new AbortController().signal,
      toolCallId: "codemode",
      messages: []
    });
  }
}

export { CodeModeProxy } from "@cloudflare/codemode/ai";
```

### 🌊 Generated Code Example

Code Mode enables complex workflows that chain multiple operations:

```javascript
// Example generated code orchestrating multiple MCP servers:
async function executeTask() {
  const files = await codemode.listFiles({ path: "/projects" });
  const recentProject = files
    .filter((f) => f.type === "directory")
    .sort((a, b) => new Date(b.modified) - new Date(a.modified))[0];

  const projectStatus = await codemode.queryDatabase({
    query: "SELECT * FROM projects WHERE name = ?",
    params: [recentProject.name]
  });

  if (projectStatus.length === 0 || projectStatus[0].status === "incomplete") {
    await codemode.createTask({
      title: `Review project: ${recentProject.name}`,
      priority: "high"
    });
    await codemode.sendEmail({
      to: "team@company.com",
      subject: "Project Review Needed"
    });
  }

  return { success: true, project: recentProject };
}
```

### 🔒 Security

Code runs in isolated Workers with millisecond startup times. No network access by default - only through explicit bindings. API keys are hidden in bindings, preventing leaks.

```ts
export const globalOutbound = {
  fetch: async (input: string | URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.hostname === "example.com") {
      return new Response("Not allowed", { status: 403 });
    }
    return fetch(input, init);
  }
};
```

### 🔧 Setup

**Required bindings:**

- `LOADER`: Worker Loader for code execution
- `globalOutbound`: Service for network access control
- `CodeModeProxy`: Service for tool execution proxy

**Environment:**

```ts
export const globalOutbound = {
  fetch: async (input: string | URL | RequestInfo, init?: RequestInit) => {
    // Your security policies
    return fetch(input, init);
  }
};

export { CodeModeProxy } from "@cloudflare/codemode/ai";
```

**Proxy configuration:**

```ts
proxy: this.ctx.exports.CodeModeProxy({
  props: {
    binding: "YourAgentClass",
    name: this.name,
    callback: "callTool"
  }
});
```

### 🎯 Real-World Examples

Explore these examples to see Code Mode in action:

- **Complete Demo**: [`examples/codemode/`](../../examples/codemode/) - Full working example with MCP integration
- **Documentation**: [`docs/codemode.md`](../../docs/codemode.md) - Detailed guide and examples
- **Blog Post**: [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) - Deep dive into the philosophy and implementation

### 📚 API Reference

#### `experimental_codemode(options)`

Wraps your tools with Code Mode, converting them into a single code-generating tool.

**Options:**

- `tools: ToolSet` - Your tool definitions (including MCP tools)
- `prompt: string` - System prompt for the LLM
- `globalOutbound: Fetcher` - Service binding for network access control
- `loader: WorkerLoader` - Worker Loader binding for code execution
- `proxy: Fetcher<CodeModeProxy>` - Proxy binding for tool execution
- `model?: LanguageModel` - The language model to use for code generation (optional, defaults to `openai("gpt-4.1")`)

**Returns:**

- `prompt: string` - Enhanced system prompt
- `tools: ToolSet` - Wrapped tools (single "codemode" tool)

#### `CodeModeProxy`

Worker entrypoint that routes tool calls back to your agent.

**Props:**

- `binding: string` - Your agent class name
- `name: string` - Agent instance name
- `callback: string` - Method name to call for tool execution

### 🔗 Integration

`@cloudflare/codemode` integrates with the [`agents`](../agents/) framework and works with any agent that extends `Agent`, including MCP server integration via `Agent.mcp`.

### 🚀 Limitations

- **Experimental**: Subject to breaking changes
- **Requires Cloudflare Workers**: Uses Worker Loader API (beta)
- **JavaScript Only**: Python support planned

### Contributing

Contributions are welcome! Please:

1. Open an issue to discuss your proposal
2. Ensure your changes align with the package's goals
3. Include tests for new features
4. Update documentation as needed

### License

MIT licensed. See the LICENSE file at the root of this repository for details.
