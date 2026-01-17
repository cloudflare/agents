# Workflow Example

Demonstrates Cloudflare Workflows integration with Agents SDK.

## Overview

This example shows two approaches for running background work:

1. **Quick Analysis** - Runs directly in the Agent using `ctx.waitUntil()`, good for < 30s operations
2. **Deep Analysis** - Uses Cloudflare Workflows for durable, long-running operations

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client (React)                          │
│                                                                 │
│  await agent.call("quickAnalysis", [{ repoUrl }])              │
│  await agent.call("startAnalysis", [{ repoUrl }])              │
│                           │                                     │
└───────────────────────────┼─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Agent (Durable Object)                       │
│                                                                 │
│  quickAnalysis()         │  startAnalysis()                     │
│  - Uses waitUntil()      │  - Creates workflow instance         │
│  - Fast, simple          │  - env.ANALYSIS_WORKFLOW.create()    │
│  - < 30s tasks           │  - Returns task ID                   │
│         │                │           │                          │
└─────────┼────────────────┴───────────┼──────────────────────────┘
          │                            │
          ▼                            ▼
     [Executes                    [Dispatches to
      in Agent]                    Workflow]
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Cloudflare Workflow                            │
│                                                                 │
│  class AnalysisWorkflow extends WorkflowEntrypoint {           │
│    async run(event, step) {                                    │
│      await step.do("fetch", ...);    // Durable step           │
│      await step.sleep("1 hour");     // Survives restarts      │
│      await step.do("analyze", ...);  // Auto-retry on failure  │
│    }                                                            │
│  }                                                              │
│                                                                 │
│  // Sends updates back to Agent via RPC                        │
│  agent.handleWorkflowUpdate({ taskId, progress, event })       │
└─────────────────────────────────────────────────────────────────┘
```

## When to Use Each

| Feature    | waitUntil()         | Cloudflare Workflow      |
| ---------- | ------------------- | ------------------------ |
| Duration   | Seconds to minutes  | Minutes to days          |
| Execution  | In Durable Object   | Separate Workflow engine |
| Durability | Lost on DO eviction | Survives restarts        |
| Retries    | Manual              | Automatic per-step       |
| Sleep      | Not durable         | Durable (can wait hours) |
| Complexity | Simple              | More setup required      |

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.dev.vars`:

```
OPENAI_API_KEY=sk-...
```

3. Run development server:

```bash
npm run dev
```

4. Open http://localhost:5173

## Server Implementation

```typescript
// Quick task - runs in Agent
@callable()
async quickAnalysis(input: { repoUrl: string }): Promise<{ id: string }> {
  const taskId = `task_${crypto.randomUUID().slice(0, 12)}`;

  // Track in state for UI updates
  this.updateTask(taskId, { status: "running" });

  // Run in background
  this.ctx.waitUntil(this.runAnalysis(taskId, input.repoUrl));

  return { id: taskId };
}

// Durable task - dispatches to Workflow
@callable()
async startAnalysis(input: { repoUrl: string }) {
  const taskId = `task_${crypto.randomUUID().slice(0, 12)}`;

  // Create workflow instance
  const instance = await this.env.ANALYSIS_WORKFLOW.create({
    id: taskId,
    params: { repoUrl: input.repoUrl, _agentBinding: "task-runner", _agentName: this.name }
  });

  // Track in state
  this.updateTask(taskId, { status: "pending", workflowInstanceId: instance.id });

  return { id: taskId, workflowInstanceId: instance.id };
}
```

## Workflow Implementation

```typescript
// src/workflows/analysis.ts
import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent
} from "cloudflare:workers";

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    // Durable step - persisted, auto-retry on failure
    const files = await step.do("fetch-repo", async () => {
      // This survives worker restarts
      return await fetchFiles(event.payload.repoUrl);
    });

    // Durable sleep - can wait for hours
    await step.sleep("rate-limit", "1 hour");

    // Step with retry config
    const analysis = await step.do(
      "analyze",
      { retries: { limit: 3, backoff: "exponential" } },
      async () => analyzeFiles(files)
    );

    return analysis;
  }
}
```

## Configuration (wrangler.jsonc)

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "task-runner", "class_name": "TaskRunner" }]
  },
  "workflows": [
    {
      "name": "analysis-workflow",
      "binding": "ANALYSIS_WORKFLOW",
      "class_name": "AnalysisWorkflow"
    }
  ]
}
```

## Files

- `src/server.ts` - Agent with quick and workflow-based analysis
- `src/workflows/analysis.ts` - Durable workflow implementation
- `src/App.tsx` - React UI demonstrating both modes
- `wrangler.jsonc` - Cloudflare configuration
