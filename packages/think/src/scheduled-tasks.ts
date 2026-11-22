/**
 * Think's code-declared scheduled tasks, mapped onto the Scheduler's
 * declared schedules. A `prompt` task becomes a durable submission; a
 * `handler` task runs the handler.
 */

import type { UIMessage } from "ai";
import type { RetryOptions } from "agents";
import type {
  DeclaredSchedule,
  DeclaredScheduleContext,
  DeclaredScheduleExpression,
  DeclaredSchedules
} from "agents/internal";

// Think's public schedule types are its own, written out, so its published
// types never name the internal declared-schedule types they match.
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type Hour = `0${Digit}` | `1${Digit}` | "20" | "21" | "22" | "23";
type Minute = `${"0" | "1" | "2" | "3" | "4" | "5"}${Digit}`;
export type ThinkTime = `${Hour}:${Minute}`;
export type ThinkIntervalSchedule =
  | `every ${number} minute${"" | "s"}`
  | `every ${number} hour${"" | "s"}`;
export type ThinkWallClockSchedule =
  | `every day at ${ThinkTime}`
  | `every weekday at ${ThinkTime}`
  | `every week on ${string} at ${ThinkTime}`;
export type ThinkScheduledTaskSchedule =
  | ThinkIntervalSchedule
  | ThinkWallClockSchedule
  | `${ThinkWallClockSchedule} in ${string}`;

export type ThinkScheduledTaskContext = {
  taskId: string;
  scheduledFor: number;
  scheduledForDate: Date;
  occurrenceKey: string;
  idempotencyKey: string;
  schedule: string;
  scheduleKind: "interval" | "wall-clock";
  timezone?: string;
  metadata?: Record<string, unknown>;
};

// The two sets of types must stay the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _sameSchedule: Same<
  ThinkScheduledTaskSchedule,
  DeclaredScheduleExpression
> = true;
const _sameContext: Same<
  ThinkScheduledTaskContext,
  Omit<DeclaredScheduleContext, "name"> & { taskId: string }
> = true;
void _sameSchedule;
void _sameContext;

type ThinkScheduledTaskPromptAction = {
  prompt: string | (() => string | Promise<string>);
  handler?: never;
};

type ThinkScheduledTaskHandlerAction = {
  handler: (ctx: ThinkScheduledTaskContext) => void | Promise<void>;
  prompt?: never;
};

type ThinkScheduledTaskBase = (
  | ThinkScheduledTaskPromptAction
  | ThinkScheduledTaskHandlerAction
) & {
  retry?: RetryOptions;
  metadata?: Record<string, unknown>;
};

export type ThinkScheduledTask =
  | (ThinkScheduledTaskBase & {
      schedule: ThinkIntervalSchedule;
      timezone?: never;
    })
  | (ThinkScheduledTaskBase & {
      schedule: ThinkWallClockSchedule;
      timezone?: string;
    })
  | (ThinkScheduledTaskBase & {
      schedule: `${ThinkWallClockSchedule} in ${string}`;
      timezone?: string;
    });

export type ThinkScheduledTasks = Record<string, ThinkScheduledTask>;

/** Submits a scheduled prompt, as `Think.submitMessages()` does. */
type SubmitScheduledPrompt = (
  messages: UIMessage[],
  options: { idempotencyKey: string; metadata: Record<string, unknown> }
) => Promise<unknown>;

/**
 * Map Think's task declaration onto Scheduler declared schedules.
 * `ownerKey` identifies this agent in submission metadata.
 */
export function toDeclaredSchedules(
  tasks: ThinkScheduledTasks,
  ownerKey: string,
  submit: SubmitScheduledPrompt
): DeclaredSchedules {
  // fromEntries defines every name as an own property, `__proto__` included.
  return Object.fromEntries(
    Object.entries(tasks).map(([taskId, task]) => {
      const hasPrompt = task.prompt !== undefined;
      const hasHandler = task.handler !== undefined;
      if (hasPrompt === hasHandler) {
        throw new Error(
          `Scheduled task "${taskId}" must define exactly one of prompt or handler`
        );
      }
      const declared: DeclaredSchedule = {
        schedule: task.schedule,
        ...(task.timezone !== undefined && { timezone: task.timezone }),
        ...(task.retry !== undefined && { retry: task.retry }),
        ...(task.metadata !== undefined && { metadata: task.metadata }),
        run: async ({ name, ...occurrence }) => {
          if (task.handler) {
            await task.handler({ taskId: name, ...occurrence });
            return;
          }
          const prompt =
            typeof task.prompt === "function"
              ? await task.prompt()
              : task.prompt;
          await submit(
            [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text: prompt ?? "" }]
              }
            ],
            {
              idempotencyKey: occurrence.idempotencyKey,
              metadata: {
                ...task.metadata,
                source: "scheduled-task",
                ownerKey,
                taskId: name,
                scheduledFor: occurrence.scheduledFor,
                schedule: occurrence.schedule
              }
            }
          );
        }
      };
      return [taskId, declared];
    })
  );
}
