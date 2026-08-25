import { DurableObject } from "cloudflare:workers";
import { Agent } from "..";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import { Scheduler, type Schedule, type ScheduleCriteria } from "../schedules";
import {
  getSchedulePrompt,
  scheduleSchema,
  type ParsedSchedule
} from "../schedules/parser";
import {
  getSchedulePrompt as legacyGetSchedulePrompt,
  type Schedule as LegacyParsedSchedule
} from "../schedule";

class ScheduledObject extends DurableObject {
  readonly scheduler = new Scheduler(this);
  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  reminder(payload: { message: string }): void {
    void payload;
  }
}

class SchedulerAgent extends Agent {
  async reminder(): Promise<void> {}
}

declare const object: ScheduledObject;
object.scheduler satisfies Scheduler;
object.scheduler satisfies DurableObjectCapability;
object.scheduler.set(1, "reminder", {
  message: "hello"
}) satisfies Promise<Schedule<{ message: string }>>;
object.scheduler.every(
  60,
  "reminder",
  { message: "hello" },
  {
    idempotent: false
  }
);
// @ts-expect-error reminder requires a string message.
object.scheduler.set(1, "reminder", { message: 123 });
// @ts-expect-error missingCallback is not a method on the target.
object.scheduler.set(1, "missingCallback", {});

declare const agent: SchedulerAgent;
agent.scheduler satisfies Scheduler;
agent.scheduler satisfies DurableObjectCapability;
agent.schedule(1, "reminder") satisfies Promise<Schedule<string>>;
agent.getSchedules({ type: "delayed" } satisfies ScheduleCriteria);

scheduleSchema.parse({
  description: "send reminder",
  when: { type: "delayed", delayInSeconds: 60 }
}) satisfies ParsedSchedule;

getSchedulePrompt({ date: new Date() }) satisfies string;
legacyGetSchedulePrompt({ date: new Date() }) satisfies string;

type _LegacyParserCompatibility = LegacyParsedSchedule extends ParsedSchedule
  ? true
  : false;

// @ts-expect-error Scheduler requires a Lifecycle Object callback target.
new Scheduler({});
