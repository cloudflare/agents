# Task Runner Example

Demonstrates the Agents SDK task system with two execution modes:

1. **Quick Analysis** (`@task()`) - Runs in the Agent (Durable Object), good for < 30s operations
2. **Deep Analysis** (`workflow()`) - Runs in Cloudflare Workflows, durable for hours/days

## Key Feature: Same Client API

Both modes use the identical client-side API:

```tsx
// Client code - works for both @task() and workflow()
const task = await agent.task<ResultType>("methodName", input);

// Task is reactive - updates automatically
task.status; // "pending" | "running" | "completed" | "failed"
task.progress; // 0-100
task.events; // Real-time events from the task
task.result; // Available when completed
task.abort(); // Cancel the task
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client (React)                          │
│                                                                 │
│  const task = await agent.task("quickAnalysis", { repoUrl })   │
│  const task = await agent.task("deepAnalysis", { repoUrl })    │
│                           │                                     │
│                    Same API! ↓                                  │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Agent (Durable Object)                       │
│                                                                 │
│  @task()           │  @callable()                               │
│  quickAnalysis()   │  deepAnalysis() {                          │
│  - Runs in DO      │    return this.workflow("ANALYSIS_WORKFLOW")│
│  - Fast            │  }                                         │
│  - < 30s tasks     │                                            │
│         │          │           │                                │
└─────────┼──────────┴───────────┼────────────────────────────────┘
          │                      │
          ▼                      ▼
     [Executes               [Dispatches to
      in Agent]               Workflow]
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
│  // Sends updates back to Agent via HTTP callback              │
│  notifyAgent({ progress: 50, event: { type: "phase" } })       │
└─────────────────────────────────────────────────────────────────┘
```

## When to Use Each

| Feature    | @task()             | workflow()               |
| ---------- | ------------------- | ------------------------ |
| Duration   | Seconds to minutes  | Minutes to days          |
| Execution  | In Durable Object   | Separate Workflow engine |
| Durability | Lost on DO eviction | Survives restarts        |
| Retries    | Manual              | Automatic per-step       |
| Sleep      | Not durable         | Durable (can wait hours) |
| Cost       | DO compute time     | Workflow compute time    |

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
@task({ timeout: "5m" })
async quickAnalysis(input: Input, ctx: TaskContext) {
  ctx.emit("phase", { name: "fetching" });
  ctx.setProgress(10);

  // Your logic here...

  return result;
}

// Durable task - runs in Workflow
@callable()
async deepAnalysis(input: Input) {
  return this.workflow("ANALYSIS_WORKFLOW", input);
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
    "bindings": [{ "name": "TaskRunner", "class_name": "TaskRunner" }]
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

- `src/server.ts` - Agent with both @task() and workflow() methods
- `src/workflows/analysis.ts` - Durable workflow implementation
- `src/App.tsx` - React UI demonstrating both modes
- `wrangler.jsonc` - Cloudflare configuration
