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
    callbacks: {
      reminder: (
        payload: { message: string },
        schedule: Schedule<{ message: string }>
      ): void => {
        void payload;
        void schedule;
      }
    }
  });
  readonly lifecycle = Lifecycle.install(this).use(this.scheduler);
}

class SchedulerAgent extends Agent {
  async reminder(): Promise<void> {}
}

declare const object: ScheduledObject;
object.scheduler satisfies DurableObjectCapability;
// Registered callbacks type both the name and the payload where they are
// declared and where they are scheduled.
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
// @ts-expect-error missingCallback is not a registered callback.
object.scheduler.set(1, "missingCallback", {});

// A Scheduler constructed without callbacks is string-typed: any name
// compiles, and names resolve at runtime against the installed host.
const untypedScheduler = new Scheduler();
untypedScheduler.set(1, "anyCallbackName", { free: true }) satisfies Promise<
  Schedule<unknown>
>;

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

// Legacy `agents/schedule` Schedule stays assignable to ParsedSchedule.
null as unknown as LegacyParsedSchedule satisfies ParsedSchedule;
