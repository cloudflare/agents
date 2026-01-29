---
"agents": patch
---

feat: Add Cloudflare Workflows integration for Agents

Adds seamless integration between Cloudflare Agents and Cloudflare Workflows for durable, multi-step background processing.

### Why use Workflows with Agents?

Agents excel at real-time communication and state management, while Workflows excel at durable execution. Together:

- Agents handle WebSocket connections and quick operations
- Workflows handle long-running tasks, retries, and human-in-the-loop flows

### AgentWorkflow Base Class

Extend `AgentWorkflow` instead of `WorkflowEntrypoint` to get typed access to the originating Agent:

```typescript
export class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(event: AgentWorkflowEvent<TaskParams>, step: AgentWorkflowStep) {
    const params = event.payload;

    // Call Agent methods via RPC
    await this.agent.updateStatus(params.taskId, "processing");

    // Non-durable: progress reporting (lightweight, for frequent updates)
    await this.reportProgress({
      step: "process",
      percent: 0.5,
      message: "Halfway done"
    });
    this.broadcastToClients({ type: "update", taskId: params.taskId });

    // Durable via step: idempotent, won't repeat on retry
    await step.mergeAgentState({ taskProgress: 0.5 });
    await step.reportComplete(result);

    return result;
  }
}
```

### Agent Methods

- `runWorkflow(workflowName, params, options?)` - Start workflow with optional metadata for querying
- `sendWorkflowEvent(workflowName, workflowId, event)` - Send events to waiting workflows
- `getWorkflow(workflowId)` - Get tracked workflow by ID
- `getWorkflows(criteria?)` - Query by status, workflowName, or metadata
- `deleteWorkflow(workflowId)` - Delete a workflow tracking record
- `deleteWorkflows(criteria?)` - Delete workflows by criteria (status, workflowName, metadata, createdBefore)
- `approveWorkflow(workflowId, data?)` - Approve a waiting workflow
- `rejectWorkflow(workflowId, data?)` - Reject a waiting workflow

### AgentWorkflow Methods

**On `this` (non-durable, lightweight):**

- `reportProgress(progress)` - Report typed progress object to Agent
- `broadcastToClients(message)` - Broadcast to WebSocket clients
- `waitForApproval(step, opts?)` - Wait for approval (throws on rejection)

**On `step` (durable, idempotent):**

- `step.reportComplete(result?)` - Report successful completion
- `step.reportError(error)` - Report an error
- `step.sendEvent(event)` - Send custom event to Agent
- `step.updateAgentState(state)` - Replace Agent state (broadcasts to clients)
- `step.mergeAgentState(partial)` - Merge into Agent state (broadcasts to clients)
- `step.resetAgentState()` - Reset Agent state to initialState (broadcasts to clients)

### Lifecycle Callbacks

Override these methods to handle workflow events (workflowName is first for easy differentiation):

```typescript
async onWorkflowProgress(workflowName, workflowId, progress) {} // progress is typed object
async onWorkflowComplete(workflowName, workflowId, result?) {}
async onWorkflowError(workflowName, workflowId, error) {}
async onWorkflowEvent(workflowName, workflowId, event) {}
```

### Workflow Tracking

Workflows are automatically tracked in `cf_agents_workflows` SQLite table:

- Status, timestamps, errors
- Optional `metadata` field for queryable key-value data
- Params/output NOT stored by default (could be large)

See `docs/workflows.md` for full documentation.
