# Durable Tasks

Durable tasks are long-running operations backed by [Cloudflare Workflows](https://developers.cloudflare.com/workflows/). They survive agent restarts and automatically retry on failure.

## Setup

1. Export `DurableTaskWorkflow` from your worker:

```typescript
// src/index.ts
import { Agent, routeAgentRequest, DurableTaskWorkflow } from "agents";

export { DurableTaskWorkflow };

export class MyAgent extends Agent<Env> {
  // ...
}
```

2. Add the workflow binding to `wrangler.jsonc`:

```jsonc
{
  "workflows": [
    {
      "name": "durable-tasks",
      "binding": "DURABLE_TASKS_WORKFLOW",
      "class_name": "DurableTaskWorkflow"
    }
  ]
}
```

## Usage

Mark a task as durable with `durable: true`:

```typescript
import { Agent, task, type TaskContext } from "agents";

class MyAgent extends Agent<Env> {
  @task({ durable: true })
  async longAnalysis(input: { repoUrl: string }, ctx: TaskContext) {
    ctx.emit("started");
    const files = await fetchRepoFiles(input.repoUrl);
    ctx.setProgress(50);
    const analysis = await analyzeFiles(files);
    return analysis;
  }
}
```

Durable tasks provide:

- **Automatic retries** on failure (configurable)
- **Survives restarts** - the workflow engine manages execution
- **Real-time updates** via `ctx.emit()` and `ctx.setProgress()`

## Retry Configuration

Configure automatic retries:

```typescript
@task({
  durable: true,
  retry: {
    limit: 3,
    delay: "10s",
    backoff: "exponential"
  }
})
async unreliableTask(input: Input, ctx: TaskContext) {
  // Automatically retries on failure
}
```

## When to Use Durable Tasks

Use `@task()` (simple) for:

- Operations under 30 seconds
- Tasks that can restart from scratch

Use `@task({ durable: true })` for:

- Long-running operations that need retry guarantees
- Operations that must survive agent restarts

## Custom Workflows

For multi-step workflows with individual checkpoints, extend `AgentWorkflow`:

```typescript
import { AgentWorkflow, type WorkflowTaskContext } from "agents";

export class AnalysisWorkflow extends AgentWorkflow<Env, { repoUrl: string }> {
  async run(ctx: WorkflowTaskContext<{ repoUrl: string }>) {
    // Each step is checkpointed - survives restarts
    const files = await ctx.step("fetch", async () => {
      ctx.emit("phase", { name: "fetching" });
      return fetchRepoFiles(ctx.params.repoUrl);
    });

    // Durable sleep - can wait for hours/days
    await ctx.sleep("rate-limit", "1h");

    return await ctx.step("analyze", async () => {
      ctx.setProgress(50);
      return analyzeFiles(files);
    });
  }
}
```

Add to `wrangler.jsonc`:

```jsonc
{
  "workflows": [
    {
      "name": "analysis-workflow",
      "binding": "ANALYSIS_WORKFLOW",
      "class_name": "AnalysisWorkflow"
    }
  ]
}
```

Dispatch via `this.workflow()`:

```typescript
class MyAgent extends Agent<Env> {
  @callable()
  async startAnalysis(input: { repoUrl: string }) {
    return this.workflow("ANALYSIS_WORKFLOW", input);
  }
}
```

### WorkflowTaskContext Methods

Custom workflows have access to:

- `ctx.step(name, fn)` - Checkpointed step, replayed on restart
- `ctx.sleep(name, duration)` - Durable sleep (e.g., `"1h"`, `"7d"`)
- `ctx.emit(type, data)` - Send events to clients
- `ctx.setProgress(n)` - Set progress percentage

## Example

See [examples/task-runner](../examples/task-runner) for a complete implementation with both simple and durable tasks.
