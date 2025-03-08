import { evalite, createScorer } from "evalite";
// import { Factuality, Levenshtein } from "autoevals";
// import { traceAISDKModel } from "evalite/ai-sdk";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

function getPrompt(event: { date: Date; input: string }) {
  return `
Today is ${event.date.toUTCString()}.
You are given a string that has a string and probably has a date/time/cron pattern to be input as an object into a scheduler. 
- Do not include the schedule details in the description. 
- Use numbers for days in cron patterns.

Here is the string:
${event.input}
`;
}

const getsType = createScorer<string, Schedule>({
  name: "getsType",
  description: "Checks if the output is the right type",
  scorer: ({ input, output, expected }) => {
    return output.when.type === expected?.when.type ? 1 : 0;
  },
});

const getsDetail = createScorer<string, Schedule>({
  name: "getsDetail",
  description: "Checks if the output is the right detail",
  scorer: ({ input, output, expected }) => {
    switch (expected?.when.type) {
      case "scheduled":
        return output.when.date.getTime() === expected.when.date.getTime()
          ? 1
          : 0;
      case "delayed":
        return output.when.delayInSeconds === expected.when.delayInSeconds
          ? 1
          : 0;
      case "cron":
        return output.when.cron === expected.when.cron ? 1 : 0;

      case "no-schedule":
        return 1;
      default:
        return 0;
    }
  },
});

const getsDescription = createScorer<string, Schedule>({
  name: "getsDescription",
  description: "Checks if the output is the right description",
  scorer: ({ input, output, expected }) => {
    return output.description === expected?.description ? 1 : 0;
  },
});

const scheduleSchema = z.object({
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

type Schedule = z.infer<typeof scheduleSchema>;

evalite<string, Schedule>("Evals for scheduling", {
  // A function that returns an array of test data
  // - TODO: Replace with your test data
  data: async () => {
    return [
      {
        input: "jump in 6 seconds",
        expected: {
          description: "jump",
          when: { type: "delayed", delayInSeconds: 6 },
        },
      },
      {
        input: "meeting with team at 2pm tomorrow",
        expected: {
          description: "meeting with team",
          when: {
            type: "scheduled",
            date: (() => {
              const date = new Date();
              date.setDate(date.getDate() + 1);
              date.setHours(14, 0, 0, 0);
              return date;
            })(),
          },
        },
      },
      {
        input: "run backup every day at midnight",
        expected: {
          description: "run backup",
          when: { type: "cron", cron: "0 0 * * *" },
        },
      },
      {
        input: "send report in 30 minutes",
        expected: {
          description: "send report",
          when: { type: "delayed", delayInSeconds: 1800 },
        },
      },
      {
        input: "weekly team sync every Monday at 10am",
        expected: {
          description: "weekly team sync",
          when: { type: "cron", cron: "0 10 * * 1" },
        },
      },
      {
        input: "just a task without timing",
        expected: {
          description: "just a task without timing",
          when: { type: "no-schedule" },
        },
      },
      {
        input: "quarterly review on March 15th at 9am",
        expected: {
          description: "quarterly review",
          when: {
            type: "scheduled",
            date: new Date(new Date().getFullYear(), 2, 15, 9, 0, 0, 0),
          },
        },
      },
      {
        input: "clean database every Sunday at 3am",
        expected: {
          description: "clean database",
          when: { type: "cron", cron: "0 3 * * 0" },
        },
      },
      {
        input: "process data every 5 minutes",
        expected: {
          description: "process data",
          when: { type: "cron", cron: "*/5 * * * *" },
        },
      },
      {
        input: "run maintenance at 2am every first day of month",
        expected: {
          description: "run maintenance",
          when: { type: "cron", cron: "0 2 1 * *" },
        },
      },
      {
        input: "send reminder in 2 hours",
        expected: {
          description: "send reminder",
          when: { type: "delayed", delayInSeconds: 7200 },
        },
      },
      {
        input: "team meeting next Friday at 3:30pm",
        expected: {
          description: "team meeting",
          when: {
            type: "scheduled",
            date: (() => {
              const date = new Date();
              const daysUntilFriday = (5 - date.getDay() + 7) % 7;
              date.setDate(date.getDate() + daysUntilFriday);
              date.setHours(15, 30, 0, 0);
              return date;
            })(),
          },
        },
      },
      {
        input: "backup database every 6 hours",
        expected: {
          description: "backup database",
          when: { type: "cron", cron: "0 */6 * * *" },
        },
      },
      {
        input: "generate report every weekday at 9am",
        expected: {
          description: "generate report",
          when: { type: "cron", cron: "0 9 * * 1-5" },
        },
      },
      {
        input: "check system in 15 seconds",
        expected: {
          description: "check system",
          when: { type: "delayed", delayInSeconds: 15 },
        },
      },
      {
        input: "update cache every 30 minutes during business hours",
        expected: {
          description: "update cache",
          when: { type: "cron", cron: "*/30 9-17 * * 1-5" },
        },
      },
      {
        input: "archive logs at midnight on weekends",
        expected: {
          description: "archive logs",
          when: { type: "cron", cron: "0 0 * * 0,6" },
        },
      },
      {
        input: "sync data in 1 hour",
        expected: {
          description: "sync data",
          when: { type: "delayed", delayInSeconds: 3600 },
        },
      },
      {
        input: "run health check every 10 minutes during work hours",
        expected: {
          description: "run health check",
          when: { type: "cron", cron: "*/10 9-17 * * 1-5" },
        },
      },
    ];
  },
  // The task to perform
  // - TODO: Replace with your LLM call
  task: async (input) => {
    const result = await generateObject({
      model: openai("gpt-4o"),
      mode: "json",
      schemaName: "task",
      schemaDescription: "A task to be scheduled",
      schema: scheduleSchema, // <- the shape of the object that the scheduler expects
      maxRetries: 5,
      prompt: getPrompt({ date: new Date(), input }),
    });
    return result.object;
  },
  scorers: [getsType, getsDetail, getsDescription],
});
