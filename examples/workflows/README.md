# Workflow Demo - Multiple Concurrent Workflows with Approval

This example demonstrates the workflow integration features of Cloudflare Agents:

- **Multiple concurrent workflows** - Start and track many tasks simultaneously
- **Real-time progress** updates via WebSocket
- **Human-in-the-loop approval** gate per workflow
- **Paginated workflow list** with status tracking via `getWorkflows()`
- **Per-workflow approve/reject** controls in the UI

## Features Demonstrated

| Feature              | API Used                                                      |
| -------------------- | ------------------------------------------------------------- |
| Start workflow       | `agent.runWorkflow()`                                         |
| Query workflows      | `agent.getWorkflows()`                                        |
| Typed progress       | `workflow.reportProgress({ step, status, percent, message })` |
| Wait for approval    | `workflow.waitForApproval(step, options)`                     |
| Approve workflow     | `agent.approveWorkflow(id, data)`                             |
| Reject workflow      | `agent.rejectWorkflow(id, data)`                              |
| State sync           | `workflow.mergeAgentState(partial)`                           |
| Progress callbacks   | `agent.onWorkflowProgress()`                                  |
| Completion callbacks | `agent.onWorkflowComplete()`                                  |

## Running the Example

```bash
# From the repo root
cd examples/workflows

# Install dependencies
npm install

# Generate types
npm run types

# Start development server
npm run start
```

Then open http://localhost:5173 in your browser.

## How It Works

1. **Submit tasks** - Enter a task name and click "Start Task" (you can start multiple)
2. **Watch progress** - Each workflow runs through validation, processing steps
3. **Approve or reject** - When a workflow reaches the approval step, buttons appear on that card
4. **See results** - After approval, the workflow completes and shows the result
5. **Manage list** - Dismiss completed workflows or clear all completed at once

## Code Structure

- `src/server.ts` - Agent and Workflow implementation
  - `TaskAgent` - Manages multiple task workflows with `WorkflowItem[]` state
  - `TaskProcessingWorkflow` - Multi-step workflow with approval gate
- `src/app.tsx` - React UI with workflow cards
  - `WorkflowCard` - Displays individual workflow with progress and actions
  - `StatusBadge` - Shows workflow status (queued, running, waiting, complete, error)
- `public/styles.css` - Styling for the demo

## Key Concepts

### Multi-Workflow State

The agent maintains an array of `WorkflowItem` objects:

```typescript
type WorkflowItem = {
  workflowId: string;
  taskName: string;
  status: "queued" | "running" | "waiting" | "complete" | "errored";
  progress: DefaultProgress | null;
  waitingForApproval: boolean;
  result?: unknown;
  error?: string;
  createdAt: number;
};
```

### Tracking Table Integration

The demo leverages the `cf_agents_workflows` tracking table:

- `getWorkflows()` retrieves tracked workflows with pagination (default limit 50)
- Callbacks (`onWorkflowProgress`, `onWorkflowComplete`, `onWorkflowError`) update both the tracking table and the in-memory state
- Metadata (like `taskName`) is persisted for display after page refresh

### Per-Workflow Approval

Each workflow independently waits for approval:

- The workflow uses `mergeAgentState()` to update only its own `waitingForApproval` flag
- The UI renders approve/reject buttons for each waiting workflow
- `approveWorkflow()` and `rejectWorkflow()` target specific workflow IDs
