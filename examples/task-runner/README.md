# Task Runner Example

A real-world example demonstrating the **task system** in the Agents SDK - an AI-powered GitHub repository analyzer.

## What It Does

Enter a GitHub repo URL → AI analyzes the architecture → Real-time progress updates → Get structured analysis.

## Features

- **`@task()` decorator** - One decorator, one method, full lifecycle tracking
- **Progress events** - `ctx.emit()` for real-time updates
- **Progress percentage** - `ctx.setProgress()` for completion tracking
- **Abort handling** - Cancel tasks with `ctx.signal`
- **Real-time WebSocket** - `useTask()` hook for reactive UI
- **Persistence** - Tasks survive restarts (SQLite)

## How It Works

### Server (Agent)

```typescript
import { Agent, task, callable, type TaskContext } from "agents";

class TaskRunner extends Agent<Env> {
  // @task() automatically:
  // - Makes method callable via RPC
  // - Wraps with lifecycle tracking
  // - Returns TaskHandle immediately
  @task({ timeout: "5m" })
  async analyzeRepo(
    input: { repoUrl: string; branch?: string },
    ctx: TaskContext
  ) {
    ctx.emit("phase", { name: "fetching" });
    ctx.setProgress(10);

    const files = await this.fetchRepoTree(input.repoUrl);

    if (ctx.signal.aborted) throw new Error("Aborted");

    ctx.emit("phase", { name: "analyzing" });
    ctx.setProgress(50);

    const analysis = await this.analyzeWithAI(files);

    ctx.setProgress(100);
    return analysis;
  }

  @callable()
  getTask(taskId: string) {
    return this.tasks.get(taskId);
  }

  @callable()
  abortTask(taskId: string) {
    return this.tasks.cancel(taskId);
  }
}
```

### Client (React)

```tsx
import { useAgent, useTask } from "agents/react";

function TaskView({ taskId }: { taskId: string }) {
  const agent = useAgent({ agent: "task-runner" });
  const task = useTask(agent, taskId);

  return (
    <div>
      <p>Status: {task.status}</p>
      <progress value={task.progress} max={100} />

      {task.events.map((e) => (
        <div key={e.id}>
          {e.type}: {JSON.stringify(e.data)}
        </div>
      ))}

      {task.isRunning && <button onClick={task.abort}>Abort</button>}
      {task.isSuccess && <pre>{JSON.stringify(task.result, null, 2)}</pre>}
    </div>
  );
}
```

## Running

1. Add your OpenAI API key to `.dev.vars`:

   ```
   OPENAI_API_KEY=sk-...
   ```

2. Start the dev server:

   ```sh
   npm run dev
   ```

3. Open http://localhost:5173

## API Reference

### `@task()` Decorator

```typescript
@task({ timeout?: string | number, retries?: number })
async myTask(input: T, ctx: TaskContext): Promise<R>
```

### TaskContext

| Method                   | Description         |
| ------------------------ | ------------------- |
| `ctx.emit(type, data?)`  | Emit progress event |
| `ctx.setProgress(0-100)` | Set completion %    |
| `ctx.signal`             | AbortSignal         |
| `ctx.taskId`             | Task ID             |

### `this.tasks` Accessor

| Method                | Description    |
| --------------------- | -------------- |
| `get(id)`             | Get task by ID |
| `list(filter?)`       | List tasks     |
| `cancel(id, reason?)` | Cancel task    |

### `useTask()` Hook

| Property   | Description                              |
| ---------- | ---------------------------------------- |
| `status`   | pending/running/completed/failed/aborted |
| `progress` | 0-100                                    |
| `result`   | Task result                              |
| `error`    | Error message                            |
| `events`   | Progress events                          |
| `abort()`  | Cancel the task                          |

## Task Lifecycle

```
pending → running → completed
                 ↘ failed
                 ↘ aborted
```
