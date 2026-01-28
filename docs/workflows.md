# Workflows Integration

Integrate [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) with Agents for durable, multi-step background processing while Agents handle real-time communication.

## Introduction

### What are Cloudflare Workflows?

Cloudflare Workflows provide durable, multi-step execution that survives failures, retries automatically, and can pause to wait for external events. They're ideal for:

- Long-running background tasks (data processing, report generation)
- Multi-step pipelines with retry logic
- Human-in-the-loop approval flows
- Tasks that shouldn't block user requests

### Why Integrate with Agents?

Agents excel at real-time communication and state management, while Workflows excel at durable execution. Together they provide:

| Feature                | Agent   | Workflow | Combined         |
| ---------------------- | ------- | -------- | ---------------- |
| Real-time WebSocket    | ✓       | ✗        | Agent handles    |
| Long-running tasks     | Limited | ✓        | Workflow handles |
| State persistence      | ✓       | ✓        | Both             |
| Automatic retries      | ✗       | ✓        | Workflow handles |
| External event waiting | ✗       | ✓        | Workflow handles |

### When to Use What

| Use Case                      | Recommendation                 |
| ----------------------------- | ------------------------------ |
| Chat/messaging                | Agent only                     |
| Quick API calls               | Agent only                     |
| Background processing (< 30s) | Agent `queue()`                |
| Long-running tasks (> 30s)    | Agent + Workflow               |
| Multi-step pipelines          | Workflow                       |
| Human approval flows          | Agent + Workflow               |
| Scheduled tasks               | Agent `schedule()` or Workflow |

## Quick Start

### 1. Define Your Workflow

Create a Workflow that extends `AgentWorkflow` to get typed access to the originating Agent:

```typescript
// src/workflows/processing.ts
import { AgentWorkflow } from "agents";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents";
import type { MyAgent } from "../agent";

type TaskParams = {
  taskId: string;
  data: string;
};

export class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(event: AgentWorkflowEvent<TaskParams>, step: AgentWorkflowStep) {
    const params = event.payload;

    // Step 1: Process data
    const result = await step.do("process-data", async () => {
      // Durable step - will retry on failure
      return processData(params.data);
    });

    // Report progress to Agent (non-durable, lightweight)
    await this.reportProgress({
      step: "process",
      status: "complete",
      percent: 0.5
    });

    // Step 2: Save results
    await step.do("save-results", async () => {
      // Call Agent method via RPC
      await this.agent.saveResult(params.taskId, result);
    });

    // Broadcast to connected clients (non-durable)
    this.broadcastToClients({
      type: "task-complete",
      taskId: params.taskId
    });

    // Report completion (durable via step)
    await step.reportComplete(result);

    return result;
  }
}
```

### 2. Start Workflow from Agent

Use `runWorkflow()` to start a workflow with automatic tracking:

```typescript
// src/agent.ts
import { Agent } from "agents";

export class MyAgent extends Agent {
  async startTask(taskId: string, data: string) {
    // Start workflow - automatically tracked in Agent's database
    const workflowId = await this.runWorkflow("PROCESSING_WORKFLOW", {
      taskId,
      data
    });

    return { workflowId };
  }

  // Called when workflow reports progress (progress is typed object)
  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ) {
    // Cast to your progress type
    const p = progress as { step?: string; status?: string; percent?: number };
    console.log(
      `Workflow ${workflowName}/${workflowId}: ${p.step} - ${p.status} (${(p.percent ?? 0) * 100}%)`
    );

    // Broadcast to connected clients
    this.broadcast(
      JSON.stringify({
        type: "workflow-progress",
        workflowName,
        workflowId,
        progress
      })
    );
  }

  // Called when workflow completes
  async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown
  ) {
    console.log(`Workflow ${workflowName}/${workflowId} completed:`, result);
  }

  // Method called by workflow via RPC
  async saveResult(taskId: string, result: unknown) {
    this
      .sql`INSERT INTO results (task_id, data) VALUES (${taskId}, ${JSON.stringify(result)})`;
  }
}
```

### 3. Configure Wrangler

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "main": "src/index.ts",
  "compatibility_date": "2025-02-11",
  "durable_objects": {
    "bindings": [{ "name": "MY_AGENT", "class_name": "MyAgent" }]
  },
  "workflows": [
    {
      "name": "processing-workflow",
      "binding": "PROCESSING_WORKFLOW",
      "class_name": "ProcessingWorkflow"
    }
  ],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyAgent"] }]
}
```

## API Reference

### `AgentWorkflow<AgentType, Params, ProgressType, Env>`

Base class for Workflows that integrate with Agents.

**Type Parameters:**

- `AgentType` - The Agent class type (for typed RPC)
- `Params` - User params passed to the workflow (optional)
- `ProgressType` - Type for progress reporting (defaults to `DefaultProgress`)
- `Env` - Environment type (defaults to `Cloudflare.Env`)

**Properties:**

- `agent` - Typed stub for calling Agent methods via RPC
- `workflowId` - The workflow instance ID
- `workflowName` - The workflow binding name
- `env` - Environment bindings

**Methods on `this` (non-durable, may repeat on retry):**

| Method                         | Description                                   |
| ------------------------------ | --------------------------------------------- |
| `reportProgress(progress)`     | Report typed progress object to the Agent     |
| `broadcastToClients(message)`  | Broadcast message to all WebSocket clients    |
| `waitForApproval(step, opts?)` | Wait for approval event (throws on rejection) |

**Methods on `step` (durable, idempotent, won't repeat on retry):**

| Method                          | Description                                    |
| ------------------------------- | ---------------------------------------------- |
| `step.reportComplete(result?)`  | Report successful completion                   |
| `step.reportError(error)`       | Report an error                                |
| `step.sendEvent(event)`         | Send a custom event to the Agent               |
| `step.updateAgentState(state)`  | Replace Agent state (broadcasts to clients)    |
| `step.mergeAgentState(partial)` | Merge into Agent state (broadcasts to clients) |
| `step.resetAgentState()`        | Reset Agent state to initialState              |

**DefaultProgress Type:**

```typescript
type DefaultProgress = {
  step?: string;
  status?: "pending" | "running" | "complete" | "error";
  message?: string;
  percent?: number;
  [key: string]: unknown; // extensible
};
```

### Agent Workflow Methods

Methods added to the `Agent` class:

#### `runWorkflow(workflowName, params, options?)`

Start a workflow and track it in the Agent's database.

```typescript
const workflowId = await this.runWorkflow(
  "MY_WORKFLOW",
  { taskId: "123", data: "process this" },
  {
    id: "custom-id", // optional - auto-generated if not provided
    metadata: { userId: "user-456", priority: "high" }, // optional - for querying
    agentBinding: "MyAgent" // optional - auto-detected from class name if not provided
  }
);
```

**Parameters:**

- `workflowName` - Workflow binding name from `env`
- `params` - Params to pass to the workflow
- `options.id` - Custom workflow ID (auto-generated if not provided)
- `options.metadata` - Optional metadata stored for querying (not passed to workflow)
- `options.agentBinding` - Agent binding name (auto-detected from class name if not provided)

**Returns:** Workflow instance ID

#### `sendWorkflowEvent(workflowName, workflowId, event)`

Send an event to a running workflow.

```typescript
await this.sendWorkflowEvent("MY_WORKFLOW", workflowId, {
  type: "approval",
  payload: { approved: true }
});
```

#### `getWorkflowStatus(workflowName, workflowId)`

Get the status of a workflow and update tracking record.

```typescript
const status = await this.getWorkflowStatus("MY_WORKFLOW", workflowId);
// status: { status: 'running', output: null, error: null }
```

#### `getWorkflow(workflowId)`

Get a tracked workflow by ID.

```typescript
const workflow = this.getWorkflow(workflowId);
// { workflowId, workflowName, status, metadata, error, createdAt, ... }
```

#### `getWorkflows(criteria?)`

Query tracked workflows.

```typescript
// Get all running workflows
const running = this.getWorkflows({ status: "running" });

// Get workflows by binding name
const processing = this.getWorkflows({ workflowName: "PROCESSING_WORKFLOW" });

// Filter by metadata
const userWorkflows = this.getWorkflows({
  metadata: { userId: "user-456" }
});

// Get recent completed workflows
const recent = this.getWorkflows({
  status: ["complete", "errored"],
  limit: 10,
  orderBy: "desc"
});
```

#### `deleteWorkflow(workflowId)`

Delete a single workflow tracking record.

```typescript
const deleted = this.deleteWorkflow(workflowId);
// true if deleted, false if not found
```

#### `deleteWorkflows(criteria?)`

Delete workflow tracking records matching criteria. Useful for cleanup.

```typescript
// Delete all completed workflows older than 7 days
const count = this.deleteWorkflows({
  status: "complete",
  createdBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
});

// Delete all errored and terminated workflows
const count = this.deleteWorkflows({
  status: ["errored", "terminated"]
});
```

### Lifecycle Callbacks

Override these methods in your Agent to handle workflow events:

```typescript
class MyAgent extends Agent {
  // Called when workflow reports progress (progress is typed object)
  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ) {
    // Cast to your progress type
    const p = progress as { step?: string; percent?: number };
  }

  // Called when workflow completes successfully
  async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown
  ) {}

  // Called when workflow encounters an error
  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string
  ) {}

  // Called when workflow sends a custom event
  async onWorkflowEvent(
    workflowName: string,
    workflowId: string,
    event: unknown
  ) {}

  // Handle all callbacks in one place (alternative)
  async onWorkflowCallback(callback: WorkflowCallback) {
    // Called for all callback types - callback includes workflowName
  }
}
```

### Approval Methods

Convenience methods for human-in-the-loop approval flows:

```typescript
class MyAgent extends Agent {
  // Approve a waiting workflow
  async handleApproval(workflowId: string, userId: string) {
    await this.approveWorkflow(workflowId, {
      reason: "Approved by admin",
      metadata: { approvedBy: userId }
    });
  }

  // Reject a waiting workflow
  async handleRejection(workflowId: string, reason: string) {
    await this.rejectWorkflow(workflowId, { reason });
  }
}
```

## Workflow Tracking

Workflows started with `runWorkflow()` are automatically tracked in the Agent's SQLite database.

### `cf_agents_workflows` Table

| Column          | Type    | Description                     |
| --------------- | ------- | ------------------------------- |
| `id`            | TEXT    | Internal row ID                 |
| `workflow_id`   | TEXT    | Cloudflare workflow instance ID |
| `workflow_name` | TEXT    | Workflow binding name           |
| `status`        | TEXT    | Current status                  |
| `metadata`      | TEXT    | JSON metadata (for querying)    |
| `error_name`    | TEXT    | Error name (if failed)          |
| `error_message` | TEXT    | Error message (if failed)       |
| `created_at`    | INTEGER | Unix timestamp                  |
| `updated_at`    | INTEGER | Unix timestamp                  |
| `completed_at`  | INTEGER | Unix timestamp (when done)      |

Note: Workflow params and output are not stored by default. Use `metadata` to store queryable information, and store large payloads in your own tables if needed.

### Workflow Status Values

- `queued` - Waiting to start
- `running` - Currently executing
- `paused` - Paused by user
- `waiting` - Waiting for event
- `complete` - Finished successfully
- `errored` - Failed with error
- `terminated` - Manually terminated

## Patterns

### Background Processing with Progress

```typescript
// Workflow with default progress type
export class DataProcessingWorkflow extends AgentWorkflow<
  MyAgent,
  ProcessParams
> {
  async run(event: AgentWorkflowEvent<ProcessParams>, step: AgentWorkflowStep) {
    const params = event.payload;
    const items = params.items;

    for (let i = 0; i < items.length; i++) {
      await step.do(`process-${i}`, async () => {
        await processItem(items[i]);
      });

      // Report progress after each item (non-durable, lightweight)
      await this.reportProgress({
        step: `process-${i}`,
        status: "complete",
        percent: (i + 1) / items.length,
        message: `Processed ${i + 1}/${items.length}`
      });
    }

    await step.reportComplete({ processed: items.length });
  }
}

// Agent
class MyAgent extends Agent {
  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ) {
    // Broadcast progress to all connected clients
    this.broadcast(
      JSON.stringify({
        type: "processing-progress",
        workflowName,
        workflowId,
        progress
      })
    );
  }
}
```

### Human-in-the-Loop Approval

```typescript
// Workflow using the built-in waitForApproval helper
export class ApprovalWorkflow extends AgentWorkflow<MyAgent, RequestParams> {
  async run(event: AgentWorkflowEvent<RequestParams>, step: AgentWorkflowStep) {
    const params = event.payload;

    // Prepare request
    const request = await step.do("prepare", async () => {
      return { ...params, preparedAt: Date.now() };
    });

    // Wait for approval (throws WorkflowRejectedError if rejected)
    await this.reportProgress({
      step: "approval",
      status: "pending",
      percent: 0.5,
      message: "Awaiting approval"
    });
    const approvalData = await this.waitForApproval<{ approvedBy: string }>(
      step,
      { timeout: "7 days" }
    );

    console.log("Approved by:", approvalData?.approvedBy);

    // Execute approved action
    const result = await step.do("execute", async () => {
      return executeRequest(request);
    });

    await step.reportComplete(result);
    return result;
  }
}

// Agent using the built-in approval methods
class MyAgent extends Agent {
  // Approve a waiting workflow
  async handleApproval(workflowId: string, userId: string) {
    await this.approveWorkflow(workflowId, {
      reason: "Approved by admin",
      metadata: { approvedBy: userId }
    });
  }

  // Reject a waiting workflow
  async handleRejection(workflowId: string, reason: string) {
    await this.rejectWorkflow(workflowId, { reason });
  }
}
```

### Durable Task Queue with Retries

```typescript
// Workflow with built-in retry logic
export class ResilientTaskWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(event: AgentWorkflowEvent<TaskParams>, step: AgentWorkflowStep) {
    const params = event.payload;

    const result = await step.do(
      "call-external-api",
      {
        retries: {
          limit: 5,
          delay: "10 seconds",
          backoff: "exponential"
        },
        timeout: "5 minutes"
      },
      async () => {
        const response = await fetch("https://api.example.com/process", {
          method: "POST",
          body: JSON.stringify(params)
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        return response.json();
      }
    );

    await step.reportComplete(result);
    return result;
  }
}
```

### State Synchronization

Workflows can update the Agent's state directly (durably via step), which automatically broadcasts to all connected clients:

```typescript
// Workflow that syncs state to Agent
export class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(event: AgentWorkflowEvent<TaskParams>, step: AgentWorkflowStep) {
    const params = event.payload;

    // Update Agent state (durable, replaces entire state, broadcasts to clients)
    await step.updateAgentState({
      currentTask: {
        id: params.taskId,
        status: "processing",
        startedAt: Date.now()
      }
    });

    const result = await step.do("process", async () => {
      return processTask(params);
    });

    // Merge partial state (durable, keeps existing fields, broadcasts to clients)
    await step.mergeAgentState({
      currentTask: {
        status: "complete",
        result,
        completedAt: Date.now()
      }
    });

    await step.reportComplete(result);
    return result;
  }
}
```

### Custom Progress Types

Define custom progress types for domain-specific reporting:

```typescript
// Custom progress type for data pipeline
type PipelineProgress = {
  stage: "extract" | "transform" | "load";
  recordsProcessed: number;
  totalRecords: number;
  currentTable?: string;
};

// Workflow with custom progress type (3rd type parameter)
export class ETLWorkflow extends AgentWorkflow<
  MyAgent,
  ETLParams,
  PipelineProgress
> {
  async run(event: AgentWorkflowEvent<ETLParams>, step: AgentWorkflowStep) {
    const params = event.payload;

    // Report typed progress (non-durable, lightweight for frequent updates)
    await this.reportProgress({
      stage: "extract",
      recordsProcessed: 0,
      totalRecords: 1000,
      currentTable: "users"
    });

    // ... processing
  }
}

// Agent receives typed progress
class MyAgent extends Agent {
  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ) {
    const p = progress as PipelineProgress;
    console.log(`Stage: ${p.stage}, ${p.recordsProcessed}/${p.totalRecords}`);
  }
}
```

## Bidirectional Communication

### Workflow → Agent

```typescript
// Direct RPC call (typed)
await this.agent.updateTaskStatus(taskId, "processing");
const data = await this.agent.getData(taskId);

// Non-durable callbacks (may repeat on retry, use for frequent updates)
await this.reportProgress({
  step: "process",
  percent: 0.5,
  message: "Halfway done"
});
this.broadcastToClients({ type: "update", data });

// Durable callbacks via step (idempotent, won't repeat on retry)
await step.reportComplete(result);
await step.reportError("Something went wrong");
await step.sendEvent({ type: "custom", data: {} });

// Durable state synchronization via step (broadcasts to clients)
await step.updateAgentState({ status: "processing" });
await step.mergeAgentState({ progress: 0.5 });
```

### Agent → Workflow

```typescript
// Send event to waiting workflow (generic)
await this.sendWorkflowEvent("MY_WORKFLOW", workflowId, {
  type: "custom-event",
  payload: { action: "proceed" }
});

// Approve/reject workflows using convenience methods
await this.approveWorkflow(workflowId, {
  reason: "Approved by admin",
  metadata: { approvedBy: userId }
});

await this.rejectWorkflow(workflowId, {
  reason: "Request denied"
});

// The workflow waits for approval with:
const approvalData = await this.waitForApproval(step, { timeout: "7 days" });
```

## Best Practices

1. **Keep workflows focused** - One workflow per logical task
2. **Use meaningful step names** - Helps with debugging and observability
3. **Report progress regularly** - Keeps users informed
4. **Handle errors gracefully** - Use `reportError()` before throwing
5. **Clean up completed workflows** - The `cf_agents_workflows` table can grow unbounded, so implement a retention policy:

```typescript
// Option 1: Cleanup immediately on completion
async onWorkflowComplete(workflowName, workflowId, result) {
  // Process result first, then delete
  this.deleteWorkflow(workflowId);
}

// Option 2: Scheduled cleanup (keep recent history)
// Call this periodically via a scheduled task or cron
this.deleteWorkflows({
  status: ["complete", "errored"],
  createdBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days
});

// Option 3: Keep all history for compliance/auditing
// Don't call deleteWorkflows() - query historical data as needed
```

6. **Handle workflow binding renames carefully** - If you rename a workflow binding in `wrangler.jsonc`, existing tracked workflows will reference the old name. The agent will warn on startup if it detects this. Use `migrateWorkflowBinding()` to update them:

```typescript
// After renaming OLD_WORKFLOW to NEW_WORKFLOW in wrangler.toml
async onStart() {
  // Migrate any existing tracked workflows to the new binding name
  const migrated = this.migrateWorkflowBinding('OLD_WORKFLOW', 'NEW_WORKFLOW');
  // You can remove this code after all agents have migrated
}
```

## Limitations

- Workflows can have at most 1,024 steps
- Maximum 10MB state per workflow
- Events wait for at most 1 year
- No direct WebSocket from workflows (use `broadcastToClients()`)
- Workflow execution time: up to 30 minutes per step
