# Durable Tasks

Durable tasks are long-running operations backed by [Cloudflare Workflows](https://developers.cloudflare.com/workflows/). They survive agent restarts and can run for hours or days.

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
    // Each step is checkpointed - survives restarts
    const files = await ctx.step("fetch", () => fetchRepoFiles(input.repoUrl));

    // Durable sleep - can wait for hours/days
    await ctx.sleep("rate-limit", "1h");

    const analysis = await ctx.step("analyze", () => analyzeFiles(files));

    return analysis;
  }
}
```

## Durable Context Methods

Durable tasks have additional `TaskContext` methods:

### ctx.step(name, fn)

Execute a checkpointed step. If the workflow restarts, completed steps are skipped and their results are replayed.

```typescript
const data = await ctx.step("fetch-data", async () => {
  return await fetch(url).then((r) => r.json());
});
```

### ctx.sleep(name, duration)

Pause execution for a duration. The workflow hibernates and resumes automatically.

```typescript
await ctx.sleep("wait", "30m");
await ctx.sleep("daily-check", "24h");
```

Accepts: `"30s"`, `"5m"`, `"1h"`, `"7d"`, or `"30 seconds"`, `"5 minutes"`, etc.

### ctx.waitForEvent(name, options)

Wait for an external event (human approval, webhook, etc).

```typescript
const approval = await ctx.waitForEvent("approval", {
  type: "user-approved",
  timeout: "24h"
});
```

> Note: `waitForEvent` is only available in durable tasks.

## Retry Configuration

Configure automatic retries for durable tasks:

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

- Long-running operations (minutes to days)
- Multi-step workflows with checkpoints
- Operations that must survive restarts
- Tasks requiring durable sleep or external events

## Custom Workflows

For advanced control, extend `AgentWorkflow` instead:

```typescript
import { AgentWorkflow, type WorkflowTaskContext } from "agents";

export class CustomWorkflow extends AgentWorkflow<Env, { input: string }> {
  async run(ctx: WorkflowTaskContext<{ input: string }>) {
    ctx.emit("started");

    const result = await ctx.step("process", async () => {
      return processInput(ctx.params.input);
    });

    ctx.setProgress(100);
    return result;
  }
}
```

Then dispatch it with `this.workflow()`:

```typescript
class MyAgent extends Agent<Env> {
  @callable()
  async startCustom(input: { data: string }) {
    return this.workflow("CUSTOM_WORKFLOW", input);
  }
}
```

## Example

See [examples/task-runner](../examples/task-runner) for a complete implementation with both simple and durable tasks.
