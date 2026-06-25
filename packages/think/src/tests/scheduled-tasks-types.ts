import type { ThinkScheduledTasks } from "../think";

const validScheduledTasks = {
  interval: {
    schedule: "every 5 minutes",
    prompt: "Run interval task"
  },
  wallClockWithTimezone: {
    schedule: "every day at 09:00",
    timezone: "UTC",
    prompt: "Run wall-clock task"
  },
  wallClockWithDefaultTimezone: {
    schedule: "every day at 10:00",
    prompt: "Valid when getDefaultTimezone() is provided by the agent"
  },
  wallClockInlineTimezone: {
    schedule: "every weekday at 09:00 in Europe/London",
    prompt: "Run inline timezone task"
  },
  handler: {
    schedule: "every 1 hour",
    handler: (ctx) => {
      const idempotencyKey: string = ctx.idempotencyKey;
      const scheduledFor: number = ctx.scheduledFor;
      const scheduleKind: "interval" | "wall-clock" = ctx.scheduleKind;
      const timezone: string | undefined = ctx.timezone;
      void idempotencyKey;
      void scheduledFor;
      void scheduleKind;
      void timezone;
    }
  }
} satisfies ThinkScheduledTasks;

void validScheduledTasks;

({
  invalidTime: {
    // @ts-expect-error obvious invalid literal times are rejected
    schedule: "every day at 25:00",
    timezone: "UTC",
    prompt: "Invalid time"
  }
}) satisfies ThinkScheduledTasks;

({
  // @ts-expect-error intervals do not accept timezone
  intervalWithTimezone: {
    schedule: "every 5 minutes",
    timezone: "UTC",
    prompt: "Interval with timezone"
  }
}) satisfies ThinkScheduledTasks;

({
  // @ts-expect-error scheduled tasks must define prompt or handler, not both
  promptAndHandler: {
    schedule: "every 5 minutes",
    prompt: "Run prompt",
    handler: () => {}
  }
}) satisfies ThinkScheduledTasks;
