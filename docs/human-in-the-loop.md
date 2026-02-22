# Human in the Loop

Human-in-the-loop (HITL) patterns allow agents to pause execution and wait for human approval, confirmation, or input before proceeding. This is essential for compliance, safety, and oversight in agentic systems.

## Overview

### Why Human in the Loop?

- **Compliance**: Regulatory requirements may mandate human approval for certain actions
- **Safety**: High-stakes operations (payments, deletions, external communications) need oversight
- **Quality**: Human review catches errors AI might miss
- **Trust**: Users feel more confident when they can approve critical actions

### Common Use Cases

| Use Case            | Example                                  |
| ------------------- | ---------------------------------------- |
| Financial approvals | Expense reports, payment processing      |
| Content moderation  | Publishing, email sending                |
| Data operations     | Bulk deletions, exports                  |
| AI tool execution   | Confirming LLM tool calls before running |
| Access control      | Granting permissions, role changes       |

## Choosing an Approach

Agents SDK supports multiple human-in-the-loop patterns. Choose based on your use case:

| Use Case               | Pattern           | Best For                                           | Example                                                           |
| ---------------------- | ----------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Long-running workflows | Workflow Approval | Multi-step processes, durable approval gates       | [examples/workflows/](../examples/workflows/)                     |
| AIChatAgent tools      | `needsApproval`   | Chat-based tool calls with `@cloudflare/ai-chat`   | [guides/human-in-the-loop/](../guides/human-in-the-loop/)         |
| OpenAI Agents SDK      | `needsApproval`   | Using OpenAI's agent SDK with conditional approval | [openai-sdk/human-in-the-loop/](../openai-sdk/human-in-the-loop/) |
| Client-side tools      | `onToolCall`      | Tools that need browser APIs or user interaction   | Pattern below                                                     |
| MCP Servers            | Elicitation       | MCP tools requesting structured user input         | [examples/mcp-elicitation/](../examples/mcp-elicitation/)         |

### Decision Guide

```
Is this part of a multi-step workflow?
├── Yes → Use Workflow Approval (waitForApproval)
└── No → Are you building an MCP server?
         ├── Yes → Use MCP Elicitation (elicitInput)
         └── No → Is this an AI chat interaction?
                  ├── Yes → Does the tool need browser APIs?
                  │        ├── Yes → Use onToolCall (client-side execution)
                  │        └── No → Use needsApproval (server-side with approval)
                  └── No → Use State + WebSocket for simple confirmations
```

## Workflow-Based Approval

For durable, multi-step processes, use Cloudflare Workflows with the `waitForApproval()` helper. The workflow pauses until a human approves or rejects.

### Basic Pattern

```typescript
import { Agent, AgentWorkflow, callable } from "agents";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents";

// Workflow that pauses for approval
export class ExpenseWorkflow extends AgentWorkflow<
  ExpenseAgent,
  ExpenseParams
> {
  async run(event: AgentWorkflowEvent<ExpenseParams>, step: AgentWorkflowStep) {
    const expense = event.payload;

    // Step 1: Validate the expense
    const validated = await step.do("validate", async () => {
      return validateExpense(expense);
    });

    // Step 2: Wait for manager approval
    await this.reportProgress({
      step: "approval",
      status: "pending",
      message: `Awaiting approval for $${expense.amount}`
    });

    // This pauses the workflow until approved/rejected
    const approval = await this.waitForApproval<{ approvedBy: string }>(step, {
      timeout: "7 days"
    });

    console.log(`Approved by: ${approval.approvedBy}`);

    // Step 3: Process the approved expense
    const result = await step.do("process", async () => {
      return processExpense(validated);
    });

    await step.reportComplete(result);
    return result;
  }
}
```

### Agent Methods for Approval

The agent provides methods to approve or reject waiting workflows:

```typescript
export class ExpenseAgent extends Agent<Env, ExpenseState> {
  initialState: ExpenseState = {
    pendingApprovals: [],
    status: "idle"
  };

  // Approve a waiting workflow
  @callable()
  async approve(workflowId: string, approvedBy: string): Promise<void> {
    await this.approveWorkflow(workflowId, {
      reason: "Expense approved",
      metadata: { approvedBy, approvedAt: Date.now() }
    });

    // Update state to reflect approval
    this.setState({
      ...this.state,
      pendingApprovals: this.state.pendingApprovals.filter(
        (p) => p.workflowId !== workflowId
      )
    });
  }

  // Reject a waiting workflow
  @callable()
  async reject(workflowId: string, reason: string): Promise<void> {
    await this.rejectWorkflow(workflowId, { reason });

    this.setState({
      ...this.state,
      pendingApprovals: this.state.pendingApprovals.filter(
        (p) => p.workflowId !== workflowId
      )
    });
  }

  // Track workflow progress
  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ): Promise<void> {
    const p = progress as { step: string; status: string };

    if (p.step === "approval" && p.status === "pending") {
      // Add to pending approvals list
      this.setState({
        ...this.state,
        pendingApprovals: [
          ...this.state.pendingApprovals,
          { workflowId, requestedAt: Date.now() }
        ]
      });
    }
  }
}
```

### Timeout Handling

Set timeouts to prevent workflows from waiting indefinitely:

```typescript
const approval = await this.waitForApproval(step, {
  timeout: "7 days" // or "1 hour", "30 minutes", etc.
});
```

If the timeout expires, the workflow continues without approval data. Handle this case:

```typescript
const approval = await this.waitForApproval<{ approvedBy: string }>(step, {
  timeout: "24 hours"
});

if (!approval) {
  // Timeout expired - escalate or auto-reject
  await step.reportError("Approval timeout - escalating to manager");
  throw new Error("Approval timeout");
}
```

For more details, see [Workflows Integration](./workflows.md).

## AI Tool Approval with `needsApproval`

When building AI chat agents, you often want humans to approve certain tool calls before execution. The AI SDK's `needsApproval` option pauses tool execution until the user approves or rejects.

### Server

Define tools with `needsApproval` to require human confirmation:

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, tool, convertToModelMessages } from "ai";
import { z } from "zod";

export class MyAgent extends AIChatAgent {
  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      messages: await convertToModelMessages(this.messages),
      tools: {
        // Tool with conditional approval
        processPayment: tool({
          description: "Process a payment",
          inputSchema: z.object({
            amount: z.number(),
            recipient: z.string()
          }),
          // Approval required for amounts over $100
          needsApproval: async ({ amount }) => amount > 100,
          execute: async ({ amount, recipient }) => {
            return await chargeCard(amount, recipient);
          }
        }),

        // Tool that always requires approval
        deleteAccount: tool({
          description: "Delete a user account",
          inputSchema: z.object({ userId: z.string() }),
          needsApproval: true,
          execute: async ({ userId }) => {
            return await deleteUser(userId);
          }
        }),

        // Tool that executes automatically (no approval)
        getWeather: tool({
          description: "Get weather for a city",
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => fetchWeather(city)
        })
      },
      maxSteps: 5
    });

    return result.toUIMessageStreamResponse();
  }
}
```

### Client

Handle approval requests with `addToolApprovalResponse`:

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";

function Chat() {
  const agent = useAgent({ agent: "MyAgent" });
  const { messages, sendMessage, addToolApprovalResponse } = useAgentChat({
    agent
  });

  return (
    <div>
      {messages.map((message) => (
        <div key={message.id}>
          {message.parts?.map((part, i) => {
            if (part.type === "text") {
              return <p key={i}>{part.text}</p>;
            }

            if (isToolUIPart(part)) {
              // Tool waiting for approval
              if ("approval" in part && part.state === "approval-requested") {
                const approvalId = part.approval?.id;
                return (
                  <div key={part.toolCallId} className="approval-card">
                    <p>
                      Approve <strong>{getToolName(part)}</strong> with{" "}
                      {JSON.stringify(part.input)}?
                    </p>
                    <button
                      onClick={() =>
                        addToolApprovalResponse({
                          id: approvalId,
                          approved: true
                        })
                      }
                    >
                      Approve
                    </button>
                    <button
                      onClick={() =>
                        addToolApprovalResponse({
                          id: approvalId,
                          approved: false
                        })
                      }
                    >
                      Reject
                    </button>
                  </div>
                );
              }

              // Tool was denied
              if (part.state === "output-denied") {
                return (
                  <div key={part.toolCallId}>{getToolName(part)}: Denied</div>
                );
              }

              // Tool completed
              if (part.state === "output-available") {
                return (
                  <div key={part.toolCallId}>
                    {getToolName(part)}: {JSON.stringify(part.output)}
                  </div>
                );
              }
            }

            return null;
          })}
        </div>
      ))}
    </div>
  );
}
```

### Custom denial messages with `addToolOutput`

When a user rejects a tool, `addToolApprovalResponse({ id, approved: false })` sets the tool state to `output-denied` with a generic "Tool execution denied." message. If you need to give the LLM a more specific reason for the denial, use `addToolOutput` with `state: "output-error"` instead:

```tsx
const { addToolOutput } = useAgentChat({ agent });

// Reject with a custom error message
addToolOutput({
  toolCallId: part.toolCallId,
  state: "output-error",
  errorText: "User declined: insufficient budget for this quarter"
});
```

This sends a `tool_result` to the LLM with your custom error text, so it can respond appropriately (e.g. suggest an alternative, ask clarifying questions). The `addToolOutput` function also works for tools in `approval-requested` or `approval-responded` states, not just `input-available`.

`addToolApprovalResponse` (with `approved: false`) auto-continues the conversation when `autoContinueAfterToolResult` is enabled (the default), so the LLM sees the denial and can respond naturally.

`addToolOutput` with `state: "output-error"` does **not** auto-continue — it gives you full control over what happens next. If you want the LLM to respond to the error, call `sendMessage()` afterward.

See the complete example: [guides/human-in-the-loop/](../guides/human-in-the-loop/)

## Client-Side Tool Execution with `onToolCall`

For tools that need browser APIs (geolocation, camera, clipboard) or user interaction, define the tool on the server without an `execute` function and handle it on the client with `onToolCall`:

### Server

```typescript
export class MyAgent extends AIChatAgent {
  async onChatMessage() {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      messages: await convertToModelMessages(this.messages),
      tools: {
        // No execute function - client handles via onToolCall
        getUserLocation: tool({
          description: "Get the user's current location from their browser",
          inputSchema: z.object({})
        })
      },
      maxSteps: 3
    });

    return result.toUIMessageStreamResponse();
  }
}
```

### Client

```tsx
const { messages, sendMessage } = useAgentChat({
  agent,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    if (toolCall.toolName === "getUserLocation") {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject);
      });
      addToolOutput({
        toolCallId: toolCall.toolCallId,
        output: {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        }
      });
    }
  }
});
```

The server receives the tool output via `CF_AGENT_TOOL_RESULT` and can auto-continue the conversation (with `maxSteps > 1`), letting the LLM respond to the location data in the same turn.

### OpenAI Agents SDK Pattern

When using the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/), use the `needsApproval` function for conditional approval:

```typescript
import { Agent } from "agents";
import { tool, run } from "@openai/agents";

export class WeatherAgent extends Agent<Env, AgentState> {
  async processQuery(query: string) {
    const weatherTool = tool({
      name: "get_weather",
      description: "Get weather for a location",
      parameters: z.object({ location: z.string() }),

      // Conditional approval - only for certain locations
      needsApproval: async (_context, { location }) => {
        return location === "San Francisco"; // Require approval for SF
      },

      execute: async ({ location }) => {
        const conditions = ["sunny", "cloudy", "rainy"];
        return conditions[Math.floor(Math.random() * conditions.length)];
      }
    });

    const result = await run(this.openai, {
      model: "gpt-4o",
      tools: [weatherTool],
      input: query
    });

    return result;
  }
}
```

See the complete example: [openai-sdk/human-in-the-loop/](../openai-sdk/human-in-the-loop/)

### MCP Elicitation

When building MCP servers with `McpAgent`, you can request additional user input during tool execution using **elicitation**. The MCP client (like Claude Desktop) renders a form based on your JSON Schema and returns the user's response.

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Agent } from "agents";

export class MyMcpAgent extends Agent<Env, State> {
  server = new McpServer({
    name: "my-mcp-server",
    version: "1.0.0"
  });

  onStart() {
    this.server.registerTool(
      "increase-counter",
      {
        description: "Increase the counter by a user-specified amount",
        inputSchema: {
          confirm: z.boolean().describe("Do you want to increase the counter?")
        }
      },
      async ({ confirm }, extra) => {
        if (!confirm) {
          return { content: [{ type: "text", text: "Cancelled." }] };
        }

        // Request additional input from the user
        const userInput = await this.server.server.elicitInput(
          {
            message: "By how much do you want to increase the counter?",
            requestedSchema: {
              type: "object",
              properties: {
                amount: {
                  type: "number",
                  title: "Amount",
                  description: "The amount to increase the counter by"
                }
              },
              required: ["amount"]
            }
          },
          { relatedRequestId: extra.requestId }
        );

        // Check if user accepted or cancelled
        if (userInput.action !== "accept" || !userInput.content) {
          return { content: [{ type: "text", text: "Cancelled." }] };
        }

        // Use the input
        const amount = Number(userInput.content.amount);
        this.setState({
          ...this.state,
          counter: this.state.counter + amount
        });

        return {
          content: [
            {
              type: "text",
              text: `Counter increased by ${amount}, now at ${this.state.counter}`
            }
          ]
        };
      }
    );
  }
}
```

**Key differences from other patterns:**

- Used by **MCP servers** exposing tools to clients, not agents calling tools
- Uses **JSON Schema** for structured form-based input
- The **MCP client** (Claude Desktop, etc.) handles UI rendering
- Returns `{ action: "accept" | "decline", content: {...} }`

See the complete example: [examples/mcp-elicitation/](../examples/mcp-elicitation/)

## State Patterns for Approvals

Track pending approvals in agent state for UI rendering and persistence:

```typescript
type PendingApproval = {
  id: string;
  workflowId?: string;
  type: "expense" | "publish" | "delete";
  description: string;
  amount?: number;
  requestedBy: string;
  requestedAt: number;
  expiresAt?: number;
};

type ApprovalRecord = {
  id: string;
  approvalId: string;
  decision: "approved" | "rejected";
  decidedBy: string;
  decidedAt: number;
  reason?: string;
};

type ApprovalState = {
  pending: PendingApproval[];
  history: ApprovalRecord[];
};
```

### Multi-Approver Patterns

For sensitive operations requiring multiple approvers:

```typescript
type MultiApproval = {
  id: string;
  requiredApprovals: number;  // e.g., 2
  currentApprovals: Array<{
    userId: string;
    approvedAt: number;
  }>;
  rejections: Array<{
    userId: string;
    rejectedAt: number;
    reason: string;
  }>;
};

@callable()
async approveMulti(approvalId: string, userId: string): Promise<boolean> {
  const approval = this.state.pending.find(p => p.id === approvalId);
  if (!approval) throw new Error("Approval not found");

  // Add this user's approval
  approval.currentApprovals.push({ userId, approvedAt: Date.now() });

  // Check if we have enough approvals
  if (approval.currentApprovals.length >= approval.requiredApprovals) {
    // Execute the approved action
    await this.executeApprovedAction(approval);
    return true;
  }

  this.setState({ ...this.state });
  return false; // Still waiting for more approvals
}
```

## Timeouts and Escalation

### Setting Approval Timeouts

```typescript
const approval = await this.waitForApproval(step, {
  timeout: "24 hours"
});
```

### Escalation with Scheduling

Use `schedule()` to set up escalation reminders:

```typescript
@callable()
async submitForApproval(request: ApprovalRequest): Promise<string> {
  const approvalId = crypto.randomUUID();

  // Add to pending
  this.setState({
    ...this.state,
    pending: [...this.state.pending, { id: approvalId, ...request }]
  });

  // Schedule reminder after 4 hours
  await this.schedule(
    Date.now() + 4 * 60 * 60 * 1000,
    "sendReminder",
    { approvalId }
  );

  // Schedule escalation after 24 hours
  await this.schedule(
    Date.now() + 24 * 60 * 60 * 1000,
    "escalateApproval",
    { approvalId }
  );

  return approvalId;
}
```

## Complete Examples

| Pattern           | Location                                                          | Description                                        |
| ----------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| Workflow approval | [examples/workflows/](../examples/workflows/)                     | Multi-step task processing with approval gate      |
| AIChatAgent tools | [guides/human-in-the-loop/](../guides/human-in-the-loop/)         | Chat tool approval with needsApproval + onToolCall |
| OpenAI Agents SDK | [openai-sdk/human-in-the-loop/](../openai-sdk/human-in-the-loop/) | Conditional tool approval with modal               |
| MCP Elicitation   | [examples/mcp-elicitation/](../examples/mcp-elicitation/)         | MCP server requesting structured user input        |

For detailed API documentation, see:

- [Workflows](./workflows.md) - `waitForApproval()`, `approveWorkflow()`, `rejectWorkflow()`
- [MCP Servers](./mcp-servers.md) - `elicitInput()` for MCP elicitation
- [Callable Methods](./callable-methods.md) - `@callable()` decorator for approval endpoints
