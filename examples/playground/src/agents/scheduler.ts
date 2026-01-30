import type { Connection, ConnectionContext, Schedule } from "agents";
import { Agent } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { generateObject } from "ai";
import { model } from "../model";
import type {
  IncomingMessage,
  OutgoingMessage,
  ScheduledItem
} from "../shared";

function convertScheduleToScheduledItem(schedule: Schedule): ScheduledItem {
  return {
    description: schedule.payload,
    id: schedule.id,
    nextTrigger: new Date(schedule.time * 1000).toISOString(),
    trigger:
      schedule.type === "delayed"
        ? `in ${schedule.delayInSeconds} seconds`
        : schedule.type === "cron"
          ? `at ${schedule.cron}`
          : `at ${new Date(schedule.time * 1000).toISOString()}`,
    type: schedule.type
  };
}

export class Scheduler extends Agent<Env> {
  onConnect(
    connection: Connection,
    _ctx: ConnectionContext
  ): void | Promise<void> {
    connection.send(JSON.stringify(this.getSchedules()));
  }
  async onMessage(connection: Connection, message: string): Promise<void> {
    const event = JSON.parse(message) as IncomingMessage;
    if (event.type === "schedule") {
      const result = await generateObject({
        maxRetries: 5,
        model,
        prompt: `${getSchedulePrompt({
          date: new Date()
        })} 
Input to parse: "${event.input}"`,
        providerOptions: {
          openai: { strictJsonSchema: false }
        },
        schema: scheduleSchema, // <- the shape of the object that the scheduler expects
        schemaDescription: "A task to be scheduled",
        schemaName: "task"
      });
      const { when, description } = result.object;
      if (when.type === "no-schedule") {
        connection.send(
          JSON.stringify({
            data: `No schedule provided for ${event.input}`,
            type: "error"
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
          data: convertScheduleToScheduledItem(schedule),
          type: "schedule"
        } satisfies OutgoingMessage)
      );
    } else if (event.type === "delete-schedule") {
      await this.cancelSchedule(event.id);
    }
  }

  async onTask(_payload: unknown, schedule: Schedule<string>) {
    this.broadcast(
      JSON.stringify({
        data: convertScheduleToScheduledItem(schedule),
        type: "run-schedule"
      } satisfies OutgoingMessage)
    );
  }
}
