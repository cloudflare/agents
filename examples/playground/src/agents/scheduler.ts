import { Agent } from "agents";
import type { Env } from "../server";
import type { Schedule } from "agents";
import {
  unstable_scheduleSchema,
  unstable_getSchedulePrompt,
} from "agents/schedule";

import type {
  ScheduledItem,
  OutgoingMessage,
  IncomingMessage,
} from "../shared";

import type { Connection, ConnectionContext } from "agents";

import { generateObject } from "ai";
import { model } from "../model";

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
        model,
        mode: "json",
        schemaName: "task",
        schemaDescription: "A task to be scheduled",
        schema: unstable_scheduleSchema, // <- the shape of the object that the scheduler expects
        maxRetries: 5,
        prompt: `${unstable_getSchedulePrompt({
          date: new Date(),
        })} 
Input to parse: "${event.input}"`,
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
          ? when.date!
          : when.type === "delayed"
            ? when.delayInSeconds!
            : when.cron!,
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
