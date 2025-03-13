import { evalite, createScorer } from "evalite";
import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import type { z } from "zod";
import {
  unstable_getSchedulePrompt,
  unstable_scheduleSchema,
  type Schedule,
} from "../src/schedule";

//const model = openai("gpt-4o");
//const model = google("gemini-2.0-pro-exp-02-05");
//const model = google("gemini-2.0-flash");
const model = google("gemini-1.5-pro");
//const model = anthropic("claude-3-5-sonnet-20240620"); // also disable mode: "json"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

// scorers
const getsType = createScorer<string, Schedule>({
  name: "getsType",
  description: "Checks if the output is the right type",
  scorer: ({ output, expected }) => {
    return output.when.type === expected?.when.type ? 1 : 0;
  },
});

const getsDetail = createScorer<string, Schedule>({
  name: "getsDetail",
  description: "Checks if the output is the right detail",
  scorer: ({ output, expected }) => {
    switch (expected?.when.type) {
      case "scheduled": {
        assert(
          output.when.type === "scheduled",
          "Output is not a scheduled task"
        );
        return output.when?.date?.getTime() === expected.when?.date?.getTime()
          ? 1
          : 0;
      }
      case "delayed": {
        assert(output.when.type === "delayed", "Output is not a delayed task");
        return output.when.delayInSeconds === expected.when.delayInSeconds
          ? 1
          : 0;
      }
      case "cron": {
        assert(output.when.type === "cron", "Output is not a cron task");
        return output.when.cron === expected.when.cron ? 1 : 0;
      }

      case "no-schedule": {
        assert(
          output.when.type === "no-schedule",
          "Output is not a no-schedule task"
        );
        return 1;
      }
      default:
        return 0;
    }
  },
});

const getsDescription = createScorer<string, Schedule>({
  name: "getsDescription",
  description: "Checks if the output is the right description",
  scorer: ({ input, output, expected }) => {
    return output.description.toLowerCase() ===
      expected?.description.toLowerCase()
      ? 1
      : 0;
  },
});

evalite<string, Schedule>("Evals for scheduling", {
  // A function that returns an array of test data
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
      {
        input: "send daily digest at 8am on weekdays",
        expected: {
          description: "send daily digest",
          when: { type: "cron", cron: "0 8 * * 1-5" },
        },
      },
      {
        input: "process invoices every 15 minutes during business hours",
        expected: {
          description: "process invoices",
          when: { type: "cron", cron: "*/15 9-17 * * 1-5" },
        },
      },
      {
        input: "run backup at 1am and 1pm every day",
        expected: {
          description: "run backup",
          when: { type: "cron", cron: "0 1,13 * * *" },
        },
      },
      {
        input: "check system status in 45 seconds",
        expected: {
          description: "check system status",
          when: { type: "delayed", delayInSeconds: 45 },
        },
      },
      {
        input: "generate monthly report on the 1st at 6am",
        expected: {
          description: "generate monthly report",
          when: { type: "cron", cron: "0 6 1 * *" },
        },
      },
      {
        input: "clean temp files every 2 hours",
        expected: {
          description: "clean temp files",
          when: { type: "cron", cron: "0 */2 * * *" },
        },
      },
      {
        input: "sync data at 9am and 5pm on weekdays",
        expected: {
          description: "sync data",
          when: { type: "cron", cron: "0 9,17 * * 1-5" },
        },
      },
      {
        input: "run maintenance at 3am on weekends",
        expected: {
          description: "run maintenance",
          when: { type: "cron", cron: "0 3 * * 0,6" },
        },
      },
      {
        input: "archive old data at midnight on the last day of each month",
        expected: {
          description: "archive old data",
          when: { type: "cron", cron: "0 0 28-31 * *" },
        },
      },
      {
        input: "send notification in 3 hours",
        expected: {
          description: "send notification",
          when: { type: "delayed", delayInSeconds: 10800 },
        },
      },
      {
        input: "run diagnostics at 2am on weekdays",
        expected: {
          description: "run diagnostics",
          when: { type: "cron", cron: "0 2 * * 1-5" },
        },
      },
      {
        input: "process logs every 30 minutes during business hours",
        expected: {
          description: "process logs",
          when: { type: "cron", cron: "*/30 9-17 * * 1-5" },
        },
      },
    ];
  },
  // The task to perform
  task: async (input) => {
    const result = await generateObject({
      model,
      // mode: "json",
      // schemaName: "task",
      // schemaDescription: "A task to be scheduled",
      schema: unstable_scheduleSchema, // <- the shape of the object that the scheduler expects
      maxRetries: 5,
      prompt: `${unstable_getSchedulePrompt({ date: new Date() })}
      
Input to parse: "${input}"`,
    });
    return result.object;
  },
  scorers: [getsType, getsDetail, getsDescription],
});
