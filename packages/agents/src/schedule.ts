/**
 * @deprecated Import schedule parsing helpers from `agents/schedules/parser`.
 * This compatibility entry point will be removed in a future major release.
 */
export { getSchedulePrompt, scheduleSchema } from "./schedules/parser";
/**
 * @deprecated Import `ParsedSchedule` from `agents/schedules/parser`.
 */
export type { ParsedSchedule as Schedule } from "./schedules/parser";

import { getSchedulePrompt, scheduleSchema } from "./schedules/parser";

let didWarnAboutUnstableGetSchedulePrompt = false;

/**
 * @deprecated this has been renamed to getSchedulePrompt, and unstable_getSchedulePrompt will be removed in the next major version
 * @param event - The event to get the schedule prompt for
 * @returns The schedule prompt
 */
export function unstable_getSchedulePrompt(event: { date: Date }) {
  if (!didWarnAboutUnstableGetSchedulePrompt) {
    didWarnAboutUnstableGetSchedulePrompt = true;
    console.warn(
      "unstable_getSchedulePrompt is deprecated, use getSchedulePrompt instead. unstable_getSchedulePrompt will be removed in the next major version."
    );
  }
  return getSchedulePrompt(event);
}

/**
 * @deprecated this has been renamed to scheduleSchema, and unstable_scheduleSchema will be removed in the next major version
 * @returns The schedule schema
 */
export const unstable_scheduleSchema = scheduleSchema;
