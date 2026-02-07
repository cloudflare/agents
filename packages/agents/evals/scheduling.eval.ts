// import { anthropic } from "@ai-sdk/anthropic";
// import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { createScorer, evalite } from "evalite";
import {
  type Schedule,
  getSchedulePrompt,
  scheduleSchema
} from "../src/schedule";

const model = openai("gpt-4o");
// const model = google("gemini-2.0-pro-exp-02-05");
// const model = google("gemini-2.0-flash");
// const model = google("gemini-1.5-pro");
// const model = anthropic("claude-3-5-sonnet-20240620"); // also disable mode: "json"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

// scorers
const getsType = createScorer<string, Schedule>({
  description: "Checks if the output is the right type",
  name: "getsType",
  scorer: ({ output, expected }) => {
    return output.when.type === expected?.when.type ? 1 : 0;
  }
});

const getsDetail = createScorer<string, Schedule>({
  description: "Checks if the output is the right detail",
  name: "getsDetail",
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
  }
});

const getsDescription = createScorer<string, Schedule>({
  description: "Checks if the output is the right description",
  name: "getsDescription",
  scorer: ({ input: _input, output, expected }) => {
    return output.description.toLowerCase() ===
      expected?.description.toLowerCase()
      ? 1
      : 0;
  }
});

evalite<string, Schedule>("Evals for scheduling", {
  // A function that returns an array of test data
  data: async () => {
    return [
      {
        expected: {
          description: "jump",
          when: { delayInSeconds: 6, type: "delayed" }
        },
        input: "jump in 6 seconds"
      },
      {
        expected: {
          description: "meeting with team",
          when: {
            date: (() => {
              const date = new Date();
              date.setDate(date.getDate() + 1);
              date.setHours(14, 0, 0, 0);
              return date;
            })(),
            type: "scheduled"
          }
        },
        input: "meeting with team at 2pm tomorrow"
      },
      {
        expected: {
          description: "run backup",
          when: { cron: "0 0 * * *", type: "cron" }
        },
        input: "run backup every day at midnight"
      },
      {
        expected: {
          description: "send report",
          when: { delayInSeconds: 1800, type: "delayed" }
        },
        input: "send report in 30 minutes"
      },
      {
        expected: {
          description: "weekly team sync",
          when: { cron: "0 10 * * 1", type: "cron" }
        },
        input: "weekly team sync every Monday at 10am"
      },
      {
        expected: {
          description: "just a task without timing",
          when: { type: "no-schedule" }
        },
        input: "just a task without timing"
      },
      {
        expected: {
          description: "quarterly review",
          when: {
            date: new Date(new Date().getFullYear(), 2, 15, 9, 0, 0, 0),
            type: "scheduled"
          }
        },
        input: "quarterly review on March 15th at 9am"
      },
      {
        expected: {
          description: "clean database",
          when: { cron: "0 3 * * 0", type: "cron" }
        },
        input: "clean database every Sunday at 3am"
      },
      {
        expected: {
          description: "process data",
          when: { cron: "*/5 * * * *", type: "cron" }
        },
        input: "process data every 5 minutes"
      },
      {
        expected: {
          description: "run maintenance",
          when: { cron: "0 2 1 * *", type: "cron" }
        },
        input: "run maintenance at 2am every first day of month"
      },
      {
        expected: {
          description: "send reminder",
          when: { delayInSeconds: 7200, type: "delayed" }
        },
        input: "send reminder in 2 hours"
      },
      {
        expected: {
          description: "team meeting",
          when: {
            date: (() => {
              const date = new Date();
              const daysUntilFriday = (5 - date.getDay() + 7) % 7;
              date.setDate(date.getDate() + daysUntilFriday);
              date.setHours(15, 30, 0, 0);
              return date;
            })(),
            type: "scheduled"
          }
        },
        input: "team meeting next Friday at 3:30pm"
      },
      {
        expected: {
          description: "backup database",
          when: { cron: "0 */6 * * *", type: "cron" }
        },
        input: "backup database every 6 hours"
      },
      {
        expected: {
          description: "generate report",
          when: { cron: "0 9 * * 1-5", type: "cron" }
        },
        input: "generate report every weekday at 9am"
      },
      {
        expected: {
          description: "check system",
          when: { delayInSeconds: 15, type: "delayed" }
        },
        input: "check system in 15 seconds"
      },
      {
        expected: {
          description: "update cache",
          when: { cron: "*/30 9-17 * * 1-5", type: "cron" }
        },
        input: "update cache every 30 minutes during business hours"
      },
      {
        expected: {
          description: "archive logs",
          when: { cron: "0 0 * * 0,6", type: "cron" }
        },
        input: "archive logs at midnight on weekends"
      },
      {
        expected: {
          description: "sync data",
          when: { delayInSeconds: 3600, type: "delayed" }
        },
        input: "sync data in 1 hour"
      },
      {
        expected: {
          description: "run health check",
          when: { cron: "*/10 9-17 * * 1-5", type: "cron" }
        },
        input: "run health check every 10 minutes during work hours"
      },
      {
        expected: {
          description: "send daily digest",
          when: { cron: "0 8 * * 1-5", type: "cron" }
        },
        input: "send daily digest at 8am on weekdays"
      },
      {
        expected: {
          description: "process invoices",
          when: { cron: "*/15 9-17 * * 1-5", type: "cron" }
        },
        input: "process invoices every 15 minutes during business hours"
      },
      {
        expected: {
          description: "run backup",
          when: { cron: "0 1,13 * * *", type: "cron" }
        },
        input: "run backup at 1am and 1pm every day"
      },
      {
        expected: {
          description: "check system status",
          when: { delayInSeconds: 45, type: "delayed" }
        },
        input: "check system status in 45 seconds"
      },
      {
        expected: {
          description: "generate monthly report",
          when: { cron: "0 6 1 * *", type: "cron" }
        },
        input: "generate monthly report on the 1st at 6am"
      },
      {
        expected: {
          description: "clean temp files",
          when: { cron: "0 */2 * * *", type: "cron" }
        },
        input: "clean temp files every 2 hours"
      },
      {
        expected: {
          description: "sync data",
          when: { cron: "0 9,17 * * 1-5", type: "cron" }
        },
        input: "sync data at 9am and 5pm on weekdays"
      },
      {
        expected: {
          description: "run maintenance",
          when: { cron: "0 3 * * 0,6", type: "cron" }
        },
        input: "run maintenance at 3am on weekends"
      },
      {
        expected: {
          description: "archive old data",
          when: { cron: "0 0 28-31 * *", type: "cron" }
        },
        input: "archive old data at midnight on the last day of each month"
      },
      {
        expected: {
          description: "send notification",
          when: { delayInSeconds: 10800, type: "delayed" }
        },
        input: "send notification in 3 hours"
      },
      {
        expected: {
          description: "run diagnostics",
          when: { cron: "0 2 * * 1-5", type: "cron" }
        },
        input: "run diagnostics at 2am on weekdays"
      },
      {
        expected: {
          description: "process logs",
          when: { cron: "*/30 9-17 * * 1-5", type: "cron" }
        },
        input: "process logs every 30 minutes during business hours"
      }
    ];
  },
  scorers: [getsType, getsDetail, getsDescription],
  // The task to perform
  task: async (input) => {
    try {
      const result = await generateObject({
        maxRetries: 5,
        model, // <- the shape of the object that the scheduler expects
        providerOptions: {
          openai: { strictJsonSchema: false }
        },
        prompt: `${getSchedulePrompt({ date: new Date() })}
      
Input to parse: "${input}"`,
        // mode: "json",
        // schemaName: "task",
        // schemaDescription: "A task to be scheduled",
        schema: scheduleSchema
      });
      return result.object;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }
});
