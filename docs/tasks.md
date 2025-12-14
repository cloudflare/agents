# Tasks

Tasks are tracked background operations with progress updates, cancellation support, and real-time sync to connected clients.

## Quick Start

```typescript
import { Agent, task, type TaskContext } from "agents";

class MyAgent extends Agent<Env> {
  @task({ timeout: "5m" })
  async processData(input: { url: string }, ctx: TaskContext) {
    ctx.emit("started", { url: input.url });
    ctx.setProgress(25);

    const data = await fetch(input.url);
    ctx.setProgress(75);

    return { processed: true };
  }
}
```

The client receives real-time updates automatically via WebSocket.

## TaskContext

Every task method receives a `TaskContext` with:

- `emit(type, data)` - Send events to connected clients
- `setProgress(n)` - Set progress percentage (0-100)
- `signal` - AbortSignal for cancellation

```typescript
@task({ timeout: "2m" })
async analyze(input: Input, ctx: TaskContext) {
  ctx.emit("phase", { name: "fetching" });

  if (ctx.signal.aborted) {
    throw new Error("Cancelled");
  }

  ctx.setProgress(50);
  // ...
}
```

## Managing Tasks

Access tasks via `this.tasks`:

```typescript
// Get a task
const task = this.tasks.get(taskId);

// List all tasks
const all = this.tasks.list();

// List by status
const running = this.tasks.list({ status: "running" });

// Cancel a task
await this.tasks.cancel(taskId, "User requested");

// Delete completed task
this.tasks.delete(taskId);
```

## Client Updates

Tasks broadcast updates to all connected WebSocket clients:

```typescript
// React client
const agent = useAgent({ agent: "my-agent", name: "default" });

agent.addEventListener("message", (event) => {
  const data = JSON.parse(event.data);
  if (data.type === "CF_AGENT_TASK_UPDATE") {
    const { taskId, task } = data;
    // task.status, task.progress, task.events, task.result
  }
});
```

## Options

```typescript
@task({
  timeout: "5m",      // Cancel if exceeds duration
})
async myTask(input: Input, ctx: TaskContext) {
  // ...
}
```

Timeout accepts: `"30s"`, `"5m"`, `"1h"`, or milliseconds.

## Task Status

Tasks transition through these states:

- `pending` - Created, waiting to run
- `running` - Currently executing
- `completed` - Finished successfully
- `failed` - Threw an error
- `aborted` - Cancelled or timed out

## Durable Tasks

For long-running operations that need to survive restarts, use durable tasks backed by Cloudflare Workflows:

```typescript
@task({ durable: true })
async longProcess(input: Input, ctx: TaskContext) {
  // Durable step - survives restarts
  const data = await ctx.step("fetch", () => fetchData(input));

  // Durable sleep - can sleep for days
  await ctx.sleep("rate-limit", "1h");

  return await ctx.step("process", () => process(data));
}
```

See [Durable Tasks](./durable-tasks.md) for setup and details.
