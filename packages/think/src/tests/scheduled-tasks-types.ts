import { defineScheduledTasks } from "../think";

const validScheduledTasks = defineScheduledTasks({
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
  }
});

void validScheduledTasks;

defineScheduledTasks({
  invalidTime: {
    // @ts-expect-error obvious invalid literal times are rejected
    schedule: "every day at 25:00",
    timezone: "UTC",
    prompt: "Invalid time"
  }
});

defineScheduledTasks({
  // @ts-expect-error intervals do not accept timezone
  intervalWithTimezone: {
    schedule: "every 5 minutes",
    timezone: "UTC",
    prompt: "Interval with timezone"
  }
});
