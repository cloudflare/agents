import { z } from "zod";

export type Schedule = z.infer<typeof unstable_scheduleSchema>;

export function unstable_getSchedulePrompt(event: { date: Date }) {
  return `
[Schedule Parser Component]

Current time: ${event.date.toUTCString()}

This component parses natural language scheduling requests into a structured format. It extracts:
1. A clean task description (without timing information)
2. Scheduling details in one of these formats:
   - scheduled: Specific date/time events
   - delayed: Relative time delays (in seconds)
   - cron: Recurring patterns
   - no-schedule: Tasks without timing

Rules:
- Task descriptions should be clean and focused on the action
- Use numbers (0-6) for days in cron patterns (0=Sunday)
- For recurring tasks, use standard cron syntax
- For relative times, convert to seconds
- For specific dates, use the current time as reference

Example outputs:
{
  "description": "meeting with team",
  "when": {
    "type": "scheduled",
    "date": "tomorrow at 14:00"
  }
}

{
  "description": "backup database",
  "when": {
    "type": "cron",
    "cron": "0 0 * * *"
  }
}

{
  "description": "send report",
  "when": {
    "type": "delayed",
    "delayInSeconds": 1800
  }
}

[End Schedule Parser Component]
`;
}

export const unstable_scheduleSchema = z.object({
  description: z.string().describe("A description of the task"),
  when: z.object({
    type: z
      .enum(["scheduled", "delayed", "cron", "no-schedule"])
      .describe("The type of scheduling details"),
    date: z.coerce
      .date()
      .optional()
      .describe(
        "execute task at the specified date and time (only use if the type is scheduled)"
      ),
    delayInSeconds: z
      .number()
      .optional()
      .describe(
        "execute task after a delay in seconds (only use if the type is delayed)"
      ),
    cron: z
      .string()
      .optional()
      .describe(
        "execute task on a recurring interval specified as cron syntax (only use if the type is cron)"
      ),
  }),
});
