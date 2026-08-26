# Scheduling

Schedule tasks to run in the future — whether that's seconds from now, at a specific date/time, or on a recurring cron schedule. Scheduled tasks survive agent restarts and are persisted to SQLite.

## Overview

The scheduling system supports four modes:

| Mode          | Syntax                              | Use Case                  |
| ------------- | ----------------------------------- | ------------------------- |
| **Delayed**   | `this.schedule(60, ...)`            | Run in 60 seconds         |
| **Scheduled** | `this.schedule(new Date(...), ...)` | Run at specific time      |
| **Cron**      | `this.schedule("0 8 * * *", ...)`   | Run on recurring schedule |
| **Interval**  | `this.scheduleEvery(30, ...)`       | Run every 30 seconds      |

Under the hood, scheduling uses [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) to wake the agent at the right time. Tasks are stored in a SQLite table and executed in order.

## Scheduler Lifecycle primitive

> **Experimental.** The `Scheduler` primitive and the `agents/lifecycle`
> surface it builds on may change between releases. Agent's established
> scheduling methods (`this.schedule()` and friends) are stable.

`Scheduler` is a reusable Lifecycle capability. A plain Lifecycle Object can
install it without extending `Agent`:

```typescript
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Scheduler, type Schedule } from "agents/schedules";

export class ReminderObject extends DurableObject<Env> {
  readonly scheduler = new Scheduler({
    callbacks: {
      sendReminder: (
        payload: { message: string },
        schedule: Schedule<{ message: string }>
      ) => {
        console.log(schedule.id, payload.message);
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  async createReminder(message: string): Promise<string> {
    const schedule = await this.scheduler.set(300, "sendReminder", {
      message
    });
    return schedule.id;
  }
}
```

Lifecycle owns the physical Durable Object alarm. Scheduler contributes its
earliest pending task or hung-interval recheck. Lifecycle selects the earliest
contribution from Scheduler, other capabilities, and the host, then rearms after
every alarm phase. A future Fiber or MCP capability can contribute its own wake
time without storing work in Scheduler or depending on it.

Scheduler's primary API is small: callbacks are registered by name in the
constructor, `set()` and `every()` create schedules typed against that
registration, and `get()`, `list()`, and `cancel()` manage them. All of these
are asynchronous and work inside routed sub-agents.

Scheduler Lifecycle hooks run without ambient host context. Registered
callbacks are user code, so they run inside the host invocation context with
the Lifecycle Object available through `getCurrentAgent()`.

## Using Scheduler through Agent

Every `Agent` constructs and installs the same primitive at `this.scheduler`.
Existing Agent applications continue to use the established methods:

- `this.schedule()` and `this.scheduleEvery()` create schedules.
- `this.getScheduleById()` and `this.listSchedules()` read schedules.
- `this.cancelSchedule()` removes a schedule.

These methods delegate to `this.scheduler`; no setup or migration is required.
Agent registers no callbacks map — a composition-root resolver keeps
`this.schedule(60, "methodName")` dispatching to Agent methods. Agent passes
only policy options (retry defaults, hung-interval timeout, error routing) and
adapts Lifecycle's event sink, facet transport, and host invocation boundary
at its composition root — there is no Agent-specific Scheduler adapter. Scheduler contributes its next wake time to the same Lifecycle alarm
selection as Agent keep-alive, fibers, sub-agent work, and deferred
destruction.

Import `Scheduler` and runtime schedule types from the dependency-light entry
point:

```typescript
import {
  Scheduler,
  type Schedule,
  type ScheduleCriteria
} from "agents/schedules";
```

Natural-language parsing helpers use Zod and live under
`agents/schedules/parser`. The previous `agents/schedule` path remains as a
deprecated compatibility alias.

## Quick Start

```typescript
import { Agent } from "agents";

export class ReminderAgent extends Agent {
  async onRequest(request: Request) {
    const url = new URL(request.url);

    // Schedule in 30 seconds
    await this.schedule(30, "sendReminder", {
      message: "Check your email"
    });

    // Schedule at specific time
    await this.schedule(new Date("2025-02-01T09:00:00Z"), "sendReminder", {
      message: "Monthly report due"
    });

    // Schedule recurring (every day at 8am)
    await this.schedule("0 8 * * *", "dailyDigest", {
      userId: url.searchParams.get("userId")
    });

    return new Response("Scheduled!");
  }

  async sendReminder(payload: { message: string }) {
    console.log(`Reminder: ${payload.message}`);
    // Send notification, email, etc.
  }

  async dailyDigest(payload: { userId: string }) {
    console.log(`Sending daily digest to ${payload.userId}`);
    // Generate and send digest
  }
}
```

## Scheduling Modes

### Delayed Execution

Pass a number to schedule a task to run after a delay in **seconds**:

```typescript
// Run in 10 seconds
await this.schedule(10, "processTask", { taskId: "123" });

// Run in 5 minutes (300 seconds)
await this.schedule(300, "sendFollowUp", { email: "user@example.com" });

// Run in 1 hour
await this.schedule(3600, "checkStatus", { orderId: "abc" });
```

**Use cases:**

- Debouncing rapid events
- Delayed notifications ("You left items in your cart")
- Retry with backoff
- Rate limiting

### Scheduled Execution

Pass a `Date` object to schedule a task at a specific time:

```typescript
// Run tomorrow at noon
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
tomorrow.setHours(12, 0, 0, 0);
await this.schedule(tomorrow, "sendReminder", { message: "Meeting time!" });

// Run at a specific timestamp
await this.schedule(new Date("2025-06-15T14:30:00Z"), "triggerEvent", {
  eventId: "conference-2025"
});

// Run in 2 hours using Date math
const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
await this.schedule(twoHoursFromNow, "checkIn", {});
```

**Use cases:**

- Appointment reminders
- Deadline notifications
- Scheduled content publishing
- Time-based triggers

### Recurring (Cron)

Pass a cron expression string for recurring schedules:

```typescript
// Every day at 8:00 AM
await this.schedule("0 8 * * *", "dailyReport", {});

// Every hour
await this.schedule("0 * * * *", "hourlyCheck", {});

// Every Monday at 9:00 AM
await this.schedule("0 9 * * 1", "weeklySync", {});

// Every 15 minutes
await this.schedule("*/15 * * * *", "pollForUpdates", {});

// First day of every month at midnight
await this.schedule("0 0 1 * *", "monthlyCleanup", {});
```

**Cron syntax:** `minute hour day month weekday`

| Field        | Values         | Special Characters |
| ------------ | -------------- | ------------------ |
| Minute       | 0-59           | `*` `,` `-` `/`    |
| Hour         | 0-23           | `*` `,` `-` `/`    |
| Day of Month | 1-31           | `*` `,` `-` `/`    |
| Month        | 1-12           | `*` `,` `-` `/`    |
| Day of Week  | 0-6 (0=Sunday) | `*` `,` `-` `/`    |

**Common patterns:**

```typescript
"* * * * *"; // Every minute
"*/5 * * * *"; // Every 5 minutes
"0 * * * *"; // Every hour (on the hour)
"0 0 * * *"; // Every day at midnight
"0 8 * * 1-5"; // Weekdays at 8am
"0 0 * * 0"; // Every Sunday at midnight
"0 0 1 * *"; // First of every month
```

**Use cases:**

- Daily/weekly reports
- Periodic cleanup jobs
- Polling external services
- Health checks
- Subscription renewals

### Interval

Use `scheduleEvery()` to run a task at fixed intervals (in seconds). Unlike cron, intervals support sub-minute precision and arbitrary durations:

```typescript
// Poll every 30 seconds
await this.scheduleEvery(30, "poll", { source: "api" });

// Health check every 45 seconds
await this.scheduleEvery(45, "healthCheck", {});

// Sync every 90 seconds (1.5 minutes - can't be expressed in cron)
await this.scheduleEvery(90, "syncData", { destination: "warehouse" });
```

**Idempotency:**

`scheduleEvery()` is idempotent on the combination of callback name, interval, and payload — calling it multiple times with the same arguments does not create duplicate schedules. This makes it safe to call in `onStart()`, which runs on every Durable Object wake:

```typescript
class MyAgent extends Agent {
  async onStart() {
    // Safe: only one schedule is created, no matter how many times the DO wakes
    await this.scheduleEvery(30, "tick");
  }

  async tick() {
    console.log("tick", new Date().toISOString());
  }
}
```

Calling `scheduleEvery()` with a different interval or payload creates a separate schedule, even for the same callback:

```typescript
// First call creates one schedule
await this.scheduleEvery(30, "poll");

// Second call with a different interval creates a second schedule
await this.scheduleEvery(60, "poll");
// Two "poll" schedules exist: one every 30s and one every 60s

// Third call with the same arguments as the first is a no-op
await this.scheduleEvery(30, "poll");
// Still two schedules
```

Different callbacks also get their own independent schedules:

```typescript
// These create two separate schedules (different callbacks)
await this.scheduleEvery(30, "poll");
await this.scheduleEvery(30, "healthCheck");
```

**Key differences from cron:**

| Feature             | Cron                           | Interval               |
| ------------------- | ------------------------------ | ---------------------- |
| Minimum granularity | 1 minute                       | 1 second               |
| Arbitrary intervals | No (must fit cron pattern)     | Yes                    |
| Fixed schedule      | Yes (e.g., "every day at 8am") | No (relative to start) |
| Overlap prevention  | No                             | Yes (built-in)         |

**Overlap prevention:**

If a callback takes longer than the interval, the next execution is skipped (not queued). This prevents runaway resource usage:

```typescript
class PollingAgent extends Agent {
  async poll() {
    // If this takes 45 seconds and interval is 30 seconds,
    // the next poll is skipped (with a warning logged)
    const data = await slowExternalApi();
    await this.processData(data);
  }
}

// Set up 30-second interval
await this.scheduleEvery(30, "poll", {});
```

When a skip occurs, you'll see a warning in logs:

```
Skipping interval schedule abc123: previous execution still running
```

**Error resilience:**

If the callback throws an error, the interval continues — only that execution fails:

```typescript
async syncData() {
  // Even if this throws, the interval keeps running
  const response = await fetch("https://api.example.com/data");
  if (!response.ok) throw new Error("Sync failed");
  // ...
}
```

**Use cases:**

- Sub-minute polling (every 10, 30, 45 seconds)
- Intervals that don't map to cron (every 90 seconds, every 7 minutes)
- Rate-limited API polling with precise control
- Real-time data synchronization

## Keeping the Agent Alive

Durable Objects are evicted after a period of inactivity (typically 70-140 seconds with no incoming requests, WebSocket messages, or alarms). During long-running operations — streaming LLM responses, waiting on external APIs, running multi-step computations — the agent can be evicted mid-flight.

`keepAlive()` prevents this by holding an alarm-backed heartbeat ref that keeps the agent active until you are done:

```typescript
const dispose = await this.keepAlive();
try {
  // Long-running work that must not be interrupted
  const result = await longRunningComputation();
  await sendResults(result);
} finally {
  dispose();
}
```

The returned disposer function cancels the heartbeat. Always call it when the work is done — otherwise the heartbeat continues indefinitely.

### keepAliveWhile()

For scoped work, use `keepAliveWhile()` — it runs an async function and automatically cleans up the heartbeat when it completes (or throws):

```typescript
const result = await this.keepAliveWhile(async () => {
  const data = await longRunningComputation();
  return data;
});
```

This is the recommended approach since you cannot forget to dispose the heartbeat.

### How it works

`keepAlive()` uses an in-memory reference count. Each call increments the count; the disposer decrements it. While the count is above zero, Agent contributes a wake time every 30 seconds to Lifecycle. No schedule rows are created and no observability events are emitted, so the heartbeat is invisible to `listSchedules()` and the scheduling diagnostics channel.

The heartbeat does not conflict with scheduled work. Lifecycle selects one physical alarm from both contributions.

Inside sub-agents, `keepAlive()` delegates that heartbeat ref to the top-level parent because facets do not have independent alarm slots. `keepAliveWhile()` works the same way because it calls `keepAlive()` and automatically disposes the delegated ref when the scoped work completes.

### Multiple concurrent callers

Each `keepAlive()` call returns an independent disposer:

```typescript
const dispose1 = await this.keepAlive();
const dispose2 = await this.keepAlive();

// Both heartbeats are active (ref count = 2)
dispose1(); // Decrements ref count to 1
// Agent is still alive via dispose2's ref

dispose2(); // Ref count reaches 0 — agent can go idle
```

### AIChatAgent

`AIChatAgent` automatically calls `keepAlive()` during streaming responses. You do not need to add it yourself when using `AIChatAgent` — every LLM stream is protected from idle eviction by default.

### When to use keepAlive()

| Scenario                                    | Use keepAlive()?                       |
| ------------------------------------------- | -------------------------------------- |
| Streaming LLM responses via `AIChatAgent`   | No — already built in                  |
| Long-running computation in a custom Agent  | Yes                                    |
| Waiting on a slow external API call         | Yes                                    |
| Multi-step tool execution                   | Yes                                    |
| Short request-response handlers             | No — not needed                        |
| Background work via scheduling or workflows | No — alarms already keep the DO active |

## Managing Schedules

### Get a Schedule

Retrieve a scheduled task by its ID:

```typescript
const schedule = await this.getScheduleById(scheduleId);

if (schedule) {
  console.log(
    `Task ${schedule.id} will run at ${new Date(schedule.time * 1000)}`
  );
  console.log(`Callback: ${schedule.callback}`);
  console.log(`Type: ${schedule.type}`); // "scheduled" | "delayed" | "cron" | "interval"
} else {
  console.log("Schedule not found");
}
```

### List Schedules

Query scheduled tasks with optional filters:

```typescript
// Get all scheduled tasks
const allSchedules = await this.listSchedules();

// Get only cron jobs
const cronJobs = await this.listSchedules({ type: "cron" });

// Get tasks in the next hour
const upcoming = await this.listSchedules({
  timeRange: {
    start: new Date(),
    end: new Date(Date.now() + 60 * 60 * 1000)
  }
});

// Get a specific task by ID
const specific = await this.listSchedules({ id: "abc123" });

// Combine filters
const upcomingCronJobs = await this.listSchedules({
  type: "cron",
  timeRange: {
    start: new Date(),
    end: new Date(Date.now() + 24 * 60 * 60 * 1000)
  }
});
```

### Cancel a Schedule

Remove a scheduled task before it executes:

```typescript
const cancelled = await this.cancelSchedule(scheduleId);

if (cancelled) {
  console.log("Schedule cancelled successfully");
} else {
  console.log("Schedule not found (may have already executed)");
}
```

`cancelSchedule(id)` only matches schedules owned by the agent it is called on. A top-level agent cannot cancel a sub-agent's schedules by id, and a sub-agent cannot reach a sibling's schedules. To clear every schedule under a sub-agent (and any of its descendants), call `parent.deleteSubAgent(Cls, name)` from the parent — that bulk-cancels the prefix and tears the sub-agent down.

**Example: Cancellable reminders**

```typescript
class ReminderAgent extends Agent {
  async setReminder(userId: string, message: string, delaySeconds: number) {
    const schedule = await this.schedule(delaySeconds, "sendReminder", {
      userId,
      message
    });

    // Store the schedule ID so user can cancel later
    this.sql`
      INSERT INTO user_reminders (user_id, schedule_id, message)
      VALUES (${userId}, ${schedule.id}, ${message})
    `;

    return schedule.id;
  }

  async cancelReminder(scheduleId: string) {
    const cancelled = await this.cancelSchedule(scheduleId);

    if (cancelled) {
      this.sql`DELETE FROM user_reminders WHERE schedule_id = ${scheduleId}`;
    }

    return cancelled;
  }

  async sendReminder(payload: { userId: string; message: string }) {
    // Send the reminder...

    // Clean up the record
    this.sql`DELETE FROM user_reminders WHERE user_id = ${payload.userId}`;
  }
}
```

## The Schedule Object

When you create or retrieve a schedule, you get a `Schedule` object:

```typescript
type Schedule<T = string> = {
  id: string; // Unique identifier
  callback: string; // Method name to call
  payload: T; // Data passed to the callback
  retry?: RetryOptions; // Retry options (if configured)
  time: number; // Unix timestamp (seconds) of next execution
} & (
  | { type: "scheduled" } // One-time at specific date
  | { type: "delayed"; delayInSeconds: number } // One-time after delay
  | { type: "cron"; cron: string } // Recurring (cron expression)
  | { type: "interval"; intervalSeconds: number } // Recurring (fixed interval)
);
```

**Example:**

```typescript
const schedule = await this.schedule(
  60,
  "myTask",
  { foo: "bar" },
  { retry: { maxAttempts: 5 } }
);

console.log(schedule);
// {
//   id: "abc123xyz",
//   callback: "myTask",
//   payload: { foo: "bar" },
//   retry: { maxAttempts: 5 },
//   time: 1706745600,
//   type: "delayed",
//   delayInSeconds: 60
// }
```

## Patterns

### Rescheduling from Callbacks

For dynamic recurring schedules, schedule the next run from within the callback:

```typescript
class PollingAgent extends Agent {
  async startPolling(intervalSeconds: number) {
    await this.schedule(intervalSeconds, "poll", { interval: intervalSeconds });
  }

  async poll(payload: { interval: number }) {
    try {
      const data = await fetch("https://api.example.com/updates");
      await this.processUpdates(await data.json());
    } catch (error) {
      console.error("Polling failed:", error);
    }

    // Schedule the next poll (regardless of success/failure)
    await this.schedule(payload.interval, "poll", payload);
  }

  async stopPolling() {
    // Cancel all polling schedules
    const schedules = await this.listSchedules({ type: "delayed" });
    for (const schedule of schedules) {
      if (schedule.callback === "poll") {
        await this.cancelSchedule(schedule.id);
      }
    }
  }
}
```

### Retry on Failure

For immediate retries (within seconds), use the built-in retry option:

```typescript
// Retry up to 5 times with exponential backoff
await this.schedule(
  60,
  "processTask",
  { taskId: "123" },
  {
    retry: { maxAttempts: 5 }
  }
);
```

For longer recovery windows (minutes or hours), combine `this.retry()` for immediate retries with scheduled retries for extended outages:

```typescript
class RetryAgent extends Agent {
  async attemptTask(payload: {
    taskId: string;
    attempt: number;
    maxAttempts: number;
  }) {
    try {
      // Immediate retries for transient failures
      await this.retry(() => this.doWork(payload.taskId), {
        maxAttempts: 3
      });
      console.log(
        `Task ${payload.taskId} succeeded on attempt ${payload.attempt}`
      );
    } catch (error) {
      if (payload.attempt >= payload.maxAttempts) {
        console.error(
          `Task ${payload.taskId} failed after ${payload.maxAttempts} attempts`
        );
        return;
      }

      // Schedule a retry in the future for longer outages
      const delaySeconds = Math.pow(2, payload.attempt) * 60;

      await this.schedule(delaySeconds, "attemptTask", {
        ...payload,
        attempt: payload.attempt + 1
      });

      console.log(`Scheduled retry in ${delaySeconds}s`);
    }
  }

  async doWork(taskId: string) {
    // Your actual work here
  }
}
```

See [Retries](./retries.md) for full documentation on retry options and patterns.

### Self-Destructing Agents

You can safely call `this.destroy()` from within a scheduled callback:

```typescript
class TemporaryAgent extends Agent {
  async onStart() {
    // Self-destruct in 24 hours
    await this.schedule(24 * 60 * 60, "cleanup", {});
  }

  async cleanup() {
    // Perform final cleanup
    console.log("Agent lifetime expired, cleaning up...");

    // This is safe to call from a scheduled callback
    await this.destroy();
  }
}
```

### Timezone-Aware Scheduling

JavaScript Dates are UTC by default. For timezone-aware scheduling:

```typescript
class TimezoneAgent extends Agent {
  async scheduleForTimezone(
    hour: number,
    minute: number,
    timezone: string,
    callback: keyof this
  ) {
    // Create a date in the target timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });

    // Parse and construct target time
    const targetDate = new Date(
      now.toLocaleString("en-US", { timeZone: timezone })
    );
    targetDate.setHours(hour, minute, 0, 0);

    // If time already passed today, schedule for tomorrow
    if (targetDate <= now) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    return this.schedule(targetDate, callback, { timezone });
  }
}
```

## AI-Assisted Scheduling

The SDK includes utilities for parsing natural language scheduling requests with AI. Import them from `agents/schedules/parser`.

### getSchedulePrompt()

Returns a system prompt for parsing natural language into scheduling parameters:

```typescript
import { getSchedulePrompt, scheduleSchema } from "agents/schedules/parser";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";

class SmartScheduler extends Agent {
  async parseScheduleRequest(userInput: string) {
    const result = await generateObject({
      model: openai("gpt-4o"),
      system: getSchedulePrompt({ date: new Date() }),
      prompt: userInput,
      schema: scheduleSchema
    });

    return result.object;
  }

  async handleUserRequest(input: string) {
    // Parse: "remind me to call mom tomorrow at 3pm"
    const parsed = await this.parseScheduleRequest(input);

    // parsed = {
    //   description: "call mom",
    //   when: {
    //     type: "scheduled",
    //     date: "2025-01-30T15:00:00Z"
    //   }
    // }

    if (parsed.when.type === "scheduled" && parsed.when.date) {
      await this.schedule(new Date(parsed.when.date), "sendReminder", {
        message: parsed.description
      });
    } else if (parsed.when.type === "delayed" && parsed.when.delayInSeconds) {
      await this.schedule(parsed.when.delayInSeconds, "sendReminder", {
        message: parsed.description
      });
    } else if (parsed.when.type === "cron" && parsed.when.cron) {
      await this.schedule(parsed.when.cron, "sendReminder", {
        message: parsed.description
      });
    }
  }

  async sendReminder(payload: { message: string }) {
    console.log(`Reminder: ${payload.message}`);
  }
}
```

### scheduleSchema

A Zod schema for validating parsed scheduling data:

```typescript
import { scheduleSchema } from "agents/schedules/parser";

// The schema uses a discriminated union on `when.type`:
// {
//   description: string,
//   when:
//     | { type: "scheduled", date: string }        // ISO 8601 date string
//     | { type: "delayed", delayInSeconds: number }
//     | { type: "cron", cron: string }
//     | { type: "no-schedule" }
// }
```

When using this schema with OpenAI models via the AI SDK, you must pass `providerOptions: { openai: { strictJsonSchema: false } }` to `generateObject`. This is because the schema uses a discriminated union which is not compatible with OpenAI's strict structured outputs mode.

## Scheduling vs Queue vs Workflows

| Feature            | Queue              | Scheduling        | Workflows           |
| ------------------ | ------------------ | ----------------- | ------------------- |
| **When**           | Immediately (FIFO) | Future time       | Future time         |
| **Execution**      | Sequential         | At scheduled time | Multi-step          |
| **Retries**        | Automatic          | Automatic         | Automatic           |
| **Persistence**    | SQLite             | SQLite            | Workflow engine     |
| **Recurring**      | No                 | Yes (cron)        | No (use scheduling) |
| **Complex logic**  | No                 | No                | Yes                 |
| **Human approval** | No                 | No                | Yes                 |

**Use Queue when:**

- You need background processing without blocking the response
- Tasks should run ASAP but don't need to block
- Order matters (FIFO)

**Use Scheduling when:**

- Tasks need to run at a specific time
- You need recurring jobs (cron)
- Delayed execution (debouncing, retries)

**Use Workflows when:**

- Multi-step processes with dependencies
- Automatic retries with backoff
- Human-in-the-loop approvals
- Long-running tasks (minutes to hours)

## API Reference

Two surfaces share these semantics: the experimental `Scheduler` primitive
(`agents/schedules`, methods on the scheduler instance) and the stable `Agent`
methods (on the Agent class, delegating to `this.scheduler`).

### Scheduler primitive

#### `new Scheduler(options?)`

```typescript
new Scheduler({
  callbacks?,
  retry?,
  hungScheduleTimeoutSeconds?,
  onError?
});
```

- `callbacks` registers scheduled callbacks by name. `set()` and `every()`
  type both the name and the payload against this map, and dispatch runs the
  registered function — the typed scheduling surface and the runtime dispatch
  target are the same object.
- Lifecycle supplies storage, readiness, startup state, alarm coordination,
  the host invocation boundary, events, and routing.
- `retry` supplies callback retry defaults. The defaults are three attempts,
  100 ms base delay, and 3,000 ms maximum delay.
- `hungScheduleTimeoutSeconds` defaults to 30 seconds.
- `onError` observes terminal callback failures outside ambient host context.

Install the constructed object with `Lifecycle.use()` before use. Scheduler
starts Lifecycle automatically when its asynchronous API is entered. It
publishes `schedule:*` events through Lifecycle's best-effort event bus. A plain
Lifecycle Object writes them to the existing `agents:schedule` diagnostics
channel; `Agent` sends them through its existing observability implementation.

#### set()

```typescript
async set(when, callback, payload?, options?): Promise<Schedule<Payload>>
```

Create a one-shot or cron schedule. `when`, `options`, idempotency, and return
value follow [`schedule()`](#schedule) below. `callback` must be a name
registered in the constructor's `callbacks` map, and `payload` is typed
against that callback's first parameter.

#### every()

```typescript
async every(intervalSeconds, callback, payload?, options?): Promise<Schedule<Payload>>
```

Create a fixed-interval schedule. Semantics follow
[`scheduleEvery()`](#scheduleevery) below, and `every()` also accepts
`options.idempotent` to opt out of interval dedup.

#### get() / list() / cancel()

```typescript
async get(id): Promise<Schedule<unknown> | undefined>
async list(criteria?): Promise<Schedule<unknown>[]>
async cancel(id): Promise<boolean>
```

Read and cancel schedules — the primitive's equivalents of
[`getScheduleById()`](#getschedulebyid), [`listSchedules()`](#listschedules),
and [`cancelSchedule()`](#cancelschedule) below. (Internal synchronous
variants on the Scheduler back Agent's deprecated `getSchedule()` and
`getSchedules()`; they are not part of the primitive's contract.)

### Agent methods

Methods on the `Agent` class, delegating to `this.scheduler`. Callback names
resolve to methods on the Agent.

#### schedule()

```typescript
async schedule<T = string>(
  when: Date | string | number,
  callback: keyof this,
  payload?: T,
  options?: { retry?: RetryOptions; idempotent?: boolean }
): Promise<Schedule<T>>
```

Schedule a task for future execution.

**Parameters:**

- `when` - When to execute: `number` (seconds delay), `Date` (specific time), or `string` (cron expression)
- `callback` - Name of the method to call
- `payload` - Data to pass to the callback (must be JSON-serializable)
- `options.retry` - Optional retry configuration. See [Retries](./retries.md) for details.
- `options.idempotent` - Deduplicate by callback + payload. Defaults to `true` for cron schedules, `false` for delayed and Date-based schedules.

**Returns:** A `Schedule` object with the task details

**Idempotency:**

Cron schedules are idempotent by default — calling `schedule("0 * * * *", "tick")` multiple times with the same callback, cron expression, and payload returns the existing schedule instead of creating a duplicate. Set `idempotent: false` to override this.

For delayed and Date-based schedules, set `idempotent: true` to opt in to the same dedup behavior (matched on callback + payload). This is especially useful when calling `schedule()` in `onStart()` to avoid accumulating duplicate rows across Durable Object restarts:

```typescript
class MyAgent extends Agent {
  async onStart() {
    // Without idempotent: true, this creates a new row on every DO restart
    await this.schedule(3600, "hourlyCleanup", {}, { idempotent: true });
  }
}
```

#### scheduleEvery()

```typescript
async scheduleEvery<T = string>(
  intervalSeconds: number,
  callback: keyof this,
  payload?: T,
  options?: { retry?: RetryOptions }
): Promise<Schedule<T>>
```

Schedule a task to run repeatedly at a fixed interval. Idempotent by design
(the primitive's `every()` accepts `options.idempotent` to opt out).

**Parameters:**

- `intervalSeconds` - Number of seconds between executions (must be > 0)
- `callback` - Name of the method to call
- `payload` - Data to pass to the callback (must be JSON-serializable)
- `options.retry` - Optional retry configuration. See [Retries](./retries.md) for details.

**Returns:** A `Schedule` object with `type: "interval"`

**Behavior:**

- **Idempotent on (callback, interval, payload)** — calling with the same callback, interval, and payload returns the existing schedule instead of creating a duplicate. A different interval or payload creates a new, independent schedule.
- First execution occurs after `intervalSeconds` (not immediately)
- If callback is still running when next execution is due, it's skipped (overlap prevention)
- If callback throws an error, the interval continues
- Cancel with `cancelSchedule(id)` to stop the entire interval

#### getScheduleById()

```typescript
async getScheduleById(id: string): Promise<Schedule<unknown> | undefined>
```

Get a scheduled task by ID. This method works in both top-level agents and sub-agents.

#### listSchedules()

```typescript
async listSchedules(criteria?: {
  id?: string;
  type?: "scheduled" | "delayed" | "cron" | "interval";
  timeRange?: { start?: Date; end?: Date };
}): Promise<Schedule<unknown>[]>
```

Get scheduled tasks matching the criteria. This method works in both top-level agents and sub-agents.

#### getSchedule()

```typescript
getSchedule<T = string>(id: string): Schedule<T> | undefined
```

Deprecated. Get a scheduled task by ID synchronously. This method only works in top-level agents; use `await this.getScheduleById(id)` instead.

#### getSchedules()

```typescript
getSchedules<T = string>(criteria?: {
  id?: string;
  type?: "scheduled" | "delayed" | "cron" | "interval";
  timeRange?: { start?: Date; end?: Date };
}): Schedule<T>[]
```

Deprecated. Get scheduled tasks matching the criteria synchronously. This method only works in top-level agents; use `await this.listSchedules(criteria)` instead.

#### cancelSchedule()

```typescript
async cancelSchedule(id: string): Promise<boolean>
```

Cancel a scheduled task. Returns `true` if cancelled, `false` if not found.

#### keepAlive()

```typescript
async keepAlive(): Promise<() => void>
```

Create an alarm-backed heartbeat that prevents the Durable Object from being evicted due to inactivity. Returns a disposer function that cancels the heartbeat when called. The disposer is idempotent — calling it multiple times is safe.

See [Keeping the Agent Alive](#keeping-the-agent-alive) for usage details.

#### keepAliveWhile()

```typescript
async keepAliveWhile<T>(fn: () => Promise<T>): Promise<T>
```

Run an async function while keeping the Durable Object alive. The heartbeat is automatically started before the function runs and stopped when it completes (whether it succeeds or throws). Returns the value returned by the function.

This is the recommended way to use keepAlive — it guarantees cleanup.

## Limits

- **Maximum tasks:** Limited by SQLite storage (each task is a row). Practical limit is tens of thousands per agent.
- **Task size:** Each task (including payload) can be up to 2MB.
- **Minimum delay:** 0 seconds (runs on next alarm tick)
- **Cron precision:** Minute-level (not seconds)
- **Interval precision:** Second-level
- **Cron jobs:** After execution, automatically rescheduled for the next occurrence
- **Interval jobs:** After execution, rescheduled for `now + intervalSeconds`; skipped if still running
