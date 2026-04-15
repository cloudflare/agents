# Long-Running Agents

Build agents that persist for days, weeks, or months — surviving restarts, waking on demand, and managing work that spans far longer than any single request.

## Why Cloudflare for long-running agents

Agents spend most of their time waiting. Waiting for user input (seconds to days), LLM responses (seconds to minutes), tool results (seconds to hours), human approvals (hours to days), or scheduled wake-ups (minutes to months). On a traditional VM or container, you pay for all that idle time. An agent that is 99% dormant and 1% active still costs you 100% of a server.

Durable Objects invert this model. An agent exists as an addressable entity with persistent state, but consumes zero compute when hibernated. When something happens — an HTTP request, a WebSocket message, a scheduled alarm, an inbound email — the platform wakes the agent, loads its state from SQLite, and hands it the event. The agent does its work, then goes back to sleep.

This is the [actor model](https://en.wikipedia.org/wiki/Actor_model): each agent has an identity, durable state, and wakes on message. You do not manage servers, routing, health checks, or restart logic. The platform handles placement, scaling, and recovery.

The economics follow directly:

|                                               | VMs / Containers                               | Durable Objects                   |
| --------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| **Idle cost**                                 | Full compute cost, always                      | Zero (hibernated)                 |
| **Scaling**                                   | Provision and manage capacity                  | Automatic, per-agent              |
| **State**                                     | External database required                     | Built-in SQLite                   |
| **Recovery**                                  | You build it (process managers, health checks) | Platform restarts, state survives |
| **Identity / routing**                        | You build it (load balancers, sticky sessions) | Built-in (name → agent)           |
| **10,000 agents, each active 1% of the time** | 10,000 always-on instances                     | ~100 active at any moment         |

For agents — which are inherently bursty, stateful, and long-lived — this is a natural fit.

## The lifecycle of a long-running agent

A long-running agent is not a process that runs continuously. It is an entity that **exists** continuously but **runs** intermittently. Understanding the lifecycle is key to building agents that work reliably over long timelines.

```
Wake → onStart() → handle events → idle (~2 min) → hibernation
  ▲                                                      │
  └──────────────── alarm or request wakes agent ────────┘

Eviction (crash / redeploy) can happen at any point.
State persists in SQLite. Agent restarts on next event.
```

### What survives

- **`this.state`** — persisted to SQLite on every `setState()` call
- **`this.sql` data** — all SQLite tables you create
- **Scheduled tasks** — stored in SQLite, trigger alarms to wake the agent
- **Connection state** — `connection.setState()` data for each WebSocket client
- **Fiber checkpoints** — `stash()` data from `runFiber()`

Higher-level abstractions built on SQLite — such as [Workspace](./workspace.md) files, [Session](./sessions.md) messages, and MCP connection state — also survive, since they are backed by the same SQLite storage.

### What does not survive

- **In-memory variables** — class fields not stored via `setState()` or `this.sql`
- **Running timers** — `setTimeout`, `setInterval` are lost on hibernation/eviction
- **Open fetch requests** — in-flight HTTP calls are abandoned
- **Local closures** — callbacks and promise chains are lost

The implication: any work that matters must be persisted or recoverable. The SDK provides primitives for this — schedules, fibers, queues — but understanding the boundary between "in-memory" and "durable" is essential.

## Running example: a project manager agent

Throughout this doc, we build up a project manager agent that:

- Lives for the duration of a project (weeks or months)
- Tracks tasks, assigns work to sub-agents, and reports progress
- Wakes up on schedule to check deadlines and send reminders
- Reacts to external events (webhooks from GitHub, emails from team members)
- Handles long-running operations (CI pipelines, code reviews, deployments)
- Survives any number of restarts and evictions along the way

```typescript
import { Agent } from "agents";

type ProjectState = {
  name: string;
  status: "planning" | "active" | "review" | "complete";
  tasks: Task[];
  plan: Plan | null;
};

type Task = {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "blocked" | "complete";
  assignee?: string;
  dueDate?: string;
  completedAt?: number;
  externalJobId?: string;
};

export class ProjectManager extends Agent<ProjectState> {
  initialState: ProjectState = {
    name: "",
    status: "planning",
    tasks: [],
    plan: null
  };
}
```

The `Plan` type is introduced in [Planning as a durability strategy](#planning-as-a-durability-strategy). We add capabilities to this agent section by section.

## Waking up: how agents get activated

A hibernated agent can be woken by any of these sources:

| Wake source              | How it works                                                                                                                                                                            | Example                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **HTTP request**         | Any request to the agent's URL triggers `onRequest()`                                                                                                                                   | A webhook from GitHub                   |
| **WebSocket connection** | A client connects, triggering `onConnect()`                                                                                                                                             | A team member opens the dashboard       |
| **RPC call**             | Another Worker or agent calls a method via [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) or [`@callable`](./callable-methods.md) | A coordinator agent delegates a task    |
| **Scheduled alarm**      | A stored schedule fires, triggering `alarm()` → your callback                                                                                                                           | Daily standup reminder at 9am           |
| **Email**                | An inbound email triggers `email()`                                                                                                                                                     | A team member replies to a status email |

The pattern extends naturally to any event source that can reach a Worker — anything from telephony webhooks to chat platform bots. An external signal arrives, the platform wakes the agent, and the agent handles it.

The agent does not need to be "started" or "deployed" separately for each wake source — they all route to the same Durable Object instance. The agent's identity (its name) is the routing key.

```typescript
export class ProjectManager extends Agent<ProjectState> {
  async onStart() {
    // Daily deadline check at 9am UTC — idempotent, safe across restarts
    await this.schedule(
      "0 9 * * *",
      "checkDeadlines",
      {},
      {
        idempotent: true
      }
    );

    // Progress sync every 30 minutes
    await this.scheduleEvery(1800, "syncProgress");
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/github-webhook")) {
      const event = await request.json();
      await this.handleGitHubEvent(event);
      return new Response("OK");
    }

    return Response.json({
      project: this.state.name,
      status: this.state.status
    });
  }

  // Scheduled callbacks — the agent wakes, runs the method, goes back to sleep
  async checkDeadlines() {
    /* ... find overdue tasks, broadcast alerts ... */
  }
  async syncProgress() {
    /* ... check on sub-agents, update task statuses ... */
  }
}
```

## Staying alive during long work

Sometimes an agent needs to do work that takes longer than the idle eviction window (~70–140 seconds). Streaming an LLM response, orchestrating a multi-step tool chain, or waiting on a slow API all risk the agent being evicted mid-flight.

`keepAlive()` prevents this by creating a heartbeat that resets the inactivity timer:

```typescript
export class ProjectManager extends Agent<ProjectState> {
  async generateProjectPlan(goal: string) {
    const result = await this.keepAliveWhile(async () => {
      const plan = await this.callLLM(`Create a project plan for: ${goal}`);
      const tasks = await this.callLLM(
        `Break this into tasks: ${JSON.stringify(plan)}`
      );
      return { plan, tasks };
    });

    this.setState({
      ...this.state,
      status: "active",
      plan: result.plan,
      tasks: result.tasks
    });
  }
}
```

`keepAliveWhile()` is the recommended approach — it guarantees the heartbeat is cleaned up when the work finishes (or throws). For manual control, `keepAlive()` returns a disposer:

```typescript
const dispose = await this.keepAlive();
try {
  await longWork();
} finally {
  dispose();
}
```

### When keepAlive is not enough

`keepAlive` is for work measured in minutes, not hours. For truly long-running operations, use a different strategy:

| Duration         | Strategy                                                  |
| ---------------- | --------------------------------------------------------- |
| Seconds          | Normal request handling                                   |
| Minutes          | `keepAlive()` / `keepAliveWhile()`                        |
| Minutes to hours | [Workflows](./workflows.md)                               |
| Hours to days    | Async pattern: start job → hibernate → wake on completion |

## Surviving crashes: fibers and recovery

An agent can be evicted at any time — a deploy, a platform restart, or hitting resource limits. If the agent was mid-task, that work is lost unless it was checkpointed.

[`runFiber()`](./durable-execution.md) provides crash-recoverable execution. It persists a row in SQLite for the duration of the work, and lets you `stash()` intermediate state. If the agent is evicted, the fiber row survives, and `onFiberRecovered()` is called on the next activation.

```typescript
export class ProjectManager extends Agent<ProjectState> {
  async executeTask(task: Task) {
    await this.runFiber(`task:${task.id}`, async (ctx) => {
      const resources = await this.gatherResources(task);
      ctx.stash({ phase: "prepared", resources, task });

      const result = await this.runSubAgent(task, resources);
      ctx.stash({ phase: "executed", result, task });

      await this.updateTaskStatus(task.id, "complete", result);
    });
  }

  async onFiberRecovered(ctx: FiberRecoveryContext) {
    if (!ctx.name.startsWith("task:")) return;
    const { phase, task } = ctx.snapshot as { phase: string; task: Task };

    if (phase === "prepared") {
      await this.executeTask(task);
    } else if (phase === "executed") {
      await this.updateTaskStatus(
        task.id,
        "complete",
        (ctx.snapshot as { result: unknown }).result
      );
    }
  }
}
```

The pattern is: **checkpoint before expensive work, recover from the last checkpoint.** This is not automatic replay — you decide what recovery means for your domain.

> **Testing recovery locally:** In `wrangler dev`, fiber recovery works identically to production. Kill the wrangler process (Ctrl-C or SIGKILL), restart it, and recovery fires automatically. If a request or WebSocket connection arrives first, `onStart()` runs `_checkRunFibers()` eagerly. If the agent has no incoming connections, the persisted alarm fires on its own and triggers recovery via `_onAlarmHousekeeping()` — this is critical for background agents that have no clients. Either path calls your `onFiberRecovered` hook. SQLite and alarm state persist to disk between restarts.

For the full API reference — `FiberContext`, `FiberRecoveryContext`, concurrent fibers, inline vs fire-and-forget patterns — see [Durable Execution](./durable-execution.md).

## Handling long async operations

The project manager frequently kicks off work that takes far longer than any single activation — a CI pipeline runs for 20 minutes, a design review takes a day, a video asset takes hours to generate. The agent should not stay alive for any of this. Instead, it starts the work, persists the job ID in state, and hibernates. When the result arrives — via a callback, a poll, or a workflow completion — the agent wakes, correlates the result, and moves on.

### Pattern: webhook callback

The project manager starts a CI pipeline for a task. The pipeline takes 20 minutes. Rather than holding a connection open, the agent registers its own URL as the callback and goes to sleep:

```typescript
export class ProjectManager extends Agent<ProjectState> {
  async startCIPipeline(task: Task) {
    const response = await fetch("https://ci.example.com/api/pipelines", {
      method: "POST",
      body: JSON.stringify({
        repo: "org/project",
        branch: "main",
        callback_url: `${this.url}/ci-callback?taskId=${task.id}`
      })
    });

    const { pipelineId } = await response.json();
    this.updateTask(task.id, {
      status: "in_progress",
      externalJobId: pipelineId
    });
    // Agent can now hibernate — it will wake when the CI service POSTs to the callback
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/ci-callback")) {
      const taskId = url.searchParams.get("taskId");
      const result = await request.json();
      this.updateTask(taskId, {
        status: result.status === "success" ? "complete" : "blocked"
      });
      return new Response("OK");
    }
    // ... other routes
  }
}
```

### Pattern: polling with schedule

Not every external service supports callbacks. When the project manager submits a video asset for generation, it needs to check back periodically until the job completes:

```typescript
export class ProjectManager extends Agent<ProjectState> {
  async startVideoGeneration(task: Task) {
    const response = await fetch("https://video-api.example.com/generate", {
      method: "POST",
      body: JSON.stringify({ prompt: task.title })
    });
    const { jobId } = await response.json();
    this.updateTask(task.id, { status: "in_progress", externalJobId: jobId });
    await this.schedule(60, "pollExternalJob", {
      taskId: task.id,
      jobId,
      attempt: 1
    });
  }

  async pollExternalJob(payload: {
    taskId: string;
    jobId: string;
    attempt: number;
  }) {
    const response = await fetch(
      `https://video-api.example.com/status/${payload.jobId}`
    );
    const status = await response.json();

    if (status.state === "complete" || status.state === "failed") {
      this.updateTask(payload.taskId, {
        status: status.state === "complete" ? "complete" : "blocked"
      });
      return;
    }

    // Still running — check again with backoff (max 10 minutes)
    const nextDelay = Math.min(60 * payload.attempt, 600);
    await this.schedule(nextDelay, "pollExternalJob", {
      ...payload,
      attempt: payload.attempt + 1
    });
  }
}
```

### Pattern: workflow delegation

A production deployment involves multiple steps that must each retry independently — build, test, stage, promote. The project manager should not manage these steps internally; it delegates to a [Workflow](./workflows.md) that handles retries and step sequencing:

```typescript
export class ProjectManager extends Agent<ProjectState> {
  async startDeployment(task: Task) {
    const instanceId = await this.runWorkflow("DEPLOY_WORKFLOW", {
      taskId: task.id,
      environment: "production"
    });
    this.updateTask(task.id, {
      status: "in_progress",
      externalJobId: instanceId
    });
  }

  async onWorkflowComplete(
    workflowName: string,
    instanceId: string,
    result?: unknown
  ) {
    const task = this.state.tasks.find((t) => t.externalJobId === instanceId);
    if (task) this.updateTask(task.id, { status: "complete" });
  }
}
```

## Reconstructing context after a long wait

The CI pipeline finishes 20 minutes later. The webhook wakes the project manager. The task status is updated. But now what? If the agent was using an LLM to orchestrate work — deciding which task to run next, drafting a status report, reasoning about blockers — it needs to pick up that reasoning thread. The original prompt, the in-flight tool call, the chain of thought — all gone from memory.

This is the fundamental challenge of long-running AI agents. Most frameworks assume tool calls complete within the LLM's timeout and do not address this directly.

Three approaches work today:

**Replay the full conversation history.** `AIChatAgent` persists all messages in SQLite. When the result arrives, append it to the history and re-invoke the LLM. This is the simplest approach but re-processes the entire context window.

**Stash a continuation summary.** Before hibernating, persist a compact description of what the agent was doing and what to do with the result:

```typescript
ctx.stash({
  task: "Waiting for CI results",
  onSuccess: "Mark task complete, move to next step in plan",
  onFailure: "Notify team, schedule retry in 1 hour",
  relevantContext: { taskId, planStep: 3 }
});
```

On recovery, use the stash to construct a focused prompt rather than replaying everything.

**Use the plan as context.** If the agent has a structured plan, the plan itself provides sufficient context: "I am on step 3 of 7, the step was 'run CI pipeline', the result just arrived." This is the most robust approach for long-running agents — the plan is both a recovery mechanism and a context reconstruction strategy. See the next section.

## Planning as a durability strategy

A structured plan is not just useful for showing progress to users — it is a durability mechanism. An agent with a plan can recover from any interruption by looking at where it left off.

```typescript
type Plan = {
  goal: string;
  steps: PlanStep[];
  currentStep: number;
  createdAt: string;
  updatedAt: string;
};

type PlanStep = {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "complete" | "failed" | "skipped";
  result?: unknown;
};

export class ProjectManager extends Agent<ProjectState> {
  async createPlan(goal: string) {
    const steps = await this.keepAliveWhile(async () => {
      return this.callLLM(`
        Break down this project goal into concrete steps.
        Return a JSON array of { id, description } objects.
        Goal: ${goal}
      `);
    });

    this.setState({
      ...this.state,
      plan: {
        goal,
        steps: steps.map((s: { id: string; description: string }) => ({
          ...s,
          status: "pending" as const
        })),
        currentStep: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    await this.schedule(0, "executeNextStep");
  }

  async executeNextStep() {
    const { plan } = this.state;
    if (!plan || plan.currentStep >= plan.steps.length) {
      this.setState({ ...this.state, status: "complete" });
      return;
    }

    const step = plan.steps[plan.currentStep];

    try {
      const result = await this.keepAliveWhile(() => this.executeStep(step));

      // Update plan state — advance to next step
      const updatedSteps = plan.steps.map((s) =>
        s.id === step.id ? { ...s, status: "complete" as const, result } : s
      );
      this.setState({
        ...this.state,
        plan: {
          ...plan,
          steps: updatedSteps,
          currentStep: plan.currentStep + 1,
          updatedAt: new Date().toISOString()
        }
      });

      // Schedule next step — the agent can hibernate between steps
      await this.schedule(0, "executeNextStep");
    } catch (error) {
      // Mark step failed — could re-plan, retry, or ask for human input
      const updatedSteps = plan.steps.map((s) =>
        s.id === step.id ? { ...s, status: "failed" as const } : s
      );
      this.setState({
        ...this.state,
        plan: {
          ...plan,
          steps: updatedSteps,
          updatedAt: new Date().toISOString()
        }
      });
    }
  }
}
```

This pattern has several advantages for long-running agents:

- **Recovery is trivial** — on restart, check `plan.currentStep` and resume
- **Progress is visible** — clients see which steps are done and what is next
- **Re-planning is possible** — if a step fails or requirements change, the agent can revise the remaining steps without losing completed work
- **Human oversight** — the plan is a natural approval checkpoint ("here is what I am going to do — proceed?")
- **Context reconstruction** — the plan tells the LLM where it is, what happened, and what to do next, without replaying the full conversation

## Delegating to sub-agents

A project manager does not do everything itself. It delegates specialized work to sub-agents — each with their own identity, state, and lifecycle.

```typescript
export class ProjectManager extends Agent<ProjectState> {
  async delegateTask(task: Task) {
    // Get a stub to a specialized agent (same DO namespace, unique name)
    const researcher = await this.subAgent(
      ResearchAgent,
      `research-${task.id}`
    );

    // Call methods on the sub-agent via RPC — this wakes the sub-agent
    const findings = await researcher.research(task.title);

    this.updateTask(task.id, { status: "complete" });
    return findings;
  }
}
```

Sub-agents are independent Durable Objects. They have their own state, their own schedules, and their own lifecycle. The parent does not need to stay alive while the sub-agent works — it can start the work, hibernate, and be woken by a callback or scheduled check.

For chat-oriented sub-agents, [Think](./think/index.md) provides `chat()` for RPC streaming between parent and child agents. See [Sub-agents and Programmatic Turns](./think/sub-agents.md).

## Recovering interrupted LLM streams

The patterns above handle the project manager's coordination work — scheduling, delegating, polling. But the project manager also uses an LLM directly: generating plans, summarizing progress, drafting status emails. Those LLM calls stream tokens over a connection that cannot be resumed if the agent is evicted mid-response.

For chat-oriented agents built on `AIChatAgent`, this is an even sharper problem — the user is watching the response stream in real time and sees it stop mid-sentence. `chatRecovery` wraps each chat turn in a `runFiber`, providing automatic `keepAlive` during streaming and a recovery hook when the agent restarts:

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import type {
  ChatRecoveryContext,
  ChatRecoveryOptions
} from "@cloudflare/ai-chat";

class ProjectChat extends AIChatAgent<Env> {
  override chatRecovery = true;

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    // ctx.partialText    — text generated before eviction
    // ctx.recoveryData   — whatever you stashed via this.stash()
    // ctx.messages        — full conversation history

    // Default: persist partial response + schedule continuation
    return {};
  }
}
```

The right recovery strategy depends on the LLM provider:

| Provider               | Strategy                            | How it works                                                                  | Token cost |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------------------------- | ---------- |
| Workers AI             | Continue from partial               | `continueLastTurn()` — model continues via assistant prefill                  | Low        |
| OpenAI (Responses API) | Retrieve completed response         | Stash `responseId` during streaming, `GET /v1/responses/{id}` on recovery     | Zero       |
| Anthropic              | Synthetic continuation              | Persist partial, send a synthetic user message asking the model to continue   | Medium     |
| Other                  | Try prefill, fall back to synthetic | `continueLastTurn()` if the provider supports it, synthetic message otherwise | Varies     |

For a complete multi-provider implementation with full code for each strategy, see the [`forever-chat` example](../experimental/forever-chat/) and the [`forever.md` design doc](../experimental/forever.md).

[Think](./think/index.md) exposes `chatRecovery` as a configuration toggle — the recovery machinery is handled for you without implementing `onChatRecovery` yourself.

## Managing state over time

An agent that runs for months accumulates data: conversation history, timeline events, completed tasks, schedule records. Without management, this grows unbounded.

### Housekeeping

Schedule periodic cleanup to prune old data and archive completed work:

```typescript
export class ProjectManager extends Agent<ProjectState> {
  async onStart() {
    await this.schedule("0 0 * * *", "housekeeping", {}, { idempotent: true });
  }

  async housekeeping() {
    // Archive completed tasks older than 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const toArchive = this.state.tasks.filter(
      (t) => t.status === "complete" && (t.completedAt ?? 0) < cutoff
    );
    for (const task of toArchive) {
      this
        .sql`INSERT INTO archived_tasks (id, data) VALUES (${task.id}, ${JSON.stringify(task)})`;
    }
    this.setState({
      ...this.state,
      tasks: this.state.tasks.filter(
        (t) => !toArchive.some((a) => a.id === t.id)
      )
    });

    // Clean up old workflow tracking records
    this.deleteWorkflows({
      status: ["complete", "errored"],
      createdBefore: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    });
  }
}
```

### Conversation history management

For agents that use `AIChatAgent`, conversation history can grow large over extended lifespans. Without management, a 3-month conversation will exhaust the LLM's context window long before the project ends.

The [Session API](./sessions.md) addresses this directly:

- **Compaction** — automatically summarizes older messages when the estimated token count exceeds a threshold. The summary replaces the middle of the conversation as a non-destructive overlay. Original messages remain in SQLite for audit.
- **Context blocks** — persistent structured sections injected into the system prompt (identity, memory, learned facts). The agent or the LLM can write to these blocks, and they survive hibernation and eviction.
- **Multi-session management** — `SessionManager` provides a registry of named sessions within a single agent, with forking, cross-session search, and `compactAndSplit` for splitting long conversations into linked continuations.

For simpler cases: keep only the last N messages in the active context (sliding window), or selectively retain messages that contain decisions and approvals while pruning routine exchanges.

## End of life

A long-running agent eventually completes its purpose. The project ships, the investigation concludes, the monitoring window closes. Clean up explicitly:

```typescript
export class ProjectManager extends Agent<ProjectState> {
  async completeProject() {
    // Cancel remaining schedules
    const schedules = this.getSchedules();
    for (const schedule of schedules) {
      await this.cancelSchedule(schedule.id);
    }

    // Archive final state
    this.setState({ ...this.state, status: "complete" });

    // Optionally destroy the Durable Object entirely
    // All SQLite data, schedules, and state are permanently deleted
    await this.destroy();
  }
}
```

`this.destroy()` is permanent. If you may need the agent's data later, archive it to an external store (R2, D1, or an API call) before destroying. For agents that might be reactivated, simply mark them as complete and let them hibernate — they cost nothing when idle.

## When to use Workflows vs agent-internal patterns

Both Workflows and agent-internal primitives (schedules, fibers, queues) support long-running work. The right choice depends on the nature of the work:

|                    | Agent-internal                                         | Workflows                                |
| ------------------ | ------------------------------------------------------ | ---------------------------------------- |
| **Best for**       | Agent-centric work: scheduling, polling, state updates | Independent multi-step pipelines         |
| **Durability**     | SQLite (survives eviction)                             | Workflow engine (survives everything)    |
| **Retries**        | `this.retry()`, schedule-level retries                 | Per-step retries with backoff            |
| **Max duration**   | Minutes per activation (with `keepAlive`)              | 30 minutes per step, unlimited steps     |
| **Human approval** | Build it yourself (state + WebSocket)                  | Built-in `waitForApproval()`             |
| **Complexity**     | Lower — everything is in the agent                     | Higher — separate class, wrangler config |

A pragmatic rule: if the work is about the agent managing its own lifecycle (checking deadlines, syncing state, sending reminders), use schedules and fibers. If the work is a discrete pipeline that could fail and retry independently (deploy, data processing, report generation), use a Workflow.

The project manager agent uses both: schedules for its own rhythms (daily standups, progress syncs), and Workflows for heavyweight operations (deployments, CI pipelines).

## Think: batteries included

If you are building a chat-oriented long-running agent and want these patterns built in rather than assembling them yourself, [`Think`](./think/index.md) provides them out of the box:

- **Sessions with compaction** — non-destructive conversation summarization, context blocks, cross-session search
- **Fiber-based recovery** — `chatRecovery` as a configuration toggle
- **Sub-agent RPC** — `chat()` for parent-child streaming
- **Persistent memory** — LLM-writable context blocks that survive hibernation
- **Workspace and code execution** — built-in file tools and sandboxed execution

Override `getModel()` and `configureSession()` and the durability machinery is handled for you. Think is the opinionated path; the primitives described in this doc are what Think is built on.

## Summary

Long-running agents on Cloudflare are not long-running processes. They are durable entities that wake, work, and sleep — potentially over weeks or months. The key primitives:

| Primitive                              | Purpose                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| **`setState()` / `this.sql`**          | Persist state across activations                               |
| **`schedule()` / `scheduleEvery()`**   | Wake the agent at future times                                 |
| **`keepAlive()` / `keepAliveWhile()`** | Prevent eviction during active work                            |
| **`runFiber()` / `stash()`**           | Checkpoint and recover long tasks                              |
| **`chatRecovery`**                     | Recover interrupted LLM streams                                |
| **`onRequest()` / `email()` / RPC**    | Wake on external events                                        |
| **`runWorkflow()`**                    | Delegate heavyweight multi-step work                           |
| **`subAgent()`**                       | Delegate specialized work to child agents                      |
| **Session API**                        | Manage conversation history, compaction, and context over time |
| **Structured plans in state**          | Enable recovery, visibility, and re-planning                   |

For the project manager agent, these compose into an agent that:

1. **Plans** — breaks goals into steps, persists the plan in state
2. **Executes** — runs steps one at a time, hibernating between them
3. **Reacts** — wakes on webhooks, emails, and schedules
4. **Recovers** — resumes from the last checkpoint after any interruption
5. **Delegates** — hands off work to sub-agents and Workflows
6. **Maintains** — prunes old data, archives completed work, manages its own lifecycle
7. **Ends** — cleans up and destroys itself when the project is done

The agent does not need to run continuously to do any of this. It just needs to exist.

## Related

- [Durable Execution](./durable-execution.md) — `runFiber()`, `stash()`, and crash recovery
- [Scheduling](./scheduling.md) — delayed, cron, and interval tasks
- [Retries](./retries.md) — retry options and patterns
- [Workflows](./workflows.md) — durable multi-step processing
- [State Management](./state.md) — `setState()` and persistence
- [Sessions](./sessions.md) — persistent conversation storage, compaction, and context blocks
- [Think](./think/index.md) — opinionated chat agent with built-in durability
- [HTTP & WebSockets](./http-websockets.md) — lifecycle hooks and hibernation
- [Callable Methods](./callable-methods.md) — RPC via `@callable` and service bindings
- [Email Routing](./email.md) — receiving inbound email
- [Webhooks](./webhooks.md) — receiving external events
- [Human in the Loop](./human-in-the-loop.md) — approval flows
- [Resumable Streaming](./resumable-streaming.md) — client-side stream resumption on disconnect
- [`forever-chat` example](../experimental/forever-chat/) — multi-provider LLM recovery demo
