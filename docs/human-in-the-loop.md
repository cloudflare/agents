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

| Use Case               | Pattern           | Best For                                               | Example                                                           |
| ---------------------- | ----------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| Long-running workflows | Workflow Approval | Multi-step processes, durable approval gates           | [examples/workflows/](../examples/workflows/)                     |
| AIChatAgent tools      | Tool Confirmation | Chat-based tool calls with `@cloudflare/ai-chat`       | [guides/human-in-the-loop/](../guides/human-in-the-loop/)         |
| OpenAI Agents SDK      | `needsApproval`   | Using OpenAI's agent SDK with conditional approval     | [openai-sdk/human-in-the-loop/](../openai-sdk/human-in-the-loop/) |
| AI SDK (Vercel)        | No-execute tools  | Tools without execute function require client approval | Pattern below                                                     |
| MCP Servers            | Elicitation       | MCP tools requesting structured user input             | [examples/mcp-elicitation/](../examples/mcp-elicitation/)         |

### Decision Guide

```
Is this part of a multi-step workflow?
├─ Yes → Use Workflow Approval (waitForApproval)
└─ No → Are you building an MCP server?
         ├─ Yes → Use MCP Elicitation (elicitInput)
         └─ No → Is this an AI chat interaction?
                  ├─ Yes → Which SDK?
                  │        ├─ @cloudflare/ai-chat → Tool Confirmation (requiresApproval)
                  │        ├─ OpenAI Agents SDK → needsApproval function
                  │        └─ Vercel AI SDK → No-execute tools pattern
                  └─ No → Use State + WebSocket for simple confirmations
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

## AI Tool Approval Patterns

When building AI chat agents, you often want humans to approve certain tool calls before execution.

### AIChatAgent Pattern (`@cloudflare/ai-chat`)

Tools can require confirmation before execution:

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";

export class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish: StreamTextOnFinishCallback) {
    return createDataStreamResponse({
      execute: async (dataStream) => {
        const processedMessages = await processToolCalls({
          messages: this.messages,
          dataStream,
          tools: {
            getWeatherInformation: {
              requiresApproval: true,
              execute: async ({ city }) => {
                return `The weather in ${city} is sunny.`;
              }
            },
            getCurrentTime: {
              // No requiresApproval = executes immediately
              execute: async () => new Date().toISOString()
            }
          }
        });

        streamText({
          model: openai("gpt-4o"),
          messages: processedMessages,
          onFinish
        }).mergeIntoDataStream(dataStream);
      }
    });
  }
}
```

**Client-side approval:**

```tsx
import { useAgent, useAgentChat } from "agents/react";

function Chat() {
  const agent = useAgent({ agent: "my-agent" });
  const { messages, addToolResult } = useAgentChat({ agent });

  return (
    <div>
      {messages.map((message) => (
        <div key={message.id}>
          {message.parts?.map((part, i) => {
            // Check for tool calls awaiting approval
            if (
              part.type === "tool-invocation" &&
              part.state === "input-available"
            ) {
              return (
                <div key={i} className="approval-card">
                  <p>
                    Approve {part.tool} for {JSON.stringify(part.args)}?
                  </p>
                  <button onClick={() => addToolResult(part.id, "approve")}>
                    Yes
                  </button>
                  <button onClick={() => addToolResult(part.id, "reject")}>
                    No
                  </button>
                </div>
              );
            }
            // Render other parts...
          })}
        </div>
      ))}
    </div>
  );
}
```

See the complete example: [guides/human-in-the-loop/](../guides/human-in-the-loop/)

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

**Handling interruptions on the client:**

```tsx
function WeatherChat() {
  const { state, agent } = useAgent({ agent: "weather-agent" });

  // Check for pending approval
  if (state?.currentStep?.type === "next_step_interruption") {
    const interruption = state.currentStep.data?.interruptions[0];

    return (
      <div className="approval-modal">
        <h3>Approval Required</h3>
        <p>Tool: {interruption.toolName}</p>
        <p>Args: {JSON.stringify(interruption.args)}</p>
        <button onClick={() => agent.stub.approve()}>Approve</button>
        <button onClick={() => agent.stub.reject()}>Reject</button>
      </div>
    );
  }

  // Normal chat UI...
}
```

See the complete example: [openai-sdk/human-in-the-loop/](../openai-sdk/human-in-the-loop/)

### AI SDK Pattern (Vercel)

When using the [Vercel AI SDK](https://ai-sdk.dev), tools without an `execute` function require client-side confirmation. Here's the pattern adapted for React + Cloudflare Worker:

**Server (Worker):**

```typescript
import { tool, streamText, convertToModelMessages } from "ai";
import { z } from "zod";

// Tool WITHOUT execute = requires confirmation
const weatherTool = tool({
  description: "Get weather for a city",
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.string()
  // No execute function - client must provide result
});

export class ChatAgent extends Agent<Env> {
  @callable()
  async chat(messages: Message[]) {
    // Check if last message has tool approval
    const lastMessage = messages[messages.length - 1];
    const processedMessages = await this.processToolApprovals(messages);

    const result = streamText({
      model: openai("gpt-4o"),
      messages: convertToModelMessages(processedMessages),
      tools: { getWeather: weatherTool }
    });

    return result;
  }

  private async processToolApprovals(messages: Message[]) {
    // Find tool calls with user-provided results
    // Execute approved tools, reject denied ones
    // Return updated messages
  }
}
```

**Client (React):**

```tsx
const APPROVAL = {
  YES: "Yes, confirmed.",
  NO: "No, denied."
};

function Chat() {
  const { messages, sendMessage, addToolOutput } = useAgentChat({
    agent: "chat-agent"
  });

  return (
    <div>
      {messages.map((message) => (
        <div key={message.id}>
          {message.parts?.map((part, i) => {
            // Check for tool calls awaiting input
            if (
              part.type === "tool-invocation" &&
              part.state === "input-available" &&
              part.tool === "getWeather"
            ) {
              return (
                <div key={i}>
                  <p>Get weather for {part.input.city}?</p>
                  <button
                    onClick={async () => {
                      await addToolOutput({
                        toolCallId: part.toolCallId,
                        tool: "getWeather",
                        output: APPROVAL.YES
                      });
                      sendMessage();
                    }}
                  >
                    Yes
                  </button>
                  <button
                    onClick={async () => {
                      await addToolOutput({
                        toolCallId: part.toolCallId,
                        tool: "getWeather",
                        output: APPROVAL.NO
                      });
                      sendMessage();
                    }}
                  >
                    No
                  </button>
                </div>
              );
            }
            // Render other parts...
          })}
        </div>
      ))}
    </div>
  );
}
```

For the full pattern, see the [AI SDK Human-in-the-Loop cookbook](https://ai-sdk.dev/cookbook/next/human-in-the-loop).

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

## Building Approval UIs

### Pending Approvals List

```tsx
import { useAgent } from "agents/react";

function PendingApprovals() {
  const { state, agent } = useAgent<ApprovalState>({
    agent: "approval-agent",
    name: "main"
  });

  if (!state?.pending?.length) {
    return <p>No pending approvals</p>;
  }

  return (
    <div className="approval-list">
      {state.pending.map((item) => (
        <div key={item.id} className="approval-card">
          <h3>{item.type}</h3>
          <p>{item.description}</p>
          {item.amount && <p className="amount">${item.amount}</p>}
          <p className="meta">
            Requested by {item.requestedBy} at{" "}
            {new Date(item.requestedAt).toLocaleString()}
          </p>

          <div className="actions">
            <button
              className="approve"
              onClick={() => agent.stub.approve(item.id)}
            >
              Approve
            </button>
            <button
              className="reject"
              onClick={() => agent.stub.reject(item.id, "Declined")}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
```

### Approval Modal for Tool Calls

```tsx
function ApprovalModal({
  toolName,
  args,
  onApprove,
  onReject
}: {
  toolName: string;
  args: Record<string, unknown>;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>Approval Required</h2>
        <p>The AI wants to execute:</p>

        <div className="tool-details">
          <strong>{toolName}</strong>
          <pre>{JSON.stringify(args, null, 2)}</pre>
        </div>

        <div className="modal-actions">
          <button className="approve" onClick={onApprove}>
            Approve
          </button>
          <button className="reject" onClick={onReject}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
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

async sendReminder(payload: { approvalId: string }) {
  const approval = this.state.pending.find(p => p.id === payload.approvalId);
  if (approval) {
    // Send reminder notification
    await this.notify(approval.requestedBy, "Approval still pending");
  }
}

async escalateApproval(payload: { approvalId: string }) {
  const approval = this.state.pending.find(p => p.id === payload.approvalId);
  if (approval) {
    // Escalate to manager
    await this.notify("manager@company.com", `Escalated: ${approval.description}`);
  }
}
```

## Audit and Compliance

### Recording Approval Decisions

Use `this.sql` to maintain an immutable audit trail:

```typescript
@callable()
async approve(approvalId: string, userId: string, reason?: string): Promise<void> {
  // Record the decision in SQL (immutable audit log)
  this.sql`
    INSERT INTO approval_audit (
      approval_id,
      decision,
      decided_by,
      decided_at,
      reason
    ) VALUES (
      ${approvalId},
      'approved',
      ${userId},
      ${Date.now()},
      ${reason || null}
    )
  `;

  // Process the approval...
  await this.processApproval(approvalId);

  // Update state
  this.setState({
    ...this.state,
    pending: this.state.pending.filter(p => p.id !== approvalId),
    history: [
      ...this.state.history,
      {
        id: crypto.randomUUID(),
        approvalId,
        decision: "approved",
        decidedBy: userId,
        decidedAt: Date.now(),
        reason
      }
    ]
  });
}
```

### Audit Table Schema

```sql
CREATE TABLE IF NOT EXISTS approval_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
  decided_by TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  reason TEXT,
  metadata TEXT
);

CREATE INDEX idx_approval_audit_approval_id ON approval_audit(approval_id);
CREATE INDEX idx_approval_audit_decided_by ON approval_audit(decided_by);
```

## Complete Examples

| Pattern           | Location                                                          | Description                                   |
| ----------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| Workflow approval | [examples/workflows/](../examples/workflows/)                     | Multi-step task processing with approval gate |
| AIChatAgent tools | [guides/human-in-the-loop/](../guides/human-in-the-loop/)         | Chat tool confirmation with React UI          |
| OpenAI Agents SDK | [openai-sdk/human-in-the-loop/](../openai-sdk/human-in-the-loop/) | Conditional tool approval with modal          |
| MCP Elicitation   | [examples/mcp-elicitation/](../examples/mcp-elicitation/)         | MCP server requesting structured user input   |

For detailed API documentation, see:

- [Workflows](./workflows.md) - `waitForApproval()`, `approveWorkflow()`, `rejectWorkflow()`
- [MCP Servers](./mcp-servers.md) - `elicitInput()` for MCP elicitation
- [Callable Methods](./callable-methods.md) - `@callable()` decorator for approval endpoints
