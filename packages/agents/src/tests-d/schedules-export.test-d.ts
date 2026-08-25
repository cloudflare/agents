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
  readonly scheduler = new Scheduler({
    callbacks: this,
    storage: this.ctx.storage,
    now: Date.now,
    createId: () => crypto.randomUUID()
  });
  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);

  reminder(): void {}
}

class SchedulerAgent extends Agent {
  async reminder(): Promise<void> {}
}

declare const object: ScheduledObject;
object.scheduler satisfies Scheduler;
object.scheduler satisfies DurableObjectCapability;
object.scheduler.schedule(1, "reminder") satisfies Promise<Schedule<string>>;
object.scheduler.scheduleEvery(60, "reminder", undefined, {
  idempotent: false
});

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

// @ts-expect-error Scheduler requires explicit host, storage, clock, and ID dependencies.
new Scheduler({});
