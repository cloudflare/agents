# Workflow Demo - Task Processing with Approval

This example demonstrates the workflow integration features of Cloudflare Agents:

- **Multi-step workflow** with simulated processing stages
- **Real-time progress** updates via WebSocket
- **Human-in-the-loop approval** gate mid-workflow
- **State sync** from workflow to agent (broadcasts to all clients)
- **Approve/reject** controls in the UI

## Features Demonstrated

| Feature              | API Used                                                      |
| -------------------- | ------------------------------------------------------------- |
| Start workflow       | `agent.runWorkflow()`                                         |
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

1. **Submit a task** - Enter a task name and click "Start Task"
2. **Watch progress** - The workflow runs through validation, processing steps
3. **Approve or reject** - When the workflow reaches the approval step, buttons appear
4. **See result** - After approval, the workflow completes and shows the result

## Code Structure

- `src/server.ts` - Agent and Workflow implementation
  - `TaskAgent` - Manages task workflows, handles approve/reject
  - `TaskProcessingWorkflow` - Multi-step workflow with approval gate
- `src/app.tsx` - React UI with useAgent hook
- `public/styles.css` - Styling for the demo
