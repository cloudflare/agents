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
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { AgentWorkflowParams } from "agents";
import type { MyAgent } from "../agent";

type TaskParams = {
  taskId: string;
  data: string;
};

export class ProcessingWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(
    event: WorkflowEvent<AgentWorkflowParams<TaskParams>>,
    step: WorkflowStep
  ) {
    const params = this.getUserParams(event);

    // Step 1: Process data
    const result = await step.do("process-data", async () => {
      // Durable step - will retry on failure
      return processData(params.data);
    });

    // Report progress to Agent
    await this.reportProgress(0.5, "Processing complete");

    // Step 2: Save results
    await step.do("save-results", async () => {
      // Call Agent method via RPC
      await this.agent.saveResult(params.taskId, result);
    });

    // Broadcast to connected clients
    await this.broadcastToClients({
      type: "task-complete",
      taskId: params.taskId
    });

    // Report completion
    await this.reportComplete(result);

    return result;
  }
}
```

### 2. Start Workflow from Agent

Use `runWorkflow()` to start a workflow with automatic tracking:

```typescript
// src/agent.ts
import { Agent } from "agents";

export class MyAgent extends Agent<Env> {
  async startTask(taskId: string, data: string) {
    // Start workflow - automatically tracked in Agent's database
    const workflowId = await this.runWorkflow(this.env.PROCESSING_WORKFLOW, {
      taskId,
      data
    });

    return { workflowId };
  }

  // Called when workflow reports progress
  async onWorkflowProgress(
    workflowId: string,
    progress: number,
    message?: string
  ) {
    console.log(`Workflow ${workflowId}: ${progress * 100}% - ${message}`);

    // Broadcast to connected clients
    this.broadcast(
      JSON.stringify({
        type: "workflow-progress",
        workflowId,
        progress,
        message
      })
    );
  }

  // Called when workflow completes
  async onWorkflowComplete(workflowId: string, result?: unknown) {
    console.log(`Workflow ${workflowId} completed:`, result);
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

### `AgentWorkflow<AgentType, Params, Env>`

Base class for Workflows that integrate with Agents.

**Type Parameters:**

- `AgentType` - The Agent class type (for typed RPC)
- `Params` - User params passed to the workflow (optional)
- `Env` - Environment type (defaults to `Cloudflare.Env`)

**Properties:**

- `agent` - Typed stub for calling Agent methods via RPC
- `workflowId` - The workflow instance ID
- `env` - Environment bindings

**Methods:**

| Method                               | Description                                   |
| ------------------------------------ | --------------------------------------------- |
| `reportProgress(progress, message?)` | Report progress (0-1) to the Agent            |
| `reportComplete(result?)`            | Report successful completion                  |
| `reportError(error)`                 | Report an error                               |
| `sendEvent(event)`                   | Send a custom event to the Agent              |
| `broadcastToClients(message)`        | Broadcast message to all WebSocket clients    |
| `fetchAgent(path, init?)`            | Make HTTP request to the Agent                |
| `getUserParams(event)`               | Extract user params (without internal params) |

### Agent Workflow Methods

Methods added to the `Agent` class:

#### `runWorkflow(workflow, params, options?)`

Start a workflow and track it in the Agent's database.

```typescript
const workflowId = await this.runWorkflow(
  this.env.MY_WORKFLOW,
  { taskId: "123", data: "process this" },
  { id: "custom-id" } // optional
);
```

**Parameters:**

- `workflow` - Workflow binding from `env`
- `params` - Params to pass to the workflow
- `options.id` - Custom workflow ID (auto-generated if not provided)

**Returns:** Workflow instance ID

#### `sendWorkflowEvent(workflow, workflowId, event)`

Send an event to a running workflow.

```typescript
await this.sendWorkflowEvent(this.env.MY_WORKFLOW, workflowId, {
  type: "approval",
  payload: { approved: true }
});
```

#### `getWorkflowStatus(workflow, workflowId)`

Get the status of a workflow and update tracking record.

```typescript
const status = await this.getWorkflowStatus(this.env.MY_WORKFLOW, workflowId);
// status: { status: 'running', output: null, error: null }
```

#### `getWorkflow(workflowId)`

Get a tracked workflow by ID.

```typescript
const workflow = this.getWorkflow<TaskParams>(workflowId);
// { workflowId, status, params, output, error, createdAt, ... }
```

#### `getWorkflows(criteria?)`

Query tracked workflows.

```typescript
// Get all running workflows
const running = this.getWorkflows({ status: "running" });

// Get recent completed workflows
const recent = this.getWorkflows({
  status: ["complete", "errored"],
  limit: 10,
  orderBy: "desc"
});
```

### Lifecycle Callbacks

Override these methods in your Agent to handle workflow events:

```typescript
class MyAgent extends Agent<Env> {
  // Called when workflow reports progress
  async onWorkflowProgress(
    workflowId: string,
    progress: number,
    message?: string
  ) {}

  // Called when workflow completes successfully
  async onWorkflowComplete(workflowId: string, result?: unknown) {}

  // Called when workflow encounters an error
  async onWorkflowError(workflowId: string, error: string) {}

  // Called when workflow sends a custom event
  async onWorkflowEvent(workflowId: string, event: unknown) {}

  // Handle all callbacks in one place (alternative)
  async onWorkflowCallback(callback: WorkflowCallback) {
    // Called for all callback types
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
| `params`        | TEXT    | JSON params passed to workflow  |
| `output`        | TEXT    | JSON output (when complete)     |
| `error_name`    | TEXT    | Error name (if failed)          |
| `error_message` | TEXT    | Error message (if failed)       |
| `created_at`    | INTEGER | Unix timestamp                  |
| `updated_at`    | INTEGER | Unix timestamp                  |
| `completed_at`  | INTEGER | Unix timestamp (when done)      |

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
// Workflow
export class DataProcessingWorkflow extends AgentWorkflow<
  MyAgent,
  ProcessParams
> {
  async run(
    event: WorkflowEvent<AgentWorkflowParams<ProcessParams>>,
    step: WorkflowStep
  ) {
    const params = this.getUserParams(event);
    const items = params.items;

    for (let i = 0; i < items.length; i++) {
      await step.do(`process-${i}`, async () => {
        await processItem(items[i]);
      });

      // Report progress after each item
      await this.reportProgress(
        (i + 1) / items.length,
        `Processed ${i + 1}/${items.length}`
      );
    }

    await this.reportComplete({ processed: items.length });
  }
}

// Agent
class MyAgent extends Agent<Env> {
  async onWorkflowProgress(
    workflowId: string,
    progress: number,
    message?: string
  ) {
    // Broadcast progress to all connected clients
    this.broadcast(
      JSON.stringify({
        type: "processing-progress",
        workflowId,
        progress,
        message
      })
    );
  }
}
```

### Human-in-the-Loop Approval

```typescript
// Workflow
export class ApprovalWorkflow extends AgentWorkflow<MyAgent, RequestParams> {
  async run(
    event: WorkflowEvent<AgentWorkflowParams<RequestParams>>,
    step: WorkflowStep
  ) {
    const params = this.getUserParams(event);

    // Prepare request
    const request = await step.do("prepare", async () => {
      return { ...params, preparedAt: Date.now() };
    });

    // Notify agent we're waiting for approval
    await this.reportProgress(0.5, "Waiting for approval");

    // Wait for approval event (up to 7 days)
    const approval = await step.waitForEvent<{
      approved: boolean;
      reason?: string;
    }>("approval", { timeout: "7 days" });

    if (!approval.payload.approved) {
      await this.reportError(`Rejected: ${approval.payload.reason}`);
      throw new Error("Request rejected");
    }

    // Execute approved action
    const result = await step.do("execute", async () => {
      return executeRequest(request);
    });

    await this.reportComplete(result);
    return result;
  }
}

// Agent
class MyAgent extends Agent<Env> {
  // Called by admin to approve/reject
  async handleApproval(workflowId: string, approved: boolean, reason?: string) {
    await this.sendWorkflowEvent(this.env.APPROVAL_WORKFLOW, workflowId, {
      type: "approval",
      payload: { approved, reason }
    });
  }
}
```

### Durable Task Queue with Retries

```typescript
// Workflow with built-in retry logic
export class ResilientTaskWorkflow extends AgentWorkflow<MyAgent, TaskParams> {
  async run(
    event: WorkflowEvent<AgentWorkflowParams<TaskParams>>,
    step: WorkflowStep
  ) {
    const params = this.getUserParams(event);

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

    await this.reportComplete(result);
    return result;
  }
}
```

## Bidirectional Communication

### Workflow → Agent

```typescript
// Direct RPC call (typed)
await this.agent.updateTaskStatus(taskId, "processing");
const data = await this.agent.getData(taskId);

// HTTP request
const response = await this.fetchAgent("/api/status", {
  method: "POST",
  body: JSON.stringify({ taskId })
});

// Callbacks
await this.reportProgress(0.5, "Halfway done");
await this.reportComplete(result);
await this.reportError("Something went wrong");
await this.sendEvent({ type: "custom", data: {} });

// Broadcast to WebSocket clients
await this.broadcastToClients({ type: "update", data });
```

### Agent → Workflow

```typescript
// Send event to waiting workflow
await this.sendWorkflowEvent(this.env.MY_WORKFLOW, workflowId, {
  type: "approval",
  payload: { approved: true }
});

// The workflow waits for this event with:
const event = await step.waitForEvent("approval", { timeout: "7 days" });
```

## Best Practices

1. **Keep workflows focused** - One workflow per logical task
2. **Use meaningful step names** - Helps with debugging and observability
3. **Report progress regularly** - Keeps users informed
4. **Handle errors gracefully** - Use `reportError()` before throwing
5. **Clean up completed workflows** - Query and delete old records periodically

## Limitations

- Workflows can have at most 1,000 steps
- Maximum 10MB state per workflow
- Events wait for at most 1 year
- No direct WebSocket from workflows (use `broadcastToClients()`)
- Workflow execution time: up to 15 minutes per step
