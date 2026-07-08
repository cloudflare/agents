import { Agent } from "..";
import {
  AgentScheduler,
  getSchedulePrompt,
  scheduleSchema,
  type ParsedSchedule,
  type Schedule,
  type ScheduleCriteria
} from "../schedules";
import {
  getSchedulePrompt as legacyGetSchedulePrompt,
  type Schedule as LegacyParsedSchedule
} from "../schedule";

class SchedulerConfiguredAgent extends Agent {
  override schedules: AgentScheduler = new AgentScheduler(this);

  async reminder(): Promise<void> {}
}

const agent = new SchedulerConfiguredAgent({} as DurableObjectState, {});
agent.schedules satisfies AgentScheduler;
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

// @ts-expect-error AgentScheduler is owned by an Agent lifecycle host
new AgentScheduler({} as DurableObjectStorage);
