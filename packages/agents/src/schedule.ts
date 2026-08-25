/**
 * @deprecated Import schedule parsing helpers from `agents/schedules/parser`.
 * This compatibility entry point will be removed in a future major release.
 */
export {
  getSchedulePrompt,
  scheduleSchema,
  unstable_getSchedulePrompt,
  unstable_scheduleSchema
} from "./schedules/parser";
export type { ParsedSchedule as Schedule } from "./schedules/parser";
