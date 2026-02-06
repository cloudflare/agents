# Competitive Analysis: AI SDK (Vercel) vs Think Agent

## Executive Summary

**AI SDK** by Vercel is a TypeScript library for building AI applications. With **v6**, they've introduced a comprehensive **`ToolLoopAgent` class** that directly competes with our Think agent pattern. The AI SDK is **the library we already use** for LLM calls (`generateText`, `streamText`), so this analysis focuses on their agent abstraction layer.

**Source**: [https://ai-sdk.dev/docs/agents](https://ai-sdk.dev/docs/agents/overview)

**Key Insight**: AI SDK is a **library**, not a product. It provides building blocks for agent development but doesn't include persistence, deployment, or UI. Our Think agent builds **on top of** AI SDK, adding Durable Objects for state, WebSocket streaming, and a complete chat UI.

---

## Feature Comparison

| Feature                | AI SDK v6                             | Think Agent                     |
| ---------------------- | ------------------------------------- | ------------------------------- |
| **Nature**             | Library (npm package)                 | Full application (DO + UI)      |
| **Agent Loop**         | `ToolLoopAgent` class                 | Custom loop with `streamText()` |
| **Persistence**        | None (user implements)                | SQLite in Durable Objects       |
| **Subagents**          | Via tool delegation                   | DO Facets (isolated)            |
| **MCP Support**        | ✅ `@ai-sdk/mcp` package              | ✅ Via bindings                 |
| **Streaming**          | ✅ `stream()` + `toUIMessageStream()` | ✅ WebSocket                    |
| **UI Components**      | `useChat` hook                        | Custom React UI                 |
| **Loop Control**       | `stopWhen`, `prepareStep`             | `MAX_TOOL_ROUNDS`               |
| **Context Management** | `prepareStep` callback                | Not yet (Phase 5.7)             |
| **Structured Output**  | ✅ `Output.object()`                  | Via tool schemas                |
| **Multi-Provider**     | ✅ 75+ providers                      | OpenAI/Anthropic                |
| **Workflow Patterns**  | Documented patterns                   | Ad-hoc implementation           |
| **Tool Approval**      | ✅ `needsApproval`                    | Not yet                         |
| **Deployment**         | User responsibility                   | Cloudflare Workers              |

---

## Deep Dive: AI SDK Agent Architecture

### 1. ToolLoopAgent Class

The core abstraction is `ToolLoopAgent`, which encapsulates:

- Model configuration
- System instructions
- Tools
- Loop control (stopping conditions)
- Callbacks

```typescript
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";

const agent = new ToolLoopAgent({
  model: "anthropic/claude-sonnet-4.5",
  instructions: "You are a helpful assistant.",
  tools: {
    weather: tool({
      description: "Get the weather",
      inputSchema: z.object({ location: z.string() }),
      execute: async ({ location }) => ({ temperature: 72 })
    })
  },
  stopWhen: stepCountIs(20) // Default: max 20 steps
});

// Usage
const result = await agent.generate({ prompt: "What is the weather?" });
const stream = await agent.stream({ prompt: "Tell me a story" });
```

**Key Benefits**:

- Reduces boilerplate vs raw `generateText`/`streamText`
- Reusable across application
- Type-safe tool definitions
- Built-in loop management

### 2. Loop Control

AI SDK provides sophisticated loop control via `stopWhen` and `prepareStep`:

**Stop Conditions**:

```typescript
import { stepCountIs, hasToolCall } from "ai";

const agent = new ToolLoopAgent({
  model: "anthropic/claude-sonnet-4.5",
  stopWhen: [
    stepCountIs(20), // Max 20 steps
    hasToolCall("done"), // Stop when 'done' tool called
    customCondition() // Custom logic
  ]
});
```

**Step Preparation** (dynamic configuration):

```typescript
const agent = new ToolLoopAgent({
  model: "openai/gpt-4o-mini", // Default
  prepareStep: async ({ stepNumber, messages, steps }) => {
    // Dynamic model selection
    if (stepNumber > 2 && messages.length > 10) {
      return { model: "anthropic/claude-sonnet-4.5" };
    }

    // Context management
    if (messages.length > 20) {
      return {
        messages: [messages[0], ...messages.slice(-10)]
      };
    }

    // Tool selection by phase
    if (stepNumber <= 2) {
      return { activeTools: ["search"], toolChoice: "required" };
    }

    return {};
  }
});
```

This is **more sophisticated** than our current `MAX_TOOL_ROUNDS = 20` approach.

### 3. Subagent Pattern

AI SDK subagents are implemented as **tool delegations**:

```typescript
// Define a subagent
const researchSubagent = new ToolLoopAgent({
  model: "anthropic/claude-sonnet-4.5",
  instructions: "You are a research agent. Summarize findings.",
  tools: { read: readFileTool, search: searchTool }
});

// Create a tool that delegates to subagent
const researchTool = tool({
  description: "Research a topic in depth.",
  inputSchema: z.object({ task: z.string() }),
  execute: async ({ task }, { abortSignal }) => {
    const result = await researchSubagent.generate({
      prompt: task,
      abortSignal
    });
    return result.text;
  },
  // Control what main agent sees (context summarization!)
  toModelOutput: ({ output: message }) => {
    const lastText = message?.parts.findLast((p) => p.type === "text");
    return { type: "text", value: lastText?.text ?? "Done." };
  }
});
```

**Key features**:

- `toModelOutput` - summarize subagent output for main agent (context management!)
- Streaming via `readUIMessageStream` + preliminary tool results
- Isolated context (fresh window per invocation)
- No tool approvals in subagents

**Comparison with Think**:

| Aspect        | AI SDK Subagents            | Think DO Facets                |
| ------------- | --------------------------- | ------------------------------ |
| Isolation     | Same process, fresh context | Separate DO (fully isolated)   |
| Persistence   | None                        | Own SQLite database            |
| Communication | Return value                | Props + RPC                    |
| Parallelism   | `Promise.all`               | Concurrent DO spawns           |
| Recovery      | Manual                      | Hibernation + scheduled checks |

### 4. Workflow Patterns

AI SDK documents five workflow patterns (from [Anthropic's guide](https://www.anthropic.com/research/building-effective-agents)):

**1. Sequential Processing (Chains)**:

```typescript
// Step 1: Generate copy
const { text: copy } = await generateText({ ... });

// Step 2: Quality check
const { object: metrics } = await generateObject({
  schema: z.object({ clarity: z.number(), ... }),
  prompt: `Evaluate: ${copy}`
});

// Step 3: Conditional improvement
if (metrics.clarity < 7) {
  const { text: improved } = await generateText({ ... });
}
```

**2. Routing** (dynamic model/prompt selection):

```typescript
// Classify query type
const { object: classification } = await generateObject({
  schema: z.object({ type: z.enum(["general", "refund", "technical"]) }),
  prompt: `Classify: ${query}`
});

// Route to appropriate handler
const { text } = await generateText({
  model: classification.complexity === "simple" ? "gpt-4o-mini" : "o4-mini",
  system: systemPrompts[classification.type],
  prompt: query
});
```

**3. Parallel Processing**:

```typescript
const [security, performance, maintainability] = await Promise.all([
  generateObject({ system: 'security expert', ... }),
  generateObject({ system: 'performance expert', ... }),
  generateObject({ system: 'quality expert', ... }),
]);

// Aggregate results
const { text: summary } = await generateText({
  prompt: `Synthesize: ${JSON.stringify(reviews)}`,
});
```

**4. Orchestrator-Worker**:

```typescript
// Orchestrator plans
const { object: plan } = await generateObject({
  schema: z.object({ files: z.array(...) }),
  prompt: `Plan: ${featureRequest}`,
});

// Workers execute
const changes = await Promise.all(
  plan.files.map(file => generateObject({
    system: workerPrompts[file.changeType],
    prompt: `Implement ${file.purpose}`,
  }))
);
```

**5. Evaluator-Optimizer** (iterative refinement):

```typescript
let translation = await generateText({ ... });
let iterations = 0;

while (iterations < MAX_ITERATIONS) {
  const evaluation = await generateObject({
    schema: z.object({ qualityScore: z.number(), issues: z.array(...) }),
    prompt: `Evaluate: ${translation}`,
  });

  if (evaluation.qualityScore >= 8) break;

  translation = await generateText({
    prompt: `Improve based on: ${evaluation.issues}`,
  });
  iterations++;
}
```

### 5. MCP Integration

AI SDK has first-class MCP support via `@ai-sdk/mcp`:

```typescript
import { createMCPClient } from "@ai-sdk/mcp";

const mcpClient = await createMCPClient({
  transport: {
    type: "http",
    url: "https://your-server.com/mcp",
    headers: { Authorization: "Bearer key" },
    authProvider: myOAuthProvider // Built-in OAuth!
  }
});

// Auto-discover tools from server
const tools = await mcpClient.tools();

// Or define schemas for type safety
const tools = await mcpClient.tools({
  schemas: {
    "get-weather": {
      inputSchema: z.object({ location: z.string() }),
      outputSchema: z.object({ temperature: z.number() })
    }
  }
});

// Use with agent
const result = await streamText({
  model: "anthropic/claude-sonnet-4.5",
  tools,
  prompt: "What is the weather?",
  onFinish: async () => await mcpClient.close()
});
```

**Features**:

- HTTP, SSE, and stdio transports
- OAuth provider support
- Schema discovery or explicit definition
- Typed tool outputs
- Resources and prompts (experimental)
- Elicitation requests (server asks client for input)

### 6. UI Integration

AI SDK provides `useChat` hook and stream protocols:

```typescript
// Server: Create UI stream response
import { createAgentUIStreamResponse } from "ai";

export async function POST(request: Request) {
  const { messages } = await request.json();
  return createAgentUIStreamResponse({
    agent: myAgent,
    uiMessages: messages
  });
}

// Client: Use with type safety
import { useChat } from "@ai-sdk/react";
import type { MyAgentUIMessage } from "@/lib/agents";

function Chat() {
  const { messages } = useChat<MyAgentUIMessage>();
  // Full type safety for messages and tool parts
}
```

**Tool part states**:

- `input-streaming` - Tool input being generated
- `input-available` - Ready to execute
- `output-available` - Has output (check `preliminary` flag)
- `output-error` - Execution failed

---

## Key Differentiators

### AI SDK Advantages

1. **`ToolLoopAgent` Class**: Clean abstraction vs manual loop
2. **Loop Control**: `stopWhen` + `prepareStep` for dynamic behavior
3. **`toModelOutput`**: Context summarization for subagent results
4. **MCP Client**: Full OAuth, typed outputs, multiple transports
5. **Workflow Patterns**: Well-documented architectural patterns
6. **Type Safety**: End-to-end types with `InferAgentUIMessage`
7. **Multi-Framework**: React, Svelte, Vue, Next.js, Expo
8. **Telemetry**: Built-in observability

### Think Agent Advantages

1. **Full Application**: Not just a library - includes persistence, UI, deployment
2. **Durable Objects**: Hibernation, scheduled tasks, isolated subagents
3. **Edge Deployment**: Global distribution on Cloudflare
4. **WebSocket-First**: Real-time bidirectional communication
5. **Subagent Isolation**: True isolation via DO Facets (separate storage)
6. **Recovery**: Hibernation recovery, orphan detection
7. **Debug Panel**: Real-time visibility into agent internals
8. **Message Editing**: Fork conversation from any point

---

## Lessons to Learn

### 1. Adopt `ToolLoopAgent` Pattern

Consider wrapping our loop in a similar abstraction:

```typescript
// Current Think approach
async handleChatMessage(content: string) {
  // Manual loop with streamText
  const result = await streamText({
    model: this.model,
    system: this.systemPrompt,
    messages: this.messages,
    tools: this.tools,
  });
  // ... handle result
}

// Could become:
class Think extends Agent {
  private agent = new ToolLoopAgent({
    model: this.resolveModel('primary'),
    instructions: this.buildSystemPrompt(),
    tools: this.buildTools(),
    stopWhen: stepCountIs(20),
    prepareStep: this.handlePrepareStep.bind(this),
  });
}
```

### 2. Implement `prepareStep` for Context Management

Their `prepareStep` pattern solves context compaction elegantly:

```typescript
prepareStep: async ({ messages, stepNumber }) => {
  if (messages.length > 20) {
    // Summarize and truncate
    const summary = await this.summarize(messages.slice(1, -10));
    return {
      messages: [messages[0], summary, ...messages.slice(-10)]
    };
  }
  return {};
};
```

This is cleaner than Phase 5.7's planned `context.ts` module.

### 3. Use `toModelOutput` for Subagent Results

Critical for context management - summarize subagent output:

```typescript
const delegateTask = tool({
  execute: async ({ task }) => {
    // Subagent does 100k tokens of work
    const result = await subagent.generate({ prompt: task });
    return result; // Full message with all tool calls
  },
  // Main agent sees only the summary
  toModelOutput: ({ output }) => ({
    type: "text",
    value: output.parts.findLast((p) => p.type === "text")?.text ?? "Done"
  })
});
```

### 4. Adopt Workflow Patterns

Document and implement standard patterns:

- **Sequential**: Quality check → conditional improvement
- **Parallel**: Multiple reviewers → aggregate
- **Routing**: Classify → route to specialist
- **Evaluator-Optimizer**: Generate → evaluate → improve loop

### 5. Enhance Stop Conditions

Move beyond `MAX_TOOL_ROUNDS` to composable conditions:

```typescript
stopWhen: [
  stepCountIs(20),
  hasToolCall("submitAnswer"),
  budgetExceeded(0.5), // Cost limit
  customCondition(({ steps }) => steps.some((s) => s.text?.includes("DONE")))
];
```

### 6. MCP Client Improvements

Adopt their typed MCP pattern:

```typescript
const tools = await mcpClient.tools({
  schemas: {
    search: {
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ results: z.array(z.string()) })
    }
  }
});
```

---

## Architecture Comparison

| Aspect         | AI SDK                   | Think Agent          |
| -------------- | ------------------------ | -------------------- |
| **Philosophy** | Library primitives       | Complete application |
| **State**      | In-memory (user manages) | Durable Objects      |
| **Subagents**  | Same process             | Isolated DOs         |
| **Streaming**  | Adapters for SSE/WS      | Native WebSocket     |
| **Deployment** | Framework-agnostic       | Cloudflare-specific  |
| **Recovery**   | Manual                   | Built-in hibernation |
| **Tools**      | Zod schemas              | Zod schemas (same)   |

---

## Recommendations

### High Priority

1. **Adopt `ToolLoopAgent` Pattern** - Cleaner abstraction
   - Consider migrating from raw `streamText` loops
   - Leverage their stop conditions and step preparation

2. **Implement `toModelOutput`** - Context summarization
   - Critical for subagent results
   - Prevents context bloat from delegation

3. **Add `prepareStep` Equivalent** - Dynamic loop control
   - Model switching based on complexity
   - Context truncation when needed
   - Tool availability by phase

### Medium Priority

4. **Document Workflow Patterns** - Architectural guidance
   - Sequential, Parallel, Routing, Orchestrator-Worker, Evaluator-Optimizer
   - Code examples for Think agent

5. **Enhance Stop Conditions** - Composable predicates
   - `stepCountIs`, `hasToolCall`, `budgetExceeded`, custom

6. **Type-Safe MCP Tools** - Schema definition
   - Input and output schemas for better DX

### Already Ahead

- **Persistence**: Our DO SQLite beats their "none"
- **Subagent Isolation**: Facets provide true isolation
- **Recovery**: Hibernation + scheduled checks
- **Debug Panel**: Visibility they don't have
- **Message Editing**: Fork from any point

---

## Conclusion

AI SDK v6's `ToolLoopAgent` is a **well-designed abstraction** that we should learn from, but it's a **library**, not a complete solution. Our Think agent builds on top of AI SDK and adds what they don't provide:

1. **Persistence** - Durable Objects with SQLite
2. **Deployment** - Cloudflare edge
3. **UI** - Complete chat interface
4. **Recovery** - Hibernation and orphan detection
5. **Isolation** - True subagent isolation via Facets

The most valuable features to adopt are:

- **Loop control**: `stopWhen` + `prepareStep` patterns
- **`toModelOutput`**: Context summarization for subagents
- **Workflow patterns**: Documented architectural guidance

We're not competing with AI SDK - we're **building on it**. The question is how much of their agent abstraction to adopt vs maintaining our custom loop for Durable Object-specific features.

---

_Analysis date: February 2026_
