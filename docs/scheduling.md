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

## Managing Schedules

### Get a Schedule

Retrieve a scheduled task by its ID:

```typescript
const schedule = await this.getSchedule(scheduleId);

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
const allSchedules = this.getSchedules();

// Get only cron jobs
const cronJobs = this.getSchedules({ type: "cron" });

// Get tasks in the next hour
const upcoming = this.getSchedules({
  timeRange: {
    start: new Date(),
    end: new Date(Date.now() + 60 * 60 * 1000)
  }
});

// Get a specific task by ID
const specific = this.getSchedules({ id: "abc123" });

// Combine filters
const upcomingCronJobs = this.getSchedules({
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
    const schedules = this.getSchedules({ type: "delayed" });
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

The SDK includes utilities for parsing natural language scheduling requests with AI.

### getSchedulePrompt()

Returns a system prompt for parsing natural language into scheduling parameters:

```typescript
import { getSchedulePrompt, scheduleSchema } from "agents";
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
import { scheduleSchema } from "agents";

// The schema shape:
// {
//   description: string,
//   when: {
//     type: "scheduled" | "delayed" | "cron" | "no-schedule",
//     date?: Date,           // for "scheduled"
//     delayInSeconds?: number, // for "delayed"
//     cron?: string          // for "cron"
//   }
// }
```

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

### schedule()

```typescript
async schedule<T = string>(
  when: Date | string | number,
  callback: keyof this,
  payload?: T,
  options?: { retry?: RetryOptions }
): Promise<Schedule<T>>
```

Schedule a task for future execution.

**Parameters:**

- `when` - When to execute: `number` (seconds delay), `Date` (specific time), or `string` (cron expression)
- `callback` - Name of the method to call
- `payload` - Data to pass to the callback (must be JSON-serializable)
- `options.retry` - Optional retry configuration. See [Retries](./retries.md) for details.

**Returns:** A `Schedule` object with the task details

### scheduleEvery()

```typescript
async scheduleEvery<T = string>(
  intervalSeconds: number,
  callback: keyof this,
  payload?: T,
  options?: { retry?: RetryOptions }
): Promise<Schedule<T>>
```

Schedule a task to run repeatedly at a fixed interval.

**Parameters:**

- `intervalSeconds` - Number of seconds between executions (must be > 0)
- `callback` - Name of the method to call
- `payload` - Data to pass to the callback (must be JSON-serializable)
- `options.retry` - Optional retry configuration. See [Retries](./retries.md) for details.

**Returns:** A `Schedule` object with `type: "interval"`

**Behavior:**

- First execution occurs after `intervalSeconds` (not immediately)
- If callback is still running when next execution is due, it's skipped (overlap prevention)
- If callback throws an error, the interval continues
- Cancel with `cancelSchedule(id)` to stop the entire interval

### getSchedule()

```typescript
async getSchedule<T = string>(id: string): Promise<Schedule<T> | undefined>
```

Get a scheduled task by ID.

### getSchedules()

```typescript
getSchedules<T = string>(criteria?: {
  id?: string;
  type?: "scheduled" | "delayed" | "cron" | "interval";
  timeRange?: { start?: Date; end?: Date };
}): Schedule<T>[]
```

Get scheduled tasks matching the criteria.

### cancelSchedule()

```typescript
async cancelSchedule(id: string): Promise<boolean>
```

Cancel a scheduled task. Returns `true` if cancelled, `false` if not found.

## Limits

- **Maximum tasks:** Limited by SQLite storage (each task is a row). Practical limit is tens of thousands per agent.
- **Task size:** Each task (including payload) can be up to 2MB.
- **Minimum delay:** 0 seconds (runs on next alarm tick)
- **Cron precision:** Minute-level (not seconds)
- **Interval precision:** Second-level
- **Cron jobs:** After execution, automatically rescheduled for the next occurrence
- **Interval jobs:** After execution, rescheduled for `now + intervalSeconds`; skipped if still running
