import { z } from "zod";
import { Agent } from "agents-sdk";
import type { Env } from "../server";
import type { Schedule } from "agents-sdk";

import type {
  ScheduledItem,
  OutgoingMessage,
  IncomingMessage,
} from "../shared";

import type { Connection, ConnectionContext } from "agents-sdk";

import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";

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

function convertScheduleToScheduledItem(schedule: Schedule): ScheduledItem {
  return {
    id: schedule.id,
    trigger:
      schedule.type === "delayed"
        ? `in ${schedule.delayInSeconds} seconds`
        : schedule.type === "cron"
          ? `at ${schedule.cron}`
          : `at ${new Date(schedule.time * 1000).toISOString()}`,
    nextTrigger: new Date(schedule.time * 1000).toISOString(),
    description: schedule.payload,
    type: schedule.type,
  };
}

export class Scheduler extends Agent<Env> {
  openai = createOpenAI({
    apiKey: this.env.OPENAI_API_KEY,
    // baseURL: `https://gateway.ai.cloudflare.com/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/openai`,
    // headers: {
    //   "cf-aig-authorization": `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
    // },
  });
  onConnect(
    connection: Connection,
    ctx: ConnectionContext
  ): void | Promise<void> {
    connection.send(JSON.stringify(this.getSchedules()));
  }
  async onMessage(connection: Connection, message: string): Promise<void> {
    const event = JSON.parse(message) as IncomingMessage;
    if (event.type === "schedule") {
      const result = await generateObject({
        model: this.openai("gpt-4o"),
        mode: "json",
        schemaName: "task",
        schemaDescription: "A task to be scheduled",
        schema: scheduleSchema, // <- the shape of the object that the scheduler expects
        maxRetries: 5,
        prompt: `
Today is ${new Date().toUTCString()}.
You are given a string that has a string and probably has a date/time/cron pattern to be input as an object into a scheduler.

Here is the string:
${event.input}
`,
      });
      const { when, description } = result.object;
      if (when.type === "no-schedule") {
        connection.send(
          JSON.stringify({
            type: "error",
            data: `No schedule provided for ${event.input}`,
          } satisfies OutgoingMessage)
        );
        return;
      }
      const schedule = await this.schedule(
        when.type === "scheduled"
          ? when.date
          : when.type === "delayed"
            ? when.delayInSeconds
            : when.cron,
        "onTask",
        description
      );

      connection.send(
        JSON.stringify({
          type: "schedule",
          data: convertScheduleToScheduledItem(schedule),
        } satisfies OutgoingMessage)
      );
    } else if (event.type === "delete-schedule") {
      await this.cancelSchedule(event.id);
    }
  }

  async onTask(payload: unknown, schedule: Schedule<string>) {
    this.broadcast(
      JSON.stringify({
        type: "run-schedule",
        data: convertScheduleToScheduledItem(schedule),
      } satisfies OutgoingMessage)
    );
  }
}
