## Human in the Loop with Cloudflare Agents

[Work in Progress, ignore for now]

This example demonstrates how to implement human-in-the-loop functionality using Cloudflare Agents, allowing AI agents to request human approval before executing certain actions. This pattern is crucial for scenarios where human oversight and confirmation are required before taking important actions.

### Overview

The implementation showcases:

- AI agents that can request human approval for specific actions
- Real-time communication between agents and humans using WebSocket connections
- Persistent state management across agent lifecycles
- Tool-based architecture for extensible agent capabilities

### Key Components

1. **Agent Definition**

```ts
import { Agent } from "@cloudflare/agents";

export class HumanInTheLoopAgent extends Agent {
  // Tool registry with approval requirements
  tools = {
    getWeatherInformation: {
      description: "Show the weather in a given city to the user",
      requiresApproval: true,
      parameters: { city: "string" },
    },
    getLocalTime: {
      description: "Get the local time for a specified location",
      requiresApproval: false,
      parameters: { location: "string" },
    },
  };

  async onMessage(connection, message) {
    // Handle incoming messages and tool calls
    if (message.type === "tool-call") {
      const tool = this.tools[message.toolName];

      if (tool.requiresApproval) {
        // Request human approval
        await this.requestApproval(connection, message);
      } else {
        // Execute tool directly
        await this.executeTool(message);
      }
    }
  }

  async requestApproval(connection, toolCall) {
    // Update state to reflect pending approval
    this.setState({
      ...this.state,
      pendingApprovals: [
        ...(this.state.pendingApprovals || []),
        { toolCall, connection },
      ],
    });
  }
}
```

2. **React Client Integration**

```tsx
import { useAgent } from "@cloudflare/agents/react";

function Chat() {
  const agent = useAgent({
    agent: "human-in-the-loop-agent",
    onStateUpdate: (state) => {
      // Handle state updates, including pending approvals
      setPendingApprovals(state.pendingApprovals);
    },
  });

  // Render chat interface with approval UI
  return (
    <div>
      {/* Chat messages */}
      {pendingApprovals.map((approval) => (
        <ApprovalRequest
          key={approval.id}
          approval={approval}
          onApprove={() => agent.send({ type: "approve", id: approval.id })}
          onReject={() => agent.send({ type: "reject", id: approval.id })}
        />
      ))}
    </div>
  );
}
```

### Features

- **Persistent State**: Agent state persists across sessions using Cloudflare's durable storage
- **Real-time Updates**: WebSocket connections ensure immediate updates for approval requests
- **Tool Registry**: Flexible tool system with configurable approval requirements
- **Type Safety**: Full TypeScript support for tool definitions and parameters

### Getting Started

1. Configure your `wrangler.toml`:

```toml
[[durable_objects]]
binding = "HumanInTheLoopAgent"
class_name = "HumanInTheLoopAgent"
```

2. Deploy your agent:

```bash
wrangler deploy
```

3. Connect from your frontend using the React hooks provided by `@cloudflare/agents/react`

### Best Practices

- Define clear approval workflows for sensitive operations
- Implement timeouts for approval requests
- Provide detailed context in approval requests
- Handle connection drops and reconnections gracefully
- Log all approval decisions for audit trails

### Learn More

- [Cloudflare Agents Documentation](https://developers.cloudflare.com/agents/)
- [Building AI Agents with Human Oversight](https://developers.cloudflare.com/agents/patterns/human-in-the-loop/)
- [State Management in Cloudflare Agents](https://developers.cloudflare.com/agents/state-management/)
