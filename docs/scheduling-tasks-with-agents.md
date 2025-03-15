# Scheduling Tasks with Agents

The `agents-sdk` provides a powerful scheduling system that allows you to schedule tasks for execution at specific times, after a delay, or based on cron expressions. This guide will walk you through the `schedule` method, managing schedules, retrieving scheduled tasks, and canceling them.

## The `schedule` Method

The `schedule` method is used to schedule a task to be executed in the future. It accepts the following parameters:

- `when`: When to execute the task. This can be a `Date` object for a specific time, a number (in seconds) for a delay, or a cron expression for recurring tasks.
- `callback`: The name of the method to call when the task is executed.
- `payload`: Optional data to pass to the callback method.

### Scheduling for a Specific Date

To schedule a task for a specific date and time, pass a `Date` object as the `when` parameter.

```typescript
import { Agent } from "agents-sdk";

export class TimeAwareAgent extends Agent {
  async initialize() {
    // Schedule a task for December 31, 2024
    this.schedule(new Date("2024-12-31"), "yearlyAnalysis");
  }

  async yearlyAnalysis() {
    await this.analyze();
  }
}
```

In this example, the `yearlyAnalysis` method will be called on December 31, 2024. When the agent is initialized, it will schedule the `yearlyAnalysis` function to run at the specified date. See [core-agent-functionality.md] for more information on agent initialization.

### Scheduling with a Delay

To schedule a task to be executed after a delay, pass the number of seconds as the `when` parameter.

```typescript
import { Agent } from "agents-sdk";

export class TimeAwareAgent extends Agent {
  async initialize() {
    // Schedule a task to be executed after 10 seconds
    this.schedule(10, "quickInsight", { focus: "patterns" });
  }

  async quickInsight(data: { focus: string }) {
    await this.analyze(data.focus);
  }
}
```

Here, the `quickInsight` method will be called after 10 seconds, with the payload `{ focus: "patterns" }`.

### Scheduling with Cron Expressions

To schedule a task to be executed based on a cron expression, pass the cron expression as a string to the `when` parameter. Cron expressions define recurring schedules.

```typescript
import { Agent } from "agents-sdk";

export class TimeAwareAgent extends Agent {
  async initialize() {
    // Schedule a task to be executed every day at midnight
    this.schedule("0 0 * * *", "dailySynthesis", { depth: "comprehensive" });
  }

  async dailySynthesis(data: { depth: string }) {
    await this.synthesize(data.depth);
  }
}
```

In this example, the `dailySynthesis` method will be called every day at midnight, with the payload `{ depth: "comprehensive" }`.

#### Cron Syntax

A cron expression is a string that defines a schedule. It consists of five fields, separated by spaces:

```
* * * * *
| | | | |
| | | | +-- Day of the week (0-6, where 0 is Sunday)
| | | +---- Month (1-12)
| | +------ Day of the month (1-31)
| +-------- Hour (0-23)
+---------- Minute (0-59)
```

Each field can contain a specific value, a range of values, or an asterisk (`*`) to indicate all possible values. Here are some common cron examples:

- `0 0 * * *`: Every day at midnight
- `0 * * * *`: Every hour on the hour
- `0 0 * * 0`: Every Sunday at midnight
- `0 9 * * 1-5`: Every weekday at 9:00 AM
- `0 12 1 * *`: The first day of every month at noon

For more information on cron syntax, refer to online resources such as [crontab guru](https://crontab.guru/).

## Managing Schedules

The `agents-sdk` provides methods for retrieving and canceling scheduled tasks.

### Retrieving Scheduled Tasks

You can retrieve scheduled tasks using the `getSchedule` and `getSchedules` methods.

#### `getSchedule`

To retrieve a specific scheduled task by its ID, use the `getSchedule` method:

```typescript
const schedule = await this.getSchedule(scheduleId);
if (schedule) {
  console.log("Scheduled task:", schedule);
}
```

#### `getSchedules`

To retrieve all scheduled tasks, or tasks matching specific criteria, use the `getSchedules` method:

```typescript
// Get all scheduled tasks
const allSchedules = this.getSchedules();
console.log("All scheduled tasks:", allSchedules);

// Get all cron schedules
const cronSchedules = this.getSchedules({ type: "cron" });
console.log("Cron schedules:", cronSchedules);

// Get schedules within a time range
const timeRangeSchedules = this.getSchedules({
  timeRange: { start: new Date("2024-01-01"), end: new Date("2024-12-31") },
});
console.log("Schedules within time range:", timeRangeSchedules);
```

### Canceling Scheduled Tasks

To cancel a scheduled task, use the `cancelSchedule` method, passing the ID of the task to cancel:

```typescript
const cancelled = await this.cancelSchedule(scheduleId);
if (cancelled) {
  console.log("Scheduled task cancelled successfully.");
}
```

## Examples of Scheduling Scenarios

Here are some practical examples of how you can use the scheduling system in `agents-sdk`:

- **Daily Report Generation**: Schedule a task to generate and send a daily report at a specific time.
- **Database Backup**: Schedule a task to back up your database every night.
- **Periodic Data Analysis**: Schedule a task to perform data analysis and update insights on a recurring basis.
- **Reminder Notifications**: Schedule tasks to send reminder notifications to users at specific times.

## Conclusion

The scheduling system in `agents-sdk` provides a flexible and powerful way to schedule tasks for execution at specific times, after a delay, or based on cron expressions. By using the `schedule` method, you can easily automate tasks and build intelligent agents that can perform actions at the right time.
