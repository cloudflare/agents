import { z } from "zod";

export function unstable_getSchedulePrompt(event: {
  date: Date;
  input: string;
}) {
  return `
[Schedule Parser Component]

Current time: ${event.date.toUTCString()}

Input to parse: "${event.input}"

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
  when: z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("scheduled"),
        date: z.coerce.date(),
      })
      .describe("A scheduled task for a given date and time"),
    z
      .object({
        type: z.literal("delayed"),
        delayInSeconds: z.number(),
      })
      .describe("A delayed task in seconds"),
    z
      .object({
        type: z.literal("cron"),
        cron: z.string(),
      })
      .describe("A cron pattern"),
    z
      .object({
        type: z.literal("no-schedule"),
      })
      .describe("No timing information, just a description of the task"),
  ]),
});
