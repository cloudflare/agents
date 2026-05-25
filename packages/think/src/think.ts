/**
 * Think — an opinionated chat agent base class.
 *
 * Works as both a **top-level agent** (speaking the `cf_agent_chat_*`
 * WebSocket protocol to browser clients) and a **sub-agent** (called
 * via `chat()` over RPC from a parent agent).
 *
 * Each instance gets its own SQLite storage backed by Session — providing
 * tree-structured messages, context blocks, compaction, FTS5 search, and
 * multi-session support.
 *
 * Configuration overrides:
 *   - getModel()            — return the LanguageModel to use
 *   - getSystemPrompt()     — return the system prompt (fallback when no context blocks)
 *   - getTools()            — return the ToolSet for the agentic loop
 *   - maxSteps              — max tool-call rounds per turn (default: 10)
 *   - configureSession()    — add context blocks, compaction, search, skills
 *
 * Lifecycle hooks:
 *   - beforeTurn()          — inspect/override context, tools, model before inference
 *   - beforeStep()          — per-step callback to override model, messages, tool selection
 *   - beforeToolCall()      — intercept tool calls (block, modify args, substitute result)
 *   - afterToolCall()       — inspect tool results after execution
 *   - onStepFinish()        — per-step callback (logging, analytics)
 *   - onChunk()             — per-chunk callback (streaming analytics)
 *   - onChatResponse()      — post-turn lifecycle hook (logging, chaining, analytics)
 *   - onChatError()         — customize error handling
 *
 * Production features:
 *   - WebSocket chat protocol (compatible with useAgentChat / useChat)
 *   - Sub-agent RPC streaming via StreamCallback
 *   - Session-backed storage with tree-structured messages
 *   - Context blocks with LLM-writable persistent memory
 *   - Non-destructive compaction (summaries replace ranges at read time)
 *   - FTS5 full-text search across conversation history
 *   - Abort/cancel support via AbortRegistry
 *   - Error handling with partial message persistence
 *   - Message sanitization (strips OpenAI ephemeral metadata)
 *   - Row size enforcement (compacts large tool outputs)
 *   - Resumable streams (replay on reconnect)
 *
 * @experimental The API surface may change before stabilizing.
 *
 * @example
 * ```typescript
 * import { Think } from "@cloudflare/think";
 * import { createWorkersAI } from "workers-ai-provider";
 *
 * export class MyAgent extends Think<Env> {
 *   getModel() {
 *     return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.6");
 *   }
 *
 *   getSystemPrompt() {
 *     return "You are a helpful coding assistant.";
 *   }
 * }
 * ```
 *
 * @example With context blocks and self-updating memory
 * ```typescript
 * import { Think } from "@cloudflare/think";
 * import type { Session } from "@cloudflare/think";
 *
 * export class MemoryAgent extends Think<Env> {
 *   getModel() { ... }
 *
 *   configureSession(session: Session) {
 *     return session
 *       .withContext("soul", {
 *         provider: { get: async () => "You are a helpful coding assistant." }
 *       })
 *       .withContext("memory", {
 *         description: "Important facts learned during conversation.",
 *         maxTokens: 2000
 *       })
 *       .withCachedPrompt();
 *   }
 * }
 * ```
 */

import type {
  LanguageModel,
  ModelMessage,
  PrepareStepFunction,
  PrepareStepResult,
  StreamTextOnChunkCallback,
  StreamTextOnStepFinishCallback,
  StreamTextOnToolCallFinishCallback,
  StopCondition,
  ToolSet,
  TypedToolCall,
  UIMessage
} from "ai";
import {
  convertToModelMessages,
  jsonSchema,
  Output,
  stepCountIs,
  streamText
} from "ai";

// Re-export AI SDK types that appear on Think's public lifecycle hooks
// so users can import them from a single place.
export type {
  PrepareStepFunction,
  PrepareStepResult,
  StepResult,
  StopCondition,
  TextStreamPart,
  TypedToolCall,
  TypedToolResult
} from "ai";
import {
  Agent,
  __DO_NOT_USE_WILL_BREAK__agentContext as agentContext
} from "agents";

const agentToolChunkEncoder = new TextEncoder();
import type {
  Connection,
  FiberRecoveryContext,
  RetryOptions,
  WSMessage
} from "agents";
import {
  sanitizeMessage,
  enforceRowSizeLimit,
  StreamAccumulator,
  CHAT_MESSAGE_TYPES,
  TurnQueue,
  ResumableStream,
  ContinuationState,
  SubmitConcurrencyController,
  createToolsFromClientSchemas,
  AbortRegistry,
  applyToolUpdate,
  toolResultUpdate,
  toolApprovalUpdate,
  parseProtocolMessage,
  applyChunkToParts,
  reconcileMessages,
  resolveToolMergeId,
  createChatFiberSnapshot,
  unwrapChatFiberSnapshot,
  wrapChatFiberSnapshot
} from "agents/chat";
import type {
  StreamChunkData,
  ClientToolSchema,
  MessagePart,
  SubmitConcurrencyDecision,
  ChatFiberSnapshot
} from "agents/chat";
import { Session } from "agents/experimental/memory/session";
import { truncateOlderMessages } from "agents/experimental/memory/utils";
import { Workspace } from "@cloudflare/shell";
import { createWorkspaceTools } from "./tools/workspace";
import { ThinkMessengerRuntime } from "./messengers/chat-sdk";
import type {
  MessengerContext,
  ThinkMessengers,
  MessengerThinkHost
} from "./messengers";

export { Session } from "agents/experimental/memory/session";
export { Workspace } from "@cloudflare/shell";
export type { FiberContext, FiberRecoveryContext } from "agents";
export type { WorkspaceLike } from "./tools/workspace";
import type { WorkspaceLike } from "./tools/workspace";

// ── Wire protocol constants ────────────────────────────────────────
const MSG_CHAT_MESSAGES = CHAT_MESSAGE_TYPES.CHAT_MESSAGES;
const MSG_CHAT_RESPONSE = CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
const MSG_CHAT_CLEAR = CHAT_MESSAGE_TYPES.CHAT_CLEAR;
const MSG_STREAM_RESUMING = CHAT_MESSAGE_TYPES.STREAM_RESUMING;
const MSG_STREAM_RESUME_NONE = CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE;
const MSG_MESSAGE_UPDATED = CHAT_MESSAGE_TYPES.MESSAGE_UPDATED;

function sendIfOpen(connection: Connection, message: string): boolean {
  try {
    connection.send(message);
    return true;
  } catch (error) {
    if (isWebSocketClosedSendError(error)) return false;
    throw error;
  }
}

function isWebSocketClosedSendError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes("WebSocket send() after close")
  );
}

function shouldMarkSkippedAfterGenerationChange(
  status: SaveMessagesResult["status"]
): boolean {
  return status === "completed";
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [h1, h2, h3, h4]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

function validateTimezone(timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return formatter.resolvedOptions().timeZone;
  } catch {
    throw new Error(`Invalid timezone "${timezone}"`);
  }
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid schedule time "${value}"; expected HH:mm`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const declaredScheduleDayNumbers: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
};

function parseDeclaredTaskSchedule(
  rawSchedule: string,
  taskTimezone: string | undefined,
  defaultTimezone: string | undefined
): ParsedDeclaredSchedule {
  const result = tryParseDeclaredTaskSchedule(
    rawSchedule,
    taskTimezone,
    defaultTimezone
  );
  if (!result.ok) throw new Error(result.error);
  return result.schedule;
}

function tryParseDeclaredTaskSchedule(
  rawSchedule: string,
  taskTimezone: string | undefined,
  defaultTimezone: string | undefined
): ParseDeclaredScheduleResult {
  try {
    return {
      ok: true,
      schedule: parseDeclaredTaskScheduleUnchecked(
        rawSchedule,
        taskTimezone,
        defaultTimezone
      )
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseDeclaredTaskScheduleUnchecked(
  rawSchedule: string,
  taskTimezone: string | undefined,
  defaultTimezone: string | undefined
): ParsedDeclaredSchedule {
  const trimmed = rawSchedule.trim().replace(/\s+/g, " ").toLowerCase();
  const inlineTimezoneMatch = /^(.*) in ([A-Za-z_][A-Za-z0-9_+\-/]*)$/.exec(
    trimmed
  );
  const schedule = inlineTimezoneMatch?.[1] ?? trimmed;
  const inlineTimezone = inlineTimezoneMatch?.[2];
  if (
    inlineTimezone &&
    taskTimezone &&
    validateTimezone(inlineTimezone) !== validateTimezone(taskTimezone)
  ) {
    throw new Error(
      `Schedule timezone "${inlineTimezone}" does not match task timezone "${taskTimezone}"`
    );
  }

  const intervalMatch = /^every ([1-9]\d*) (minute|minutes|hour|hours)$/.exec(
    schedule
  );
  if (intervalMatch) {
    if (inlineTimezone || taskTimezone) {
      throw new Error("Interval schedules cannot specify a timezone");
    }
    const count = Number(intervalMatch[1]);
    const unit = intervalMatch[2];
    if (count === 1 && unit.endsWith("s")) {
      throw new Error(`Use singular unit for "${rawSchedule}"`);
    }
    if (count !== 1 && !unit.endsWith("s")) {
      throw new Error(`Use plural unit for "${rawSchedule}"`);
    }
    return {
      kind: "interval",
      intervalMs: count * (unit.startsWith("hour") ? 60 * 60_000 : 60_000),
      normalizedSchedule: `every ${count} ${unit}`
    };
  }

  const timezone = inlineTimezone ?? taskTimezone ?? defaultTimezone;
  if (!timezone) {
    throw new Error(
      `Wall-clock schedule "${rawSchedule}" requires a timezone or getDefaultTimezone()`
    );
  }
  const resolvedTimezone = validateTimezone(timezone);

  const dailyMatch = /^every day at ([0-2]\d:[0-5]\d)$/.exec(schedule);
  if (dailyMatch) {
    const { hour, minute } = parseTime(dailyMatch[1]);
    return {
      kind: "wall-clock",
      normalizedSchedule: `every day at ${dailyMatch[1]}`,
      timezone: resolvedTimezone,
      hour,
      minute,
      days: "daily"
    };
  }

  const weekdayMatch = /^every weekday at ([0-2]\d:[0-5]\d)$/.exec(schedule);
  if (weekdayMatch) {
    const { hour, minute } = parseTime(weekdayMatch[1]);
    return {
      kind: "wall-clock",
      normalizedSchedule: `every weekday at ${weekdayMatch[1]}`,
      timezone: resolvedTimezone,
      hour,
      minute,
      days: "weekday"
    };
  }

  const weeklyMatch = /^every week on ([a-z,\s]+) at ([0-2]\d:[0-5]\d)$/.exec(
    schedule
  );
  if (weeklyMatch) {
    const seen = new Set<number>();
    const days = weeklyMatch[1].split(",").map((day) => {
      const normalized = day.trim();
      const dayNumber = declaredScheduleDayNumbers[normalized];
      if (dayNumber === undefined) {
        throw new Error(`Invalid schedule day "${normalized}"`);
      }
      if (seen.has(dayNumber)) {
        throw new Error(`Duplicate schedule day "${normalized}"`);
      }
      seen.add(dayNumber);
      return dayNumber;
    });
    if (days.length === 0) {
      throw new Error("Weekly schedule requires at least one day");
    }
    const { hour, minute } = parseTime(weeklyMatch[2]);
    return {
      kind: "wall-clock",
      normalizedSchedule: `every week on ${weeklyMatch[1]
        .split(",")
        .map((day) => day.trim())
        .join(",")} at ${weeklyMatch[2]}`,
      timezone: resolvedTimezone,
      hour,
      minute,
      days
    };
  }

  throw new Error(`Unsupported schedule DSL "${rawSchedule}"`);
}

function getZonedParts(date: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    second: Number(part("second")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      part("weekday")
    )
  };
}

function compareLocalParts(
  left: Pick<ZonedParts, "year" | "month" | "day" | "hour" | "minute">,
  right: Pick<ZonedParts, "year" | "month" | "day" | "hour" | "minute">
): number {
  const fields = ["year", "month", "day", "hour", "minute"] as const;
  for (const field of fields) {
    const diff = left[field] - right[field];
    if (diff !== 0) return diff;
  }
  return 0;
}

function findZonedInstant(
  target: Pick<ZonedParts, "year" | "month" | "day" | "hour" | "minute">,
  timezone: string
): Date {
  const approximate = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute
  );
  const start = approximate - 14 * 60 * 60_000;
  const end = approximate + 14 * 60 * 60_000;
  for (let time = start; time <= end; time += 60_000) {
    const candidate = new Date(time);
    const parts = getZonedParts(candidate, timezone);
    if (compareLocalParts(parts, target) === 0) return candidate;
  }
  for (let time = start; time <= end; time += 60_000) {
    const candidate = new Date(time);
    const parts = getZonedParts(candidate, timezone);
    if (compareLocalParts(parts, target) > 0) return candidate;
  }
  throw new Error(`Unable to resolve local time in timezone "${timezone}"`);
}

function addLocalDays(
  parts: Pick<ZonedParts, "year" | "month" | "day">,
  days: number
): Pick<ZonedParts, "year" | "month" | "day"> {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days)
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function isAllowedWallClockDay(
  weekday: number,
  days: ParsedDeclaredSchedule & { kind: "wall-clock" }
): boolean {
  if (days.days === "daily") return true;
  if (days.days === "weekday") return weekday >= 1 && weekday <= 5;
  return days.days.includes(weekday);
}

function nextDeclaredScheduleTime(
  schedule: ParsedDeclaredSchedule,
  now: Date,
  previousScheduledFor?: number
): Date {
  if (schedule.kind === "interval") {
    let next =
      previousScheduledFor === undefined
        ? now.getTime() + schedule.intervalMs
        : previousScheduledFor + schedule.intervalMs;
    while (next <= now.getTime()) next += schedule.intervalMs;
    return new Date(next);
  }

  const nowParts = getZonedParts(now, schedule.timezone);
  for (let offset = 0; offset < 370; offset++) {
    const localDate = addLocalDays(nowParts, offset);
    const candidate = findZonedInstant(
      {
        ...localDate,
        hour: schedule.hour,
        minute: schedule.minute
      },
      schedule.timezone
    );
    const weekday = getZonedParts(candidate, schedule.timezone).weekday;
    if (!isAllowedWallClockDay(weekday, schedule)) continue;
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  throw new Error("Unable to compute next scheduled task occurrence");
}

type StreamResultStatus = {
  status: Exclude<SaveMessagesResult["status"], "skipped">;
  error?: string;
  output?: unknown;
};

type ProgrammaticMessagesResult = SaveMessagesResult & {
  output?: unknown;
};

type ChatRecoveryRetryData = {
  targetUserId?: string;
  originalRequestId?: string;
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
  recoveredRequestId?: string;
};

type ChatRecoveryContinueData = {
  targetAssistantId?: string;
  originalRequestId?: string;
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
  recoveredRequestId?: string;
};

/**
 * Callback interface for streaming chat events from a Think sub-agent.
 *
 * Designed to work across the sub-agent RPC boundary — implement as
 * an RpcTarget in the parent agent and pass to `chat()`.
 */
export interface ChatStartEvent {
  requestId: string;
}

export interface StreamCallback {
  onStart(event: ChatStartEvent): void | Promise<void>;
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError(error: string): void | Promise<void>;
}

/**
 * Minimal interface for the result of the inference loop.
 * The AI SDK's `streamText()` result satisfies this interface.
 */
export interface StreamableResult {
  toUIMessageStream(options?: {
    sendReasoning?: boolean;
  }): AsyncIterable<unknown>;
  output?: PromiseLike<unknown>;
}

/**
 * Options for a chat turn (sub-agent RPC entry point).
 */
export interface ChatOptions {
  signal?: AbortSignal;
}

type AgentToolChildRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "error"
  | "aborted";

type AgentToolChildRunRow = {
  run_id: string;
  request_id: string | null;
  stream_id: string | null;
  status: AgentToolChildRunStatus;
  summary: string | null;
  output_json: string | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
};

type AgentToolRunInspection<Output = unknown> = {
  runId: string;
  status: AgentToolChildRunStatus;
  requestId?: string;
  streamId?: string;
  output?: Output;
  summary?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
};

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

export function defineScheduledTasks<const T extends ThinkScheduledTasks>(
  tasks: T
): T {
  return tasks;
}

type ParsedDeclaredSchedule =
  | {
      kind: "interval";
      intervalMs: number;
      normalizedSchedule: string;
    }
  | {
      kind: "wall-clock";
      normalizedSchedule: string;
      timezone: string;
      hour: number;
      minute: number;
      days: "daily" | "weekday" | number[];
    };

type ParseDeclaredScheduleResult =
  | { ok: true; schedule: ParsedDeclaredSchedule }
  | { ok: false; error: string };

type NormalizedDeclaredTask = {
  taskId: string;
  prompt?: ThinkScheduledTaskPromptAction["prompt"];
  handler?: ThinkScheduledTaskHandlerAction["handler"];
  schedule: ParsedDeclaredSchedule;
  retry?: RetryOptions;
  metadata?: Record<string, unknown>;
  scheduleHash: string;
  taskHash: string;
};

type DeclaredScheduledTaskRow = {
  owner_key: string;
  task_id: string;
  schedule_hash: string;
  task_hash: string;
  schedule_id: string | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

type DeclaredScheduledTaskPayload = {
  taskId: string;
  scheduleHash: string;
  scheduledFor: number;
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

type AgentToolStoredChunk = {
  sequence: number;
  body: string;
};

export type ThinkSubmissionStatus =
  | "pending"
  | "running"
  | "completed"
  | "aborted"
  | "skipped"
  | "error";

export type SubmitMessagesOptions = {
  submissionId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

type ThinkWorkflowPromptContext = {
  workflow: {
    name: string;
    id: string;
    stepName: string;
    eventType: string;
  };
  output?: {
    schema: unknown;
  };
  fingerprint?: string;
};

const THINK_WORKFLOW_PROMPT_METADATA_KEY = "__thinkWorkflowPrompt";

export type ThinkSubmissionInspection = {
  submissionId: string;
  idempotencyKey?: string;
  requestId?: string;
  status: ThinkSubmissionStatus;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
};

export type SubmitMessagesResult = ThinkSubmissionInspection & {
  accepted: boolean;
};

export type ListSubmissionsOptions = {
  status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
  limit?: number;
};

export type DeleteSubmissionsOptions = {
  status?: ThinkSubmissionStatus | ThinkSubmissionStatus[];
  completedBefore?: Date;
  limit?: number;
};

type ThinkSubmissionRow = {
  submission_id: string;
  idempotency_key: string | null;
  request_id: string | null;
  stream_id: string | null;
  status: ThinkSubmissionStatus;
  messages_json: string;
  metadata_json: string | null;
  error_message: string | null;
  created_at: number;
  messages_applied_at: number | null;
  started_at: number | null;
  completed_at: number | null;
};

type ThinkWorkflowNotificationRow = {
  notification_id: string;
  submission_id: string;
  workflow_name: string;
  workflow_id: string;
  event_type: string;
  payload_json: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
};

// Lifecycle / result types are shared with `@cloudflare/ai-chat` via
// `agents/chat`. Re-exported from Think so subclasses can import them
// from `@cloudflare/think` directly.
export type {
  ChatResponseResult,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  SaveMessagesOptions,
  SaveMessagesResult
} from "agents/chat";
import type {
  ChatResponseResult,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  SaveMessagesOptions,
  SaveMessagesResult
} from "agents/chat";

// ── Lifecycle hook types ────────────────────────────────────────

/**
 * A chat turn request. Built automatically by each entry path
 * (WebSocket, chat(), saveMessages, auto-continuation) and passed
 * to Think's inference loop.
 */
export interface TurnInput {
  signal?: AbortSignal;
  /** Client-provided tool schemas for dynamic tool registration. */
  clientTools?: ClientToolSchema[];
  /** Custom body fields from the client request. */
  body?: Record<string, unknown>;
  /** Internal workflow prompt configuration, never sourced from client body. */
  workflowPrompt?: ThinkWorkflowPromptContext;
  /** Whether this is a continuation turn (auto-continue after tool result, recovery). */
  continuation: boolean;
}

/**
 * Context passed to the `beforeTurn` hook.
 * Contains everything Think assembled — the hook can inspect and override.
 */
export interface TurnContext {
  /** Assembled system prompt (from context blocks or getSystemPrompt fallback). */
  system: string;
  /** Assembled model messages (truncated, pruned). */
  messages: ModelMessage[];
  /** Merged tool set (workspace + getTools + session + MCP + client + caller). */
  tools: ToolSet;
  /** The language model from getModel(). */
  model: LanguageModel;
  /** Whether this is a continuation turn. */
  continuation: boolean;
  /** Custom body fields from the client request. */
  body?: Record<string, unknown>;
}

/**
 * Configuration returned by the `beforeTurn` hook to override defaults.
 * All fields are optional — return only what you want to change.
 */
export interface TurnConfig {
  /** Override the model for this turn (e.g. cheap model for continuations). */
  model?: LanguageModel;
  /** Override the assembled system prompt. */
  system?: string;
  /** Override the assembled messages. */
  messages?: ModelMessage[];
  /** Extra tools to merge (additive — spread on top of existing tools). */
  tools?: ToolSet;
  /** Limit which tools the model can call (AI SDK activeTools). */
  activeTools?: string[];
  /** Force a specific tool call (AI SDK toolChoice). */
  toolChoice?: Parameters<typeof streamText>[0]["toolChoice"];
  /** Override maxSteps for this turn. */
  maxSteps?: number;
  /**
   * Additional AI SDK stop conditions for ending the turn early.
   * Think always keeps its `maxSteps` stop condition as a safety bound.
   */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  /**
   * Controls whether reasoning chunks are included in the UI message stream
   * for this turn. Defaults to the instance-level `sendReasoning` setting.
   */
  sendReasoning?: boolean;
  /** Maximum number of tokens to generate for this turn. */
  maxOutputTokens?: Parameters<typeof streamText>[0]["maxOutputTokens"];
  /** Temperature setting for this turn. */
  temperature?: Parameters<typeof streamText>[0]["temperature"];
  /** Nucleus sampling setting for this turn. */
  topP?: Parameters<typeof streamText>[0]["topP"];
  /** Top-K sampling setting for this turn. */
  topK?: Parameters<typeof streamText>[0]["topK"];
  /** Presence penalty setting for this turn. */
  presencePenalty?: Parameters<typeof streamText>[0]["presencePenalty"];
  /** Frequency penalty setting for this turn. */
  frequencyPenalty?: Parameters<typeof streamText>[0]["frequencyPenalty"];
  /** Stop sequences for this turn. */
  stopSequences?: Parameters<typeof streamText>[0]["stopSequences"];
  /** Seed for deterministic sampling when supported by the model. */
  seed?: Parameters<typeof streamText>[0]["seed"];
  /** Maximum number of retries for this turn. Set to 0 to disable retries. */
  maxRetries?: Parameters<typeof streamText>[0]["maxRetries"];
  /** Timeout configuration for this turn. */
  timeout?: Parameters<typeof streamText>[0]["timeout"];
  /** Additional HTTP headers for provider requests on this turn. */
  headers?: Parameters<typeof streamText>[0]["headers"];
  /** Provider-specific options (AI SDK providerOptions). */
  providerOptions?: Record<string, unknown>;
  /** Optional AI SDK telemetry configuration for this turn. */
  experimental_telemetry?: Parameters<
    typeof streamText
  >[0]["experimental_telemetry"];
  /**
   * Optional structured-output specification (AI SDK `output`).
   * Forwarded to `streamText` so the model's final response is parsed
   * against the supplied schema. Use the AI SDK's `Output.object({ schema })`
   * / `Output.text()` helpers. Combine with `activeTools: []` on the
   * terminal turn if your provider strips tools when structured output
   * is active (e.g. workers-ai-provider).
   */
  output?: Parameters<typeof streamText>[0]["output"];
}

/**
 * Context passed to the `beforeStep` hook before each AI SDK step in
 * the agentic loop. Backed by the AI SDK's `PrepareStepFunction<TOOLS>`
 * parameter — exposes the previous `steps`, the zero-based `stepNumber`,
 * the currently selected `model`, the `messages` about to be sent, and
 * `experimental_context`.
 *
 * Pass an explicit `TOOLS` generic for typed previous tool calls / results.
 *
 * Limitations (AI SDK boundary, not Think):
 * - No `abortSignal` is exposed in the context. If you do remote work
 *   inside `beforeStep`, it cannot be cancelled by turn-level abort.
 * - `experimental_context` is typed `unknown`; users must narrow it.
 * - `output` cannot be overridden per-step — set it at the turn level
 *   via `TurnConfig.output` (returned from `beforeTurn`).
 */
export type PrepareStepContext<TOOLS extends ToolSet = ToolSet> = Parameters<
  PrepareStepFunction<TOOLS>
>[0];

/**
 * Configuration returned by `beforeStep` to override defaults for the
 * current AI SDK step. This is the AI SDK's `PrepareStepResult<TOOLS>` —
 * return only the fields you want to override (`model`, `toolChoice`,
 * `activeTools`, `system`, `messages`, `experimental_context`,
 * `providerOptions`).
 */
export type StepConfig<TOOLS extends ToolSet = ToolSet> =
  PrepareStepResult<TOOLS>;

/**
 * Context passed to the `beforeToolCall` hook **before** the tool's
 * `execute` function runs.
 *
 * Backed by the AI SDK's `OnToolCallStartEvent` (the parameter of
 * `experimental_onToolCallStart`). The full `TypedToolCall<TOOLS>`
 * fields (`toolName`, `toolCallId`, `input`, `providerMetadata`, the
 * dynamic/invalid/error discriminators) are spread at the top level for
 * convenience, with the per-call event extras attached:
 *
 * - `stepNumber` — index of the current step
 * - `messages`   — conversation messages visible at tool execution time
 * - `abortSignal` — signal that aborts if the turn is cancelled
 *
 * Pass an explicit `TOOLS` generic for full input typing:
 *
 * ```ts
 * import type { ToolCallContext } from "@cloudflare/think";
 * import type { tools } from "./my-tools";
 *
 * beforeToolCall(ctx: ToolCallContext<typeof tools>) {
 *   if (ctx.toolName === "search") {
 *     ctx.input.query; // typed
 *   }
 * }
 * ```
 */
export type ToolCallContext<TOOLS extends ToolSet = ToolSet> =
  TypedToolCall<TOOLS> & {
    /** Zero-based index of the current step where this tool call occurs. */
    readonly stepNumber: number | undefined;
    /** The conversation messages available at tool execution time. */
    readonly messages: ReadonlyArray<ModelMessage>;
    /** Signal for cancelling the operation. */
    readonly abortSignal: AbortSignal | undefined;
  };

/**
 * Decision returned by `beforeToolCall` to control tool execution.
 * Return void/undefined to allow execution with original input.
 *
 * Discriminated union — each action has a clear, non-overlapping meaning:
 * - `allow` — execute the tool (optionally with modified input)
 * - `block` — don't execute; return `reason` as the tool result so the model can adjust
 * - `substitute` — don't execute; return `output` as the tool result (afterToolCall still fires)
 */
export type ToolCallDecision =
  | {
      action: "allow";
      /** Modified input — tool executes with this instead of the original. */
      input?: Record<string, unknown>;
    }
  | {
      action: "block";
      /** Returned as the tool result so the model can adjust. */
      reason?: string;
    }
  | {
      action: "substitute";
      /** The substitute tool output — model sees this instead of real execution. */
      output: unknown;
      /** Optional input attribution for the afterToolCall log. */
      input?: Record<string, unknown>;
    };

/**
 * Context passed to the `afterToolCall` hook after a tool executes.
 *
 * Backed by the AI SDK's `OnToolCallFinishEvent` (the parameter of
 * `experimental_onToolCallFinish`). The full `TypedToolCall<TOOLS>`
 * fields (`toolName`, `toolCallId`, `input`, …) are spread at the top
 * level, plus the per-call event extras:
 *
 * - `stepNumber`  — index of the current step
 * - `messages`    — conversation messages visible at tool execution time
 * - `durationMs`  — wall-clock execution time in milliseconds
 * - `success`/`output`/`error` — discriminated outcome:
 *   - on success: `success: true`, `output: unknown`
 *   - on failure: `success: false`, `error: unknown`
 *
 * Pass an explicit `TOOLS` generic for full input typing:
 *
 * ```ts
 * import type { ToolCallResultContext } from "@cloudflare/think";
 * import type { tools } from "./my-tools";
 *
 * afterToolCall(ctx: ToolCallResultContext<typeof tools>) {
 *   if (ctx.success) {
 *     console.log(`${ctx.toolName} took ${ctx.durationMs}ms`, ctx.output);
 *   } else {
 *     console.error(`${ctx.toolName} failed:`, ctx.error);
 *   }
 * }
 * ```
 */
export type ToolCallResultContext<TOOLS extends ToolSet = ToolSet> =
  TypedToolCall<TOOLS> & {
    readonly stepNumber: number | undefined;
    readonly messages: ReadonlyArray<ModelMessage>;
    /** Wall-clock execution time in milliseconds. */
    readonly durationMs: number;
  } & (
      | {
          readonly success: true;
          readonly output: unknown;
          readonly error?: never;
        }
      | {
          readonly success: false;
          readonly output?: never;
          readonly error: unknown;
        }
    );

/**
 * Context passed to the `onStepFinish` hook after each step completes.
 *
 * This is the AI SDK's `StepResult<TOOLS>` (= `OnStepFinishEvent<TOOLS>`) —
 * the full step record including `text`, `reasoning`, `toolCalls`,
 * `toolResults`, `files`, `sources`, `usage` (with `cachedInputTokens`,
 * `reasoningTokens`, `totalTokens`), `finishReason`, `warnings`, `request`,
 * `response`, and `providerMetadata` (where provider-specific cache
 * accounting like `cacheCreationInputTokens` lives).
 *
 * Pass an explicit `TOOLS` generic for typed `toolCalls`/`toolResults`.
 */
export type StepContext<TOOLS extends ToolSet = ToolSet> = Parameters<
  StreamTextOnStepFinishCallback<TOOLS>
>[0];

/**
 * Context passed to the `onChunk` hook for each streaming chunk.
 *
 * This is the AI SDK's `StreamTextOnChunkCallback` event — `{ chunk }`
 * where `chunk` is a discriminated union of `TextStreamPart` variants
 * (text-delta, reasoning-delta, source, tool-call, tool-input-start,
 * tool-input-delta, tool-result, raw).
 */
export type ChunkContext<TOOLS extends ToolSet = ToolSet> = Parameters<
  StreamTextOnChunkCallback<TOOLS>
>[0];

/**
 * @internal Re-export of the chunk variant union for consumers that need
 * to narrow on `chunk.type` without importing `TextStreamPart` directly.
 */
export type ChunkPart<TOOLS extends ToolSet = ToolSet> =
  ChunkContext<TOOLS>["chunk"];

/**
 * Configuration for a sandboxed extension, returned by getExtensions().
 */
export interface ExtensionConfig {
  /** Extension manifest (name, version, permissions, contributions). */
  manifest: import("./extensions/types").ExtensionManifest;
  /** JavaScript source code defining the extension's tools. */
  source: string;
}

const TIMED_OUT = Symbol("timed-out");

/**
 * An opinionated chat agent base class.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Think<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  private static readonly CONFIG_KEYS = [
    "_think_config",
    "lastClientTools",
    "lastBody"
  ] as const;
  /**
   * Wait for MCP server connections to be ready before the inference
   * loop. MCP tools are auto-merged into the tool set.
   *
   * Set to `true` for a default 10s timeout, or `{ timeout: ms }`
   * for a custom timeout. Defaults to `false` (no waiting).
   */
  waitForMcpConnections: boolean | { timeout: number } = false;

  /**
   * Controls how overlapping user submit requests behave while another
   * chat turn is already active or queued.
   *
   * @default "queue"
   */
  messageConcurrency: MessageConcurrency = "queue";

  /**
   * When true, chat turns are wrapped in `runFiber` for durable execution.
   * Enables `onChatRecovery` hook and `this.stash()` during streaming.
   */
  chatRecovery = true;

  static readonly CHAT_FIBER_NAME = "__cf_internal_chat_turn";

  /**
   * The conversation session — messages, context, compaction, search.
   *
   * Direct message writes are observed and mirrored into Think's live cache.
   * Prefer the history helpers below when writing UI messages from subclasses;
   * they sanitize content and enforce row-size limits before delegating here.
   */
  session!: Session;

  /** Cached messages — kept in sync with session storage. */
  private _cachedMessages: UIMessage[] = [];

  private _activeMessengerContext?: MessengerContext;

  private _messengerRuntime?: ThinkMessengerRuntime;

  /**
   * WorkerLoader binding for sandboxed extensions.
   * Set this to enable `getExtensions()` and dynamic extension loading.
   */
  extensionLoader?: WorkerLoader;

  /**
   * Extension manager — created automatically when `extensionLoader` is set.
   * Use for dynamic `load()` / `unload()` at runtime.
   */
  extensionManager?: import("./extensions/manager").ExtensionManager;

  /**
   * Workspace filesystem available in `getTools()` and lifecycle hooks.
   * Defaults to a full `Workspace` backed by the DO's SQLite storage.
   *
   * Typed as `WorkspaceLike` rather than `Workspace` so subclasses can
   * replace it with anything that satisfies the interface — e.g. a proxy
   * that forwards to a shared workspace owned by a parent DO. Override as
   * a class field to skip the default init entirely:
   *
   * ```typescript
   * // Default init with R2 spillover for large files.
   * override workspace = new Workspace({
   *   sql: this.ctx.storage.sql,
   *   r2: this.env.R2,
   *   name: () => this.name
   * });
   *
   * // Or a custom WorkspaceLike — e.g. a parent-owned shared workspace.
   * override workspace: WorkspaceLike = new SharedWorkspace(this);
   * ```
   */
  workspace!: WorkspaceLike;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const _onStart = this.onStart.bind(this);
    this.onStart = async () => {
      // 1. Workspace initialization
      if (!this.workspace) {
        this.workspace = new Workspace({
          sql: this.ctx.storage.sql,
          name: () => this.name
        });
      }

      // 2. Session configuration (builder phase — context blocks, compaction, skills)
      const baseSession = Session.create(this);
      this.session = await this.configureSession(baseSession);
      this.session.internal_onMessagesChanged(async (event) => {
        switch (event.type) {
          case "append":
            if (!event.inserted || event.parentId !== undefined) {
              await this._syncMessages();
            } else {
              this._upsertCachedMessage(event.message as UIMessage);
            }
            break;
          case "update":
            this._patchCachedMessage(event.message as UIMessage);
            break;
          case "clear":
            this._replaceCachedMessages([]);
            break;
          case "delete":
          case "compact":
            await this._syncMessages();
            break;
        }
      });

      // Force Session to initialize its tables (assistant_messages,
      // assistant_compactions, assistant_config, etc.) so that subsequent
      // config reads work.
      await this._syncMessages();

      // 3-6. Extension initialization (if extensionLoader is set)
      if (this.extensionLoader) {
        await this._initializeExtensions();
      }

      // 7. Protocol handlers
      this._resumableStream = new ResumableStream(this.sql.bind(this));
      this._restoreClientTools();
      this._restoreBody();
      this._setupProtocolHandlers();
      this._initializeMessengers();

      // 8. User's onStart
      await _onStart();

      // 9. Declarative scheduled tasks are code-defined and should reconcile
      // before draining any recovered programmatic work they may enqueue.
      await this._reconcileDeclaredScheduledTasks();

      // 10. Durable submissions may run user-defined model/hooks, so start them
      // after subclass initialization has completed.
      await this._recoverSubmissionsOnStart();
      this._recoverWorkflowNotifications();
      this._startSubmissionDrain();
      this._startWorkflowNotificationDrain();
    };
  }

  /**
   * Conversation history as Think's live in-memory view.
   *
   * Storage remains the durable source of truth, but runtime logic should read
   * through this cache so in-flight turns, tool updates, and recovery state all
   * observe the same message list. Use `_syncMessages()` only at safe
   * boundaries where a full storage reread cannot drop in-flight state.
   */
  get messages(): UIMessage[] {
    return this._cachedMessages;
  }

  /** Read the durable message path from session storage. */
  private async _readMessagesFromStorage(): Promise<UIMessage[]> {
    return (await this.session.getHistory()) as UIMessage[];
  }

  /** Replace the live cache with a durable storage snapshot. */
  private _replaceCachedMessages(messages: UIMessage[]): UIMessage[] {
    this._cachedMessages = messages;
    return this._cachedMessages;
  }

  /** Refresh the live cache from durable storage at a safe boundary. */
  private async _syncMessages(): Promise<UIMessage[]> {
    return this._replaceCachedMessages(await this._readMessagesFromStorage());
  }

  /** Patch or append one message in the live cache after a durable write. */
  private _upsertCachedMessage(message: UIMessage): void {
    const index = this._cachedMessages.findIndex((m) => m.id === message.id);
    if (index === -1) {
      this._cachedMessages.push(message);
    } else {
      this._cachedMessages[index] = message;
    }
  }

  /** Patch a message that is already present in the live cache. */
  private _patchCachedMessage(message: UIMessage): void {
    const index = this._cachedMessages.findIndex((m) => m.id === message.id);
    if (index !== -1) {
      this._cachedMessages[index] = message;
    }
  }

  private async _appendMessageToHistory(
    message: UIMessage,
    parentId?: string | null
  ): Promise<UIMessage> {
    const safe = enforceRowSizeLimit(sanitizeMessage(message));
    await this.session.appendMessage(safe, parentId);
    return safe;
  }

  private async _updateMessageInHistory(
    message: UIMessage
  ): Promise<UIMessage> {
    const safe = enforceRowSizeLimit(sanitizeMessage(message));
    await this.session.updateMessage(safe);
    return safe;
  }

  private async _upsertMessageInHistory(
    message: UIMessage,
    parentId?: string | null
  ): Promise<UIMessage> {
    const safe = enforceRowSizeLimit(sanitizeMessage(message));
    const existing = await this.session.getMessage(safe.id);
    if (existing) {
      await this.session.updateMessage(safe);
    } else {
      await this.session.appendMessage(safe, parentId);
    }
    return safe;
  }

  private async _clearHistory(): Promise<void> {
    await this.session.clearMessages();
  }

  /** Append a message while keeping Think's live message cache coherent. */
  protected appendMessageToHistory(
    message: UIMessage,
    parentId?: string | null
  ): Promise<UIMessage> {
    return this._appendMessageToHistory(message, parentId);
  }

  /** Update a message while keeping Think's live message cache coherent. */
  protected updateMessageInHistory(message: UIMessage): Promise<UIMessage> {
    return this._updateMessageInHistory(message);
  }

  /** Refresh Think's live message cache from the durable session path. */
  protected async syncMessagesFromStorage(): Promise<UIMessage[]> {
    return (await this._syncMessages()).slice();
  }

  private _aborts = new AbortRegistry();
  private _turnQueue = new TurnQueue();
  protected _resumableStream!: ResumableStream;
  private _pendingResumeConnections: Set<string> = new Set();
  private _lastClientTools: ClientToolSchema[] | undefined;
  private _lastBody: Record<string, unknown> | undefined;
  private _continuation = new ContinuationState();
  private _continuationTimer: ReturnType<typeof setTimeout> | null = null;
  private _insideResponseHook = false;
  private _insideInferenceLoop = false;
  private _pendingInteractionPromise: Promise<boolean> | null = null;
  private _submitConcurrency = new SubmitConcurrencyController({
    defaultDebounceMs: Think.MESSAGE_DEBOUNCE_MS
  });
  private static MESSAGE_DEBOUNCE_MS = 750;
  private _agentToolForwarders = new Map<
    string,
    Set<(chunk: AgentToolStoredChunk) => void>
  >();
  private _agentToolClosers = new Map<string, Set<() => void>>();
  private _agentToolAbortControllers = new Map<string, AbortController>();
  private _agentToolLastErrors = new Map<string, string>();
  private _agentToolPreTurnAssistantIds = new Map<string, Set<string>>();
  private _agentToolLiveSequences = new Map<string, number>();
  private _submissionTableEnsured = false;
  private _workflowNotificationTableEnsured = false;
  private _declaredScheduledTasksTableEnsured = false;
  private _drainingSubmissions = false;
  private _drainingWorkflowNotifications = false;
  private _submissionAbortControllers = new Map<string, AbortController>();
  private _programmaticStreamErrors = new Map<string, string>();
  protected static submissionRecoveryStaleMs = 15 * 60 * 1000;

  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    if (this._agentToolForwarders.size > 0 && typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as {
          type?: unknown;
          body?: unknown;
          error?: unknown;
        };
        if (parsed.type === MSG_CHAT_RESPONSE) {
          if (parsed.error === true && typeof parsed.body === "string") {
            for (const runId of this._agentToolForwarders.keys()) {
              this._agentToolLastErrors.set(runId, parsed.body);
            }
          } else if (
            typeof parsed.body === "string" &&
            parsed.body.length > 0
          ) {
            for (const [runId, forwarders] of this._agentToolForwarders) {
              const sequence = this._agentToolLiveSequences.get(runId) ?? 0;
              this._agentToolLiveSequences.set(runId, sequence + 1);
              const chunk = { sequence, body: parsed.body };
              for (const forward of forwarders) forward(chunk);
            }
          }
        }
      } catch {
        // Non-chat frames pass through unchanged.
      }
    }
    super.broadcast(msg, without);
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    this._startWorkflowNotificationDrain();
  }

  // ── Dynamic config ──────────────────────────────────────────────

  #configCache: unknown = null;

  /**
   * Persist an arbitrary JSON-serializable configuration object for this
   * agent instance. Stored in the Think-private `think_config` table —
   * survives
   * restarts and hibernation. Pass the config shape as a method generic
   * for typed call sites:
   *
   * ```ts
   * this.configure<MyConfig>({ modelTier: "fast" });
   * ```
   *
   * Prefer `state` / `setState` from `Agent` when you want the value
   * broadcast to connected clients. Use `configure` for private
   * per-instance config that should stay server-side.
   */
  configure<T = Record<string, unknown>>(config: T): void {
    const json = JSON.stringify(config);
    this._configSet("_think_config", json);
    this.#configCache = config;
  }

  /**
   * Read the persisted configuration, or null if never configured.
   * Pass the config shape as a method generic for a typed result:
   *
   * ```ts
   * const cfg = this.getConfig<MyConfig>();
   * ```
   */
  getConfig<T = Record<string, unknown>>(): T | null {
    if (this.#configCache !== null) return this.#configCache as T;
    const raw = this._configGet("_think_config");
    if (raw !== undefined) {
      this.#configCache = JSON.parse(raw);
      return this.#configCache as T;
    }
    return null;
  }

  // ── Config storage helpers (think_config table) ─────────────────

  #configTableReady = false;

  protected _migrateLegacyConfigToThinkTable(): void {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='assistant_config'"
      )
      .toArray() as Array<{ sql?: unknown }>;
    if (rows.length === 0) return;

    const ddl = String(rows[0].sql ?? "");
    if (!ddl.includes("session_id")) return;

    // Older Think builds stored private config in Session's shared
    // `assistant_config(session_id, key, value)` table, even though
    // Think always used the empty session id. Copy only the Think-owned
    // keys into the dedicated `think_config` table and leave the shared
    // Session table untouched.
    for (const key of Think.CONFIG_KEYS) {
      const legacyRows = this.sql<{ value: string }>`
        SELECT value FROM assistant_config
        WHERE session_id = '' AND key = ${key}
      `;
      const value = legacyRows[0]?.value;
      if (value !== undefined) {
        this.sql`
          INSERT OR IGNORE INTO think_config (key, value)
          VALUES (${key}, ${value})
        `;
      }
    }
  }

  private _ensureConfigTable(): void {
    if (this.#configTableReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS think_config (
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (key)
      )
    `;
    this._migrateLegacyConfigToThinkTable();
    this.#configTableReady = true;
  }

  private _configSet(key: string, value: string): void {
    this._ensureConfigTable();
    this.sql`
      INSERT OR REPLACE INTO think_config (key, value)
      VALUES (${key}, ${value})
    `;
  }

  private _configGet(key: string): string | undefined {
    this._ensureConfigTable();
    const rows = this.sql<{ value: string }>`
      SELECT value FROM think_config
      WHERE key = ${key}
    `;
    return rows[0]?.value;
  }

  private _configDelete(key: string): void {
    this._ensureConfigTable();
    this.sql`
      DELETE FROM think_config
      WHERE key = ${key}
    `;
  }

  // ── Configuration overrides ─────────────────────────────────────

  /**
   * Return the language model to use for inference.
   * Must be overridden by subclasses.
   */
  getModel(): LanguageModel {
    throw new Error("Override getModel() to return a LanguageModel.");
  }

  /**
   * Return the system prompt for the assistant.
   * Used as fallback when no context blocks are configured via `configureSession`.
   */
  getSystemPrompt(): string {
    return [
      "You are a careful, capable assistant helping the user complete their task.",
      "Use available tools when they materially improve accuracy or let you act on the user's request. Before changing code, understand the relevant context: existing patterns, dependencies, tests, and nearby conventions.",
      "Keep changes focused on the user's request. Prefer small, idiomatic edits over broad rewrites or new abstractions. Do not introduce new dependencies, secrets, destructive actions, or persistent side effects unless the user clearly asks or approves.",
      "When the task is complex, briefly state your approach and keep the user informed with concise progress updates. If you modify code, verify with the smallest relevant test, build, typecheck, lint, or runtime check available, and report any checks you could not run.",
      "Be direct and useful in your final response: summarize the outcome, mention important files or commands, and call out real blockers or risks."
    ].join("\n\n");
  }

  /** Return the tools available to the assistant. */
  getTools(): ToolSet {
    return {};
  }

  /** Return messenger integrations that should be routed through this Think agent. */
  getMessengers(): ThinkMessengers {
    return {};
  }

  getMessengerContext(): MessengerContext | undefined {
    if (this._activeMessengerContext) {
      return this._activeMessengerContext;
    }

    const message = this.messages.at(-1) as
      | (UIMessage & { metadata?: { messenger?: MessengerContext } })
      | undefined;
    return message?.metadata?.messenger;
  }

  async chatWithMessengerContext(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    context: MessengerContext,
    options?: ChatOptions
  ): Promise<void> {
    const previous = this._activeMessengerContext;
    this._activeMessengerContext = context;
    try {
      await this.chat(userMessage, callback, options);
    } finally {
      this._activeMessengerContext = previous;
    }
  }

  private _initializeMessengers(): void {
    if (this.parentPath.length > 0) {
      return;
    }

    const messengers = this.getMessengers();
    if (Object.keys(messengers).length === 0) {
      return;
    }

    this._messengerRuntime = new ThinkMessengerRuntime(
      messengers,
      this as unknown as MessengerThinkHost
    );
    this._messengerRuntime.initialize();
  }

  /** Return code-declared scheduled tasks for this agent. */
  getScheduledTasks(): ThinkScheduledTasks | Promise<ThinkScheduledTasks> {
    return {};
  }

  /**
   * Reconcile code-declared scheduled tasks immediately.
   * Static declarations are reconciled on startup automatically; call this
   * after changing app-owned data that `getScheduledTasks()` reads.
   */
  async internal_reconcileScheduledTasks(): Promise<void> {
    await this._reconcileDeclaredScheduledTasks();
  }

  /**
   * Return the default timezone for wall-clock scheduled tasks.
   * Task-local timezone declarations take precedence.
   */
  getDefaultTimezone(): string | undefined | Promise<string | undefined> {
    return undefined;
  }

  private async _runChatRecoveryFiber<T>(
    requestId: string,
    continuation: boolean,
    fn: () => Promise<T>
  ): Promise<T> {
    const snapshot = createChatFiberSnapshot({
      kind: "think-chat-turn",
      requestId,
      continuation,
      messages: this.messages,
      lastBody: this._lastBody,
      lastClientTools: this._lastClientTools
    });

    return this._runFiberWithStashWrapper(
      `${(this.constructor as typeof Think).CHAT_FIBER_NAME}:${requestId}`,
      async () => fn(),
      {
        initialSnapshot: wrapChatFiberSnapshot(
          "__cfThinkChatFiberSnapshot",
          snapshot,
          null
        ),
        wrapStash: (data) =>
          wrapChatFiberSnapshot("__cfThinkChatFiberSnapshot", snapshot, data)
      }
    );
  }

  private _systemPromptForTurn(baseSystem: string, tools: ToolSet): string {
    if (baseSystem.includes("You are running inside a Think agent.")) {
      return baseSystem;
    }

    return `${baseSystem.trimEnd()}\n\n${this._buildThinkCapabilityBlock(tools)}`;
  }

  private _buildThinkCapabilityBlock(tools: ToolSet): string {
    const toolNames = new Set(Object.keys(tools));
    const hasTools = toolNames.size > 0;
    const hasWorkspaceTools = [
      "read",
      "write",
      "edit",
      "list",
      "find",
      "grep",
      "delete"
    ].some((toolName) => toolNames.has(toolName));
    const hasContextTools =
      toolNames.has("load_context") || toolNames.has("unload_context");
    const hasExtensionTools =
      toolNames.has("load_extension") || toolNames.has("list_extensions");
    const hasExecuteTool = toolNames.has("execute");

    const lines = [
      "You are running inside a Think agent.",
      "",
      "Capabilities available in this turn:"
    ];

    if (hasWorkspaceTools) {
      lines.push(
        "- You can inspect and edit the agent workspace using the available file tools."
      );
    }

    if (hasTools) {
      lines.push(
        "- Use the tools exposed in this turn when they materially improve accuracy or let you act on the user's request. Treat tool descriptions and schemas as the source of truth."
      );
      lines.push(
        "- Some tools may call server code, browser/client code, MCP servers, extensions, or delegated agents. Use them according to their descriptions."
      );
    }

    if (hasContextTools) {
      lines.push(
        "- If context-loading tools are available, use them to load relevant memory, skills, or project context before acting on incomplete information."
      );
    }

    if (hasExtensionTools) {
      lines.push(
        "- If extension tools are available, use them only when loading or inspecting extensions directly helps with the task."
      );
    }

    if (hasExecuteTool) {
      lines.push(
        "- If sandboxed execution is available, prefer it for safe, bounded checks or coordinated multi-step operations."
      );
    }

    lines.push(
      "- Do not claim access to capabilities that are not exposed as tools in this turn."
    );

    return lines.join("\n");
  }

  /** Maximum number of tool-call steps per turn. Override via property or per-turn via TurnConfig. */
  maxSteps = 10;

  /**
   * Whether reasoning chunks are sent to chat clients by default. Override
   * per turn by returning `sendReasoning` from `beforeTurn`.
   */
  sendReasoning = true;

  /**
   * Configure the session. Called once during `onStart`.
   * Override to add context blocks, compaction, search, skills.
   *
   * @example
   * ```typescript
   * configureSession(session: Session) {
   *   return session
   *     .withContext("memory", { description: "Learned facts", maxTokens: 2000 })
   *     .withCachedPrompt();
   * }
   * ```
   */
  configureSession(session: Session): Session | Promise<Session> {
    return session;
  }

  /**
   * Return sandboxed extension configurations. Defines load order,
   * which determines hook execution order.
   * Requires `extensionLoader` to be set.
   */
  getExtensions(): ExtensionConfig[] {
    return [];
  }

  // ── Lifecycle hooks ───────────────────────────────────────────

  /**
   * Called before `streamText` — inspect the assembled context and
   * return overrides. Think assembles tools, system prompt, and messages
   * internally; this hook sees the result and can override any part.
   *
   * Return `void` to accept all defaults.
   *
   * @example Switch model for continuations
   * ```typescript
   * beforeTurn(ctx: TurnContext) {
   *   if (ctx.continuation) return { model: this.cheapModel };
   * }
   * ```
   *
   * @example Restrict active tools
   * ```typescript
   * beforeTurn(ctx: TurnContext) {
   *   return { activeTools: ["read", "write"] };
   * }
   * ```
   */
  beforeTurn(
    _ctx: TurnContext
  ): TurnConfig | void | Promise<TurnConfig | void> {}

  /**
   * Called before each AI SDK step in the agentic loop. Backed by
   * `streamText({ prepareStep })`.
   *
   * Return `void` to accept the current step defaults, or return a
   * `StepConfig` to override the model, tool choice, active tools,
   * system prompt, messages, experimental context, or provider options
   * for this step. Use `beforeTurn` for turn-wide assembly and
   * `beforeStep` when the decision depends on the step number or
   * previous step results.
   *
   * @example Force search on the first step
   * ```typescript
   * beforeStep(ctx: PrepareStepContext) {
   *   if (ctx.stepNumber === 0) {
   *     return {
   *       activeTools: ["search"],
   *       toolChoice: { type: "tool", toolName: "search" }
   *     };
   *   }
   * }
   * ```
   *
   * @example Switch to a cheaper model after tool results land
   * ```typescript
   * beforeStep(ctx: PrepareStepContext) {
   *   // assumes a `fastSummaryModel` field on your Think subclass
   *   if (ctx.steps.some((s) => s.toolResults.length > 0)) {
   *     return { model: this.fastSummaryModel };
   *   }
   * }
   * ```
   */
  beforeStep(
    _ctx: PrepareStepContext
  ): StepConfig | void | Promise<StepConfig | void> {}

  /**
   * Called **before** the tool's `execute` function runs. Think wraps
   * every tool's `execute` so it can consult this hook and act on the
   * returned `ToolCallDecision`:
   *
   * - `void` (or `{ action: "allow" }` with no `input`) — run the
   *   original `execute` with the original input.
   * - `{ action: "allow", input }` — run the original `execute` with
   *   the substituted input.
   * - `{ action: "block", reason }` — skip `execute`; the model sees
   *   `reason` as the tool's output.
   * - `{ action: "substitute", output }` — skip `execute`; the model
   *   sees `output` as the tool's output.
   *
   * Only fires for server-side tools (tools with `execute`). Client
   * tools are handled on the client — Think can't intercept them.
   *
   * `afterToolCall` always fires after this hook (or after the original
   * `execute` when `allow`). For `block`/`substitute`, the substituted
   * value flows through `afterToolCall` as `success: true, output: ...`.
   *
   * @example Log tool calls
   * ```typescript
   * beforeToolCall(ctx: ToolCallContext) {
   *   console.log(`Tool called: ${ctx.toolName}`, ctx.input);
   * }
   * ```
   *
   * @example Block a tool the model shouldn't be calling here
   * ```typescript
   * beforeToolCall(ctx: ToolCallContext): ToolCallDecision | void {
   *   if (ctx.toolName === "delete" && this.isReadOnlyMode) {
   *     return { action: "block", reason: "delete is disabled in read-only mode" };
   *   }
   * }
   * ```
   *
   * @example Substitute a cached result
   * ```typescript
   * async beforeToolCall(ctx: ToolCallContext): Promise<ToolCallDecision | void> {
   *   if (ctx.toolName === "weather") {
   *     const cached = await this.cache.get(JSON.stringify(ctx.input));
   *     if (cached) return { action: "substitute", output: cached };
   *   }
   * }
   * ```
   */
  beforeToolCall(
    _ctx: ToolCallContext
  ): ToolCallDecision | void | Promise<ToolCallDecision | void> {}

  /**
   * Called **after** a tool's outcome is known — for real executions, for
   * `block` (carries the `reason` as `output`), and for `substitute`
   * (carries the substituted `output`). Backed by the AI SDK's
   * `experimental_onToolCallFinish`, so `durationMs` and the discriminated
   * `success`/`output`/`error` outcome reflect what the model actually
   * sees: a thrown error from the original `execute` becomes
   * `success: false, error: ...`; everything else (including blocked /
   * substituted calls) is `success: true, output: ...`.
   *
   * Override for logging, metrics, or result inspection.
   *
   * @example
   * ```typescript
   * afterToolCall(ctx: ToolCallResultContext) {
   *   if (ctx.success) {
   *     console.log(`${ctx.toolName} ok in ${ctx.durationMs}ms`);
   *   } else {
   *     console.error(`${ctx.toolName} failed:`, ctx.error);
   *   }
   * }
   * ```
   */
  afterToolCall(_ctx: ToolCallResultContext): void | Promise<void> {}

  /**
   * Called after each step completes (initial, continue, tool-result).
   * Override for step-level logging or analytics.
   */
  onStepFinish(_ctx: StepContext): void | Promise<void> {}

  /**
   * Called for each streaming chunk. High-frequency — fires per token.
   * Override for streaming analytics, progress indicators, or token counting.
   * Observational only (void return).
   */
  onChunk(_ctx: ChunkContext): void | Promise<void> {}

  /**
   * Called after a chat turn completes and the assistant message has been
   * persisted. The turn lock is released before this hook runs, so it is
   * safe to call other methods from inside.
   *
   * Fires for all turn completion paths: WebSocket chat requests,
   * sub-agent RPC, and auto-continuation.
   *
   * Override for logging, chaining, analytics, usage tracking.
   */
  onChatResponse(_result: ChatResponseResult): void | Promise<void> {}

  /**
   * Handle an error that occurred during a chat turn.
   * Override to customize error handling (e.g. logging, metrics).
   */
  onChatError(error: unknown): unknown {
    return error;
  }

  // ── Extension initialization ───────────────────────────────────

  private async _initializeExtensions(): Promise<void> {
    const { ExtensionManager } = await import("./extensions/manager");
    const { sanitizeName } = await import("./extensions/manager");

    // 3. Create ExtensionManager with host binding if HostBridgeLoopback
    // is re-exported from the worker entry point.
    const agentClassName = this.constructor.name;
    const agentId = this.ctx.id.toString();
    const ctxExports = (this.ctx as unknown as Record<string, unknown>)
      .exports as Record<string, unknown> | undefined;
    const hasBridge =
      ctxExports && typeof ctxExports.HostBridgeLoopback === "function";

    this.extensionManager = new ExtensionManager({
      loader: this.extensionLoader!,
      storage: this.ctx.storage,
      ...(hasBridge
        ? {
            createHostBinding: (
              permissions: import("./extensions/types").ExtensionPermissions,
              ownContextLabels: string[]
            ) =>
              (
                ctxExports.HostBridgeLoopback as (opts: {
                  props: Record<string, unknown>;
                }) => Fetcher
              )({
                props: {
                  agentClassName,
                  agentId,
                  permissions,
                  ownContextLabels
                }
              })
          }
        : {})
    });

    // 4. Load static extensions from getExtensions()
    const configs = this.getExtensions();
    for (const config of configs) {
      await this.extensionManager.load(config.manifest, config.source);
    }

    // 5. Restore dynamic extensions from DO storage
    await this.extensionManager.restore();

    // 6. Register extension context blocks in Session (mutation phase).
    // Context blocks use SQLite-backed AgentContextProvider (no bridge
    // delegation to the extension Worker). Extensions write to their
    // blocks via host.setContext() (Phase 3). Bridge providers that
    // delegate to extension Worker RPC methods are Phase 4.
    for (const ext of this.extensionManager.list()) {
      const manifest = this.extensionManager.getManifest(ext.name);
      if (!manifest?.context) continue;

      const prefix = sanitizeName(ext.name);
      for (const ctxDef of manifest.context) {
        const namespacedLabel = `${prefix}_${ctxDef.label}`;
        await this.session.addContext(namespacedLabel, {
          description: ctxDef.description,
          maxTokens: ctxDef.maxTokens
        });
      }
    }

    // Wire unload callback to clean up context blocks
    this.extensionManager.onUnload(async (_name, contextLabels) => {
      for (const label of contextLabels) {
        this.session.removeContext(label);
      }
      await this.session.refreshSystemPrompt();
    });
  }

  // ── Inference loop (Think owns this) ──────────────────────────

  /**
   * The single convergence point for all chat turn entry paths.
   * Merges tools, assembles context, fires lifecycle hooks, wraps tools
   * for interception, and calls streamText.
   */
  private async _runInferenceLoop(input: TurnInput): Promise<StreamableResult> {
    if (this.waitForMcpConnections) {
      const timeout =
        typeof this.waitForMcpConnections === "object"
          ? this.waitForMcpConnections.timeout
          : 10_000;
      await this.mcp.waitForConnections({ timeout });
    }

    const workspaceTools = createWorkspaceTools(this.workspace);
    const baseTools = this.getTools();
    const extensionTools = this.extensionManager?.getTools() ?? {};
    const contextTools = await this.session.tools();
    const clientToolSet = createToolsFromClientSchemas(input.clientTools);
    const tools: ToolSet = {
      ...workspaceTools,
      ...baseTools,
      ...extensionTools,
      ...contextTools,
      ...(this.mcp?.getAITools?.() ?? {}),
      ...clientToolSet
    };

    const frozenPrompt = await this.session.freezeSystemPrompt();
    const baseSystem = frozenPrompt || this.getSystemPrompt();
    const system = this._systemPromptForTurn(baseSystem, tools);

    const history = this.messages;
    const truncated = truncateOlderMessages(history) as UIMessage[];
    const messages = await convertToModelMessages(truncated, { tools });

    if (messages.length === 0) {
      throw new Error(
        "No messages to send to the model. This usually means the chat request " +
          "arrived before any messages were persisted."
      );
    }

    const model = this.getModel();
    const ctx: TurnContext = {
      system,
      messages,
      tools,
      model,
      continuation: input.continuation,
      body: input.body
    };

    const subclassConfig = (await this.beforeTurn(ctx)) ?? {};
    const config = await this._pipelineExtensionBeforeTurn(ctx, subclassConfig);
    const workflowPrompt = input.workflowPrompt;
    const workflowOutput = workflowPrompt?.output
      ? Output.object({
          schema: jsonSchema(workflowPrompt.output.schema as never)
        })
      : undefined;

    const finalModel = config.model ?? model;
    const finalSystem =
      config.system ??
      this._systemPromptForTurn(
        baseSystem,
        config.tools ? { ...tools, ...config.tools } : tools
      );
    const finalMessages = config.messages ?? messages;
    const mergedTools: ToolSet = config.tools
      ? { ...tools, ...config.tools }
      : tools;
    // Wrap each tool's `execute` so `beforeToolCall` is consulted before
    // the tool actually runs. The wrapped `execute` honors the returned
    // `ToolCallDecision` — `block` short-circuits with `reason`,
    // `substitute` returns `output` directly, `allow` runs the original
    // (optionally with modified `input`).
    const finalTools: ToolSet = this._wrapToolsWithDecision(mergedTools);
    const finalMaxSteps = config.maxSteps ?? this.maxSteps;
    const finalSendReasoning = config.sendReasoning ?? this.sendReasoning;
    const finalOutput = workflowOutput ?? config.output;
    const finalStopWhen = [
      stepCountIs(finalMaxSteps),
      ...(Array.isArray(config.stopWhen)
        ? config.stopWhen
        : config.stopWhen
          ? [config.stopWhen]
          : [])
    ];

    const result = streamText({
      model: finalModel,
      system: finalSystem,
      messages: finalMessages,
      tools: finalTools,
      activeTools: config.activeTools,
      toolChoice: config.toolChoice,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      topP: config.topP,
      topK: config.topK,
      presencePenalty: config.presencePenalty,
      frequencyPenalty: config.frequencyPenalty,
      stopSequences: config.stopSequences,
      seed: config.seed,
      maxRetries: config.maxRetries,
      timeout: config.timeout,
      headers: config.headers,
      stopWhen: finalStopWhen,
      providerOptions: config.providerOptions as
        | Parameters<typeof streamText>[0]["providerOptions"]
        | undefined,
      experimental_telemetry: config.experimental_telemetry,
      // Forward the per-turn structured-output spec from TurnConfig so
      // callers can use AI SDK `Output.object({ schema })` / `Output.text()`
      // on the terminal turn without dropping tools at model construction.
      output: finalOutput,
      abortSignal: input.signal,
      // Forward the AI SDK's `prepareStep` callback unchanged so subclasses
      // can make per-step decisions from the previous steps, current
      // messages, model, and experimental context.
      //
      // Subclass-only by design: extension dispatch is intentionally not
      // wired here. The prepareStep event includes a live `LanguageModel`
      // instance which is not JSON-serializable, and a returned override
      // can include the same — there's no useful "snapshot, override"
      // contract we could give to sandboxed extensions. If we expose
      // observation-only later it should go through a separate,
      // serialized event surface.
      //
      // `beforeStep` returning `void`/`undefined`/`null` is normalized to
      // `{}` so the AI SDK falls back to top-level settings (it accepts
      // `undefined` per docs but the typed return is non-null).
      prepareStep: (async (event) => {
        const result = await this.beforeStep(event);
        return result == null ? {} : result;
      }) satisfies PrepareStepFunction<ToolSet>,
      onChunk: async (event) => {
        // Pass the AI SDK's chunk event through unchanged — gives users
        // access to the discriminated `TextStreamPart` chunk with all
        // provider metadata.
        await this.onChunk(event);
        await this._pipelineExtensionChunk(event);
      },
      onStepFinish: async (event) => {
        // Pass the full StepResult through — gives users access to
        // reasoning, sources, files, providerMetadata (cache tokens),
        // request/response, warnings, and the full LanguageModelUsage
        // that the AI SDK provides.
        await this.onStepFinish(event);
        await this._pipelineExtensionStepFinish(event);
      },
      // `beforeToolCall` is dispatched from the wrapped `execute` (see
      // `_wrapToolsWithDecision` above) so the returned `ToolCallDecision`
      // can actually intercept the call. `afterToolCall` is wired through
      // the AI SDK's `experimental_onToolCallFinish` callback so we get
      // accurate `durationMs` and the discriminated `success`/`error`
      // outcome — including failures that propagate out of `execute`.
      experimental_onToolCallFinish: (async (event) => {
        const base = {
          ...event.toolCall,
          stepNumber: event.stepNumber,
          messages: event.messages,
          durationMs: event.durationMs
        };
        const ctx = (
          event.success
            ? { ...base, success: true as const, output: event.output }
            : { ...base, success: false as const, error: event.error }
        ) as ToolCallResultContext;
        await this.afterToolCall(ctx);
        await this._pipelineExtensionToolCallFinish(event);
      }) satisfies StreamTextOnToolCallFinishCallback<ToolSet>
    });

    const outputPromise =
      finalOutput && result.output ? Promise.resolve(result.output) : undefined;
    if (outputPromise) {
      // Attach a rejection observer immediately. `_streamResult()` will still
      // await this promise when captureOutput is enabled, but aborted streams can
      // reject before the stream consumer reaches that point.
      void outputPromise.catch(() => {});
    }

    const streamResult = {
      toUIMessageStream: () =>
        result.toUIMessageStream({ sendReasoning: finalSendReasoning }),
      output: outputPromise
    } satisfies StreamableResult;

    return this._transformInferenceResult(streamResult);
  }

  /** @internal Test seam — override in test agents to wrap the stream (e.g. error injection). */
  protected _transformInferenceResult(
    result: StreamableResult
  ): StreamableResult {
    return result;
  }

  /** Default hook timeout in milliseconds. */
  hookTimeout = 5000;

  /**
   * Pipeline beforeTurn through sandboxed extensions in load order.
   * Each extension sees the accumulated state from prior extensions
   * (snapshot is rebuilt after each extension's modifications).
   * Results are merged with last-write-wins for scalar fields.
   * Extensions that don't subscribe to beforeTurn are skipped.
   */
  private async _pipelineExtensionBeforeTurn(
    ctx: TurnContext,
    subclassConfig: TurnConfig
  ): Promise<TurnConfig> {
    if (!this.extensionManager) return subclassConfig;

    const subscribers = this.extensionManager.getHookSubscribers("beforeTurn");
    if (subscribers.length === 0) return subclassConfig;

    const { createTurnContextSnapshot, parseHookResult } =
      await import("./extensions/hook-proxy");

    let snapshot = createTurnContextSnapshot(ctx);
    let accumulated = { ...subclassConfig };

    // Apply subclass config to the initial snapshot so extensions
    // see the subclass overrides
    if (accumulated.system !== undefined) snapshot.system = accumulated.system;
    if (accumulated.maxSteps !== undefined)
      snapshot.messageCount = ctx.messages.length;

    for (const sub of subscribers) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const resultJson = await Promise.race([
          sub.entrypoint.hook("beforeTurn", snapshot),
          new Promise<string>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Hook timeout: ${sub.name}`)),
              this.hookTimeout
            );
          })
        ]);

        const parsed = parseHookResult(resultJson);
        if ("config" in parsed) {
          // Merge serializable scalars only. model and tools are skipped —
          // sandboxed extensions can't return LanguageModel or AI SDK Tool
          // objects (not serializable across RPC). Use activeTools to
          // control which tools the model can call.
          if (parsed.config.system !== undefined)
            accumulated.system = parsed.config.system;
          if (parsed.config.messages !== undefined)
            accumulated.messages = parsed.config.messages;
          if (parsed.config.activeTools !== undefined)
            accumulated.activeTools = parsed.config.activeTools;
          if (parsed.config.toolChoice !== undefined)
            accumulated.toolChoice = parsed.config.toolChoice;
          if (parsed.config.maxSteps !== undefined)
            accumulated.maxSteps = parsed.config.maxSteps;
          if (parsed.config.sendReasoning !== undefined)
            accumulated.sendReasoning = parsed.config.sendReasoning;
          if (parsed.config.maxOutputTokens !== undefined)
            accumulated.maxOutputTokens = parsed.config.maxOutputTokens;
          if (parsed.config.temperature !== undefined)
            accumulated.temperature = parsed.config.temperature;
          if (parsed.config.topP !== undefined)
            accumulated.topP = parsed.config.topP;
          if (parsed.config.topK !== undefined)
            accumulated.topK = parsed.config.topK;
          if (parsed.config.presencePenalty !== undefined)
            accumulated.presencePenalty = parsed.config.presencePenalty;
          if (parsed.config.frequencyPenalty !== undefined)
            accumulated.frequencyPenalty = parsed.config.frequencyPenalty;
          if (parsed.config.stopSequences !== undefined)
            accumulated.stopSequences = parsed.config.stopSequences;
          if (parsed.config.seed !== undefined)
            accumulated.seed = parsed.config.seed;
          if (parsed.config.maxRetries !== undefined)
            accumulated.maxRetries = parsed.config.maxRetries;
          if (parsed.config.timeout !== undefined)
            accumulated.timeout = parsed.config.timeout;
          if (parsed.config.headers !== undefined) {
            accumulated.headers = {
              ...(accumulated.headers ?? {}),
              ...parsed.config.headers
            };
          }
          if (parsed.config.providerOptions !== undefined) {
            accumulated.providerOptions = {
              ...(accumulated.providerOptions ?? {}),
              ...parsed.config.providerOptions
            };
          }
          // Update snapshot so next extension sees this extension's changes
          if (accumulated.system !== undefined)
            snapshot = { ...snapshot, system: accumulated.system };
          if (accumulated.activeTools !== undefined)
            snapshot = { ...snapshot, toolNames: accumulated.activeTools };
        } else if ("error" in parsed) {
          console.warn(
            `[Think] Extension "${sub.name}" beforeTurn error:`,
            parsed.error
          );
        }
      } catch (err) {
        console.warn(
          `[Think] Extension "${sub.name}" beforeTurn failed:`,
          err instanceof Error ? err.message : err
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    return accumulated;
  }

  /**
   * Dispatch an observation hook to all extensions that subscribe to it.
   *
   * Used by `_pipelineExtensionToolCallStart`, `_pipelineExtensionToolCallFinish`,
   * `_pipelineExtensionStepFinish`, and `_pipelineExtensionChunk`. Unlike
   * `beforeTurn`, these hooks are observation-only — extensions can't
   * influence the turn — so we ignore return values, log errors, and
   * apply a per-extension timeout.
   *
   * `onChunk` is high-frequency (per token) — extensions that subscribe
   * to it pay an RPC cost per chunk and should be used sparingly.
   */
  private async _dispatchExtensionObservation(
    hookName: "beforeToolCall" | "afterToolCall" | "onStepFinish" | "onChunk",
    snapshot: unknown
  ): Promise<void> {
    if (!this.extensionManager) return;
    const subscribers = this.extensionManager.getHookSubscribers(hookName);
    if (subscribers.length === 0) return;

    for (const sub of subscribers) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sub.entrypoint.hook(hookName, snapshot),
          new Promise<string>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Hook timeout: ${sub.name}`)),
              this.hookTimeout
            );
          })
        ]);
      } catch (err) {
        console.warn(
          `[Think] Extension "${sub.name}" ${hookName} failed:`,
          err instanceof Error ? err.message : err
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  /**
   * Wrap each tool's `execute` function so the agent's `beforeToolCall`
   * hook is consulted before the tool runs. The hook can return a
   * `ToolCallDecision` to:
   *
   * - `allow` (default if `void` is returned) — run the original
   *   `execute`, optionally with a substituted `input`.
   * - `block` — skip `execute` and return `reason` (or a default string)
   *   as the tool result. The model sees this as the tool's output.
   * - `substitute` — skip `execute` and return `output` directly. The
   *   model sees this as the tool's output.
   *
   * The wrapped `execute` also dispatches the `beforeToolCall`
   * observation snapshot to subscribed extensions. `afterToolCall` is
   * still wired through the AI SDK's `experimental_onToolCallFinish`
   * callback so we get accurate `durationMs` and proper success/error
   * discrimination — `block` and `substitute` outcomes show up as
   * `success: true` with the substituted output; uncaught throws from
   * the original `execute` show up as `success: false` with the error.
   *
   * Tools without an `execute` (output-schema-only tools, client tools
   * routed via `needsApproval`) are left untouched.
   *
   * **Streaming tools (AsyncIterable):** the AI SDK supports tools whose
   * `execute` returns `AsyncIterable<output>` to emit preliminary
   * results before a final value. This works whether the iterator is
   * returned directly (sync function, `async function*`) or wrapped in
   * a Promise (`async function execute(...) { return makeIter(); }`).
   * Because the wrapper must `await beforeToolCall` first, preliminary
   * chunks are collapsed — only the *final* yielded value reaches the
   * model. If you need true preliminary streaming, override
   * `getTools()` to provide such tools and avoid using `beforeToolCall`
   * for them (or accept the collapse).
   */
  private _wrapToolsWithDecision(tools: ToolSet): ToolSet {
    const wrapped: ToolSet = {};
    for (const [toolName, originalTool] of Object.entries(tools)) {
      const t = originalTool as Record<string, unknown>;
      const originalExecute = t.execute as
        | ((input: unknown, options: unknown) => unknown | Promise<unknown>)
        | undefined;
      if (typeof originalExecute !== "function") {
        wrapped[toolName] = originalTool;
        continue;
      }

      const isDynamic = t.type === "dynamic";

      const wrappedExecute = async (
        input: unknown,
        options: {
          toolCallId: string;
          messages: ModelMessage[];
          abortSignal?: AbortSignal;
          experimental_context?: unknown;
        }
      ): Promise<unknown> => {
        // Build the discriminated `TypedToolCall`-shaped context.
        const toolCallBase = {
          type: "tool-call" as const,
          toolCallId: options.toolCallId,
          toolName,
          input,
          ...(isDynamic ? { dynamic: true as const } : {})
        };

        const ctx = {
          ...toolCallBase,
          stepNumber: undefined,
          messages: options.messages,
          abortSignal: options.abortSignal
        } as ToolCallContext;

        // Subclass decision first.
        const decision = await this.beforeToolCall(ctx);

        // Extension observation dispatch — runs after the subclass so
        // extensions see whatever effect the subclass had on the
        // decision shape (input substitution shows up in the snapshot).
        const dispatchInput =
          decision && decision.action === "allow" && decision.input
            ? decision.input
            : input;
        await this._pipelineExtensionToolCallStart({
          toolCall: {
            ...toolCallBase,
            input: dispatchInput
          } as TypedToolCall<ToolSet>,
          stepNumber: undefined
        });

        // Resolve the decision.
        if (!decision || decision.action === "allow") {
          const finalInput = decision?.input ?? input;
          // Await before inspecting so we detect AsyncIterable returns
          // whether the original `execute` returned them directly (sync
          // function or `async function*`) or wrapped in a Promise (a
          // plain async function that returns an iterator). Without the
          // await, `Symbol.asyncIterator in result` would be false for
          // any `Promise<AsyncIterable>`, the collapse below would be
          // skipped, and the AI SDK would treat the iterator instance
          // itself as the final output value (broken).
          const result = await originalExecute(finalInput, options);
          // If the resolved value is an AsyncIterable (streaming tool
          // emitting preliminary outputs), collapse to the last yielded
          // value. We trade preliminary streaming for `beforeToolCall`
          // interception support.
          if (
            result != null &&
            typeof result === "object" &&
            Symbol.asyncIterator in (result as object)
          ) {
            let last: unknown;
            for await (const part of result as AsyncIterable<unknown>) {
              last = part;
            }
            return last;
          }
          return result;
        }
        if (decision.action === "block") {
          return (
            decision.reason ??
            `Tool "${toolName}" was blocked by beforeToolCall.`
          );
        }
        // substitute
        return decision.output;
      };

      wrapped[toolName] = {
        ...(originalTool as object),
        execute: wrappedExecute
      } as ToolSet[string];
    }
    return wrapped;
  }

  private async _pipelineExtensionToolCallStart(event: {
    toolCall: TypedToolCall<ToolSet>;
    stepNumber: number | undefined;
  }): Promise<void> {
    if (!this.extensionManager) return;
    if (this.extensionManager.getHookSubscribers("beforeToolCall").length === 0)
      return;
    const { createToolCallStartSnapshot } =
      await import("./extensions/hook-proxy");
    await this._dispatchExtensionObservation(
      "beforeToolCall",
      createToolCallStartSnapshot(event)
    );
  }

  private async _pipelineExtensionToolCallFinish(event: {
    toolCall: TypedToolCall<ToolSet>;
    stepNumber: number | undefined;
    durationMs: number;
    success: boolean;
    output?: unknown;
    error?: unknown;
  }): Promise<void> {
    if (!this.extensionManager) return;
    if (this.extensionManager.getHookSubscribers("afterToolCall").length === 0)
      return;
    const { createToolCallFinishSnapshot } =
      await import("./extensions/hook-proxy");
    await this._dispatchExtensionObservation(
      "afterToolCall",
      createToolCallFinishSnapshot(event)
    );
  }

  private async _pipelineExtensionStepFinish(
    event: StepContext
  ): Promise<void> {
    if (!this.extensionManager) return;
    if (this.extensionManager.getHookSubscribers("onStepFinish").length === 0)
      return;
    const { createStepFinishSnapshot } =
      await import("./extensions/hook-proxy");
    await this._dispatchExtensionObservation(
      "onStepFinish",
      createStepFinishSnapshot(event)
    );
  }

  private async _pipelineExtensionChunk(event: ChunkContext): Promise<void> {
    if (!this.extensionManager) return;
    if (this.extensionManager.getHookSubscribers("onChunk").length === 0)
      return;
    const { createChunkSnapshot } = await import("./extensions/hook-proxy");
    await this._dispatchExtensionObservation(
      "onChunk",
      createChunkSnapshot(event as { chunk: { type: string } })
    );
  }

  // ── Host bridge methods (called by HostBridgeLoopback via DO RPC) ──

  async _hostReadFile(path: string): Promise<string | null> {
    return (await this.workspace.readFile(path)) ?? null;
  }

  async _hostWriteFile(path: string, content: string): Promise<void> {
    await this.workspace.writeFile(path, content);
  }

  async _hostDeleteFile(path: string): Promise<boolean> {
    try {
      await this.workspace.rm(path);
      return true;
    } catch {
      return false;
    }
  }

  async _hostListFiles(
    dir: string
  ): Promise<
    Array<{ name: string; type: string; size: number; path: string }>
  > {
    const entries = await this.workspace.readDir(dir);
    return entries.map((e) => ({
      name: e.name,
      type: e.type,
      size: e.size ?? 0,
      path: e.path ?? `${dir}/${e.name}`
    }));
  }

  async _hostGetContext(label: string): Promise<string | null> {
    const block = this.session.getContextBlock(label);
    return block?.content ?? null;
  }

  async _hostSetContext(label: string, content: string): Promise<void> {
    await this.session.replaceContextBlock(label, content);
  }

  async _hostGetMessages(
    limit?: number
  ): Promise<Array<{ id: string; role: string; content: string }>> {
    const history = this.messages;
    const sliced =
      limit !== undefined && limit !== null
        ? limit <= 0
          ? []
          : history.slice(-limit)
        : history;
    return sliced.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
    }));
  }

  async _hostSendMessage(content: string): Promise<void> {
    const msg = {
      id: crypto.randomUUID(),
      role: "user" as const,
      parts: [{ type: "text" as const, text: content }]
    };
    // Append directly to session — do NOT route through saveMessages,
    // which enqueues a full turn via TurnQueue and would deadlock if
    // called during an active turn (tool execution → host.sendMessage
    // → saveMessages → TurnQueue.enqueue → awaits current turn → deadlock).
    // The injected message is visible in the next turn's history.
    await this._appendMessageToHistory(msg);
  }

  async _hostGetSessionInfo(): Promise<{
    messageCount: number;
  }> {
    return {
      messageCount: this.messages.length
    };
  }

  // ── Sub-agent RPC entry point ───────────────────────────────────

  /**
   * Run a chat turn: persist the user message, run the agentic loop,
   * stream UIMessageChunk events via callback, and persist the
   * assistant's response.
   *
   * @param userMessage The user's message (string or UIMessage)
   * @param callback Streaming callback (typically an RpcTarget from the parent)
   * @param options Optional chat options (e.g. AbortSignal)
   */
  async chat(
    userMessage: string | UIMessage,
    callback: StreamCallback,
    options?: ChatOptions
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const abortSignal = this._aborts.getSignal(requestId);
    const detachExternal = this._aborts.linkExternal(
      requestId,
      options?.signal
    );
    const ignoredTools = (options as { tools?: unknown } | undefined)?.tools;
    if (
      ignoredTools != null &&
      typeof ignoredTools === "object" &&
      Object.keys(ignoredTools).length > 0
    ) {
      console.warn(
        "[Think] chat() no longer accepts options.tools. Define durable tools on the child agent with getTools(), or use runAgentTool()/agentTool() for parent-child orchestration."
      );
    }

    try {
      await callback.onStart({ requestId });
      await this.keepAliveWhile(async () => {
        await this._turnQueue.enqueue(requestId, async () => {
          const userMsg: UIMessage =
            typeof userMessage === "string"
              ? {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts: [{ type: "text", text: userMessage }]
                }
              : userMessage;

          await this._appendMessageToHistory(userMsg);
          this._broadcastMessages();

          const chatBody = async () => {
            let result: StreamableResult;
            try {
              result = await agentContext.run(
                {
                  agent: this,
                  connection: undefined,
                  request: undefined,
                  email: undefined
                },
                () =>
                  this._runInferenceLoop({
                    signal: abortSignal,
                    continuation: false
                  })
              );
            } catch (error) {
              const wrapped = this.onChatError(error);
              const errorMessage =
                wrapped instanceof Error ? wrapped.message : String(wrapped);
              await callback.onError(errorMessage);
              return;
            }

            await this._streamResultToRpcCallback(
              requestId,
              result,
              callback,
              abortSignal
            );
          };

          if (this.chatRecovery) {
            await this._runChatRecoveryFiber(requestId, false, chatBody);
          } else {
            await chatBody();
          }
        });
      });
    } finally {
      detachExternal();
      this._aborts.remove(requestId);
    }
  }

  // ── Message access ──────────────────────────────────────────────

  /** Get the conversation history as UIMessage[]. */
  async getMessages(): Promise<UIMessage[]> {
    return this.messages.slice();
  }

  /** Clear all messages from storage. */
  async clearMessages(): Promise<void> {
    this.resetTurnState();
    await this._clearHistory();
    this._broadcast({ type: MSG_CHAT_CLEAR });
  }

  private _ensureAgentToolChildRunTable(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agent_tool_child_runs (
        run_id TEXT PRIMARY KEY,
        request_id TEXT,
        stream_id TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        output_json TEXT,
        error_message TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      )
    `;

    this._addAgentToolChildRunColumnIfMissing(
      "ALTER TABLE cf_agent_tool_child_runs ADD COLUMN output_json TEXT"
    );
  }

  private _addAgentToolChildRunColumnIfMissing(sql: string): void {
    try {
      this.ctx.storage.sql.exec(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
  }

  private _readAgentToolChildRun(runId: string): AgentToolChildRunRow | null {
    this._ensureAgentToolChildRunTable();
    const rows = this.sql<AgentToolChildRunRow>`
      SELECT run_id, request_id, stream_id, status, summary, output_json,
             error_message, started_at, completed_at
      FROM cf_agent_tool_child_runs
      WHERE run_id = ${runId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _inspectionFromChildRow<Output>(
    row: AgentToolChildRunRow,
    output?: Output
  ): AgentToolRunInspection<Output> {
    const storedOutput =
      row.output_json === null
        ? output
        : (Think._parseAgentToolOutput(row.output_json) as Output);

    return {
      runId: row.run_id,
      status: row.status,
      requestId: row.request_id ?? undefined,
      streamId: row.stream_id ?? undefined,
      output: storedOutput,
      summary: row.summary ?? undefined,
      error: row.error_message ?? undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined
    };
  }

  protected formatAgentToolInput(input: unknown): UIMessage {
    const text =
      typeof input === "string" ? input : JSON.stringify(input, null, 2);
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }]
    };
  }

  protected getAgentToolOutput(_runId: string): unknown {
    return undefined;
  }

  protected getAgentToolSummary(runId: string, output: unknown): string {
    const text = this._getAgentToolFinalText(runId);
    if (text) return text;
    if (typeof output === "string") return output;
    if (output !== undefined) {
      try {
        return JSON.stringify(output);
      } catch {
        return String(output);
      }
    }
    return "";
  }

  async startAgentToolRun(
    input: unknown,
    options: { runId: string }
  ): Promise<AgentToolRunInspection> {
    const existing = this._readAgentToolChildRun(options.runId);
    if (existing) return this._inspectionFromChildRow(existing);

    const startedAt = Date.now();
    this.sql`
      INSERT INTO cf_agent_tool_child_runs (run_id, status, started_at)
      VALUES (${options.runId}, 'starting', ${startedAt})
    `;

    const controller = new AbortController();
    this._agentToolAbortControllers.set(options.runId, controller);
    this._agentToolLiveSequences.set(options.runId, 0);
    this._agentToolPreTurnAssistantIds.set(
      options.runId,
      new Set(
        this.messages.filter((m) => m.role === "assistant").map((m) => m.id)
      )
    );

    const epoch = this._turnQueue.generation;
    void this.keepAliveWhile(async () => {
      try {
        this.sql`
          UPDATE cf_agent_tool_child_runs
          SET status = 'running'
          WHERE run_id = ${options.runId} AND status = 'starting'
        `;
        const result = await this.saveMessages(
          [this.formatAgentToolInput(input)],
          {
            signal: controller.signal
          }
        );
        const streamId =
          this._resumableStream
            .getAllStreamMetadata()
            .find((m) => m.request_id === result.requestId)?.id ?? null;
        const output = this.getAgentToolOutput(options.runId);
        const summary = this.getAgentToolSummary(options.runId, output);
        const streamError =
          result.error ?? this._agentToolLastErrors.get(options.runId);
        const skipped =
          result.status === "skipped" ||
          (result.status === "aborted" && this._turnQueue.generation !== epoch);
        const status: AgentToolChildRunStatus =
          result.status === "error" || skipped || streamError
            ? "error"
            : result.status === "aborted"
              ? "aborted"
              : "completed";
        const error: string | null =
          status === "error"
            ? (streamError ??
              "Agent tool run was skipped before the child could finish.")
            : null;
        this.sql`
          UPDATE cf_agent_tool_child_runs
          SET request_id = ${result.requestId},
              stream_id = ${streamId},
              status = ${status},
              summary = ${summary},
              output_json = ${Think._stringifyAgentToolOutput(output)},
              error_message = ${error},
              completed_at = ${Date.now()}
          WHERE run_id = ${options.runId}
            AND completed_at IS NULL
        `;
      } catch (error) {
        this.sql`
          UPDATE cf_agent_tool_child_runs
          SET status = 'error',
              error_message = ${error instanceof Error ? error.message : String(error)},
              completed_at = ${Date.now()}
          WHERE run_id = ${options.runId}
            AND completed_at IS NULL
        `;
      } finally {
        this._agentToolAbortControllers.delete(options.runId);
        this._agentToolForwarders.delete(options.runId);
        this._agentToolLiveSequences.delete(options.runId);
        this._agentToolLastErrors.delete(options.runId);
        this._agentToolPreTurnAssistantIds.delete(options.runId);
        for (const close of this._agentToolClosers.get(options.runId) ?? []) {
          close();
        }
        this._agentToolClosers.delete(options.runId);
      }
    });

    return {
      runId: options.runId,
      status: "running",
      startedAt
    };
  }

  async cancelAgentToolRun(runId: string, reason?: unknown): Promise<void> {
    const row = this._readAgentToolChildRun(runId);
    if (!row || row.completed_at !== null) return;
    this._agentToolAbortControllers.get(runId)?.abort(reason);
    this.sql`
      UPDATE cf_agent_tool_child_runs
      SET status = 'aborted',
          error_message = ${reason instanceof Error ? reason.message : reason === undefined ? null : String(reason)},
          completed_at = ${Date.now()}
      WHERE run_id = ${runId}
        AND status NOT IN ('completed', 'error', 'aborted')
    `;
  }

  async inspectAgentToolRun(
    runId: string
  ): Promise<AgentToolRunInspection | null> {
    const row = this._readAgentToolChildRun(runId);
    return row
      ? this._inspectionFromChildRow(row, this.getAgentToolOutput(runId))
      : null;
  }

  async getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]> {
    const row = this._readAgentToolChildRun(runId);
    if (!row?.stream_id) return [];
    this._resumableStream.flushBuffer();
    return this._resumableStream
      .getStreamChunks(row.stream_id)
      .filter((chunk) => chunk.chunk_index > (options?.afterSequence ?? -1))
      .map((chunk) => ({ sequence: chunk.chunk_index, body: chunk.body }));
  }

  async tailAgentToolRun(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<ReadableStream<AgentToolStoredChunk>> {
    const self = this;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const replayed = await self.getAgentToolChunks(runId, options);
        for (const chunk of replayed) {
          controller.enqueue(
            agentToolChunkEncoder.encode(`${JSON.stringify(chunk)}\n`)
          );
        }
        const lastReplay = replayed[replayed.length - 1]?.sequence;
        if (lastReplay !== undefined) {
          self._agentToolLiveSequences.set(runId, lastReplay + 1);
        }
        const row = self._readAgentToolChildRun(runId);
        if (!row || row.completed_at !== null) {
          controller.close();
          return;
        }
        const forward = (chunk: AgentToolStoredChunk) => {
          if (chunk.sequence > (options?.afterSequence ?? -1)) {
            controller.enqueue(
              agentToolChunkEncoder.encode(`${JSON.stringify(chunk)}\n`)
            );
          }
        };
        const close = () => {
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
        const forwarders = self._agentToolForwarders.get(runId) ?? new Set();
        forwarders.add(forward);
        self._agentToolForwarders.set(runId, forwarders);
        const closers = self._agentToolClosers.get(runId) ?? new Set();
        closers.add(close);
        self._agentToolClosers.set(runId, closers);
      },
      cancel(reason) {
        void self.cancelAgentToolRun(runId, reason);
      }
    });
    return stream as unknown as ReadableStream<AgentToolStoredChunk>;
  }

  private static _stringifyAgentToolOutput(output: unknown): string | null {
    if (output === undefined) return null;
    try {
      return JSON.stringify(output);
    } catch {
      return JSON.stringify(String(output));
    }
  }

  private static _parseAgentToolOutput(value: string | null): unknown {
    if (value === null) return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  private _getAgentToolFinalText(runId: string): string | null {
    const before = this._agentToolPreTurnAssistantIds.get(runId);
    if (!before) return null;
    for (const msg of this.messages) {
      if (msg.role !== "assistant" || before.has(msg.id)) continue;
      const text = msg.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter((part) => part.length > 0)
        .join("\n");
      if (text.length > 0) return text;
    }
    return null;
  }

  // ── Declarative scheduled tasks ─────────────────────────────────

  private _ensureDeclaredScheduledTasksTable(): void {
    if (this._declaredScheduledTasksTableEnsured) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_think_scheduled_tasks (
        owner_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        schedule_hash TEXT NOT NULL,
        task_hash TEXT NOT NULL,
        schedule_id TEXT,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_key, task_id)
      )
    `;
    this._declaredScheduledTasksTableEnsured = true;
  }

  private _readDeclaredScheduledTaskRow(
    taskId: string
  ): DeclaredScheduledTaskRow | null {
    this._ensureDeclaredScheduledTasksTable();
    const ownerKey = this._declaredScheduleOwnerKey();
    const rows = this.sql<DeclaredScheduledTaskRow>`
      SELECT owner_key, task_id, schedule_hash, task_hash, schedule_id,
             next_run_at, created_at, updated_at
      FROM cf_think_scheduled_tasks
      WHERE task_id = ${taskId}
        AND owner_key = ${ownerKey}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _listDeclaredScheduledTaskRows(): DeclaredScheduledTaskRow[] {
    this._ensureDeclaredScheduledTasksTable();
    const ownerKey = this._declaredScheduleOwnerKey();
    return this.sql<DeclaredScheduledTaskRow>`
      SELECT owner_key, task_id, schedule_hash, task_hash, schedule_id,
             next_run_at, created_at, updated_at
      FROM cf_think_scheduled_tasks
      WHERE owner_key = ${ownerKey}
      ORDER BY task_id ASC
    `;
  }

  private _updateDeclaredScheduledTaskSchedule(
    task: NormalizedDeclaredTask,
    ownerKey: string,
    scheduled: { scheduleId: string; scheduledFor: number },
    updatedAt = Date.now()
  ): void {
    this.sql`
      UPDATE cf_think_scheduled_tasks
      SET schedule_hash = ${task.scheduleHash},
          task_hash = ${task.taskHash},
          schedule_id = ${scheduled.scheduleId},
          next_run_at = ${scheduled.scheduledFor},
          updated_at = ${updatedAt}
      WHERE owner_key = ${ownerKey}
        AND task_id = ${task.taskId}
    `;
  }

  private async _normalizeDeclaredScheduledTasks(
    tasks: ThinkScheduledTasks,
    defaultTimezone: string | undefined
  ): Promise<Map<string, NormalizedDeclaredTask>> {
    const normalized = new Map<string, NormalizedDeclaredTask>();
    for (const [taskId, task] of Object.entries(tasks)) {
      if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
        throw new Error(
          `Invalid scheduled task id "${taskId}"; use letters, numbers, "_" or "-"`
        );
      }
      const schedule = parseDeclaredTaskSchedule(
        task.schedule,
        task.timezone,
        defaultTimezone
      );
      const hasPrompt = "prompt" in task && task.prompt !== undefined;
      const hasHandler = "handler" in task && task.handler !== undefined;
      if (hasPrompt === hasHandler) {
        throw new Error(
          `Scheduled task "${taskId}" must define exactly one of prompt or handler`
        );
      }
      const scheduleHash = stableHash({
        schedule,
        retry: task.retry
      });
      const actionHash = hasPrompt
        ? {
            type: "prompt",
            value: typeof task.prompt === "string" ? task.prompt : "<function>"
          }
        : { type: "handler" };
      const taskHash = stableHash({
        scheduleHash,
        action: actionHash,
        metadata: task.metadata
      });
      normalized.set(taskId, {
        taskId,
        ...(hasPrompt ? { prompt: task.prompt } : {}),
        ...(hasHandler ? { handler: task.handler } : {}),
        schedule,
        retry: task.retry,
        metadata: task.metadata,
        scheduleHash,
        taskHash
      });
    }
    return normalized;
  }

  private async _declaredScheduledTasksForNow(): Promise<
    Map<string, NormalizedDeclaredTask>
  > {
    const defaultTimezone = await this.getDefaultTimezone();
    const resolvedDefaultTimezone =
      defaultTimezone === undefined
        ? undefined
        : validateTimezone(defaultTimezone);
    return this._normalizeDeclaredScheduledTasks(
      await this.getScheduledTasks(),
      resolvedDefaultTimezone
    );
  }

  private _declaredScheduleOwnerKey(): string {
    return stableHash(this.selfPath);
  }

  private _declaredScheduleValidationError(
    rawSchedule: string,
    taskTimezone?: string,
    defaultTimezone?: string
  ): string | null {
    const resolvedDefaultTimezone =
      defaultTimezone === undefined
        ? undefined
        : validateTimezone(defaultTimezone);
    const result = tryParseDeclaredTaskSchedule(
      rawSchedule,
      taskTimezone,
      resolvedDefaultTimezone
    );
    return result.ok ? null : result.error;
  }

  private _nextDeclaredScheduleTimeForConfig(
    rawSchedule: string,
    now: Date,
    options: {
      taskTimezone?: string;
      defaultTimezone?: string;
      previousScheduledFor?: number;
    } = {}
  ): Date {
    const resolvedDefaultTimezone =
      options.defaultTimezone === undefined
        ? undefined
        : validateTimezone(options.defaultTimezone);
    return nextDeclaredScheduleTime(
      parseDeclaredTaskSchedule(
        rawSchedule,
        options.taskTimezone,
        resolvedDefaultTimezone
      ),
      now,
      options.previousScheduledFor
    );
  }

  private async _reconcileDeclaredScheduledTasks(): Promise<void> {
    const tasks = await this._declaredScheduledTasksForNow();
    this._ensureDeclaredScheduledTasksTable();
    const ownerKey = this._declaredScheduleOwnerKey();
    const now = Date.now();
    const existing = this._listDeclaredScheduledTaskRows();
    const seen = new Set<string>();

    for (const [taskId, task] of tasks) {
      seen.add(taskId);
      const row = existing.find((candidate) => candidate.task_id === taskId);
      if (!row) {
        this.sql`
          INSERT INTO cf_think_scheduled_tasks (
            owner_key, task_id, schedule_hash, task_hash, schedule_id,
            next_run_at, created_at, updated_at
          )
          VALUES (
            ${ownerKey}, ${taskId}, ${task.scheduleHash}, ${task.taskHash},
            NULL, NULL, ${now}, ${now}
          )
        `;
        const scheduled = await this._scheduleDeclaredTaskOccurrence(
          task,
          new Date(now)
        );
        this._updateDeclaredScheduledTaskSchedule(
          task,
          ownerKey,
          scheduled,
          now
        );
        continue;
      }

      if (row.schedule_hash !== task.scheduleHash) {
        if (row.schedule_id) await this.cancelSchedule(row.schedule_id);
        this.sql`
          UPDATE cf_think_scheduled_tasks
          SET schedule_hash = ${task.scheduleHash},
              task_hash = ${task.taskHash},
              schedule_id = NULL,
              next_run_at = NULL,
              updated_at = ${now}
          WHERE owner_key = ${ownerKey}
            AND task_id = ${taskId}
        `;
        const scheduled = await this._scheduleDeclaredTaskOccurrence(
          task,
          new Date(now)
        );
        this._updateDeclaredScheduledTaskSchedule(
          task,
          ownerKey,
          scheduled,
          now
        );
        continue;
      }

      if (!row.schedule_id) {
        const scheduled =
          row.next_run_at === null
            ? await this._scheduleDeclaredTaskOccurrence(task, new Date(now))
            : await this._scheduleDeclaredTaskOccurrenceAt(
                task,
                row.next_run_at
              );
        this._updateDeclaredScheduledTaskSchedule(
          task,
          ownerKey,
          scheduled,
          now
        );
        continue;
      }

      if (row.schedule_id) {
        const schedule = await this.getScheduleById(row.schedule_id);
        if (!schedule) {
          const scheduled =
            row.next_run_at === null
              ? await this._scheduleDeclaredTaskOccurrence(task, new Date(now))
              : await this._scheduleDeclaredTaskOccurrenceAt(
                  task,
                  row.next_run_at
                );
          this._updateDeclaredScheduledTaskSchedule(
            task,
            ownerKey,
            scheduled,
            now
          );
          continue;
        }
      }

      if (row.task_hash !== task.taskHash) {
        this.sql`
          UPDATE cf_think_scheduled_tasks
          SET task_hash = ${task.taskHash}, updated_at = ${now}
          WHERE owner_key = ${ownerKey}
            AND task_id = ${taskId}
        `;
      }
    }

    for (const row of existing) {
      if (seen.has(row.task_id)) continue;
      if (row.schedule_id) await this.cancelSchedule(row.schedule_id);
      this.sql`
        DELETE FROM cf_think_scheduled_tasks
        WHERE owner_key = ${ownerKey}
          AND task_id = ${row.task_id}
      `;
    }
  }

  private async _scheduleDeclaredTaskOccurrence(
    task: NormalizedDeclaredTask,
    now: Date,
    previousScheduledFor?: number
  ): Promise<{ scheduleId: string; scheduledFor: number }> {
    const next = nextDeclaredScheduleTime(
      task.schedule,
      now,
      previousScheduledFor
    );
    return this._scheduleDeclaredTaskOccurrenceAt(task, next.getTime());
  }

  private async _scheduleDeclaredTaskOccurrenceAt(
    task: NormalizedDeclaredTask,
    scheduledFor: number
  ): Promise<{ scheduleId: string; scheduledFor: number }> {
    const schedule = await this.schedule<DeclaredScheduledTaskPayload>(
      new Date(scheduledFor),
      "_runDeclaredScheduledTask",
      {
        taskId: task.taskId,
        scheduleHash: task.scheduleHash,
        scheduledFor
      },
      { idempotent: true }
    );
    return { scheduleId: schedule.id, scheduledFor };
  }

  private async _advanceDeclaredScheduledTask(
    task: NormalizedDeclaredTask,
    payload: DeclaredScheduledTaskPayload,
    ownerKey: string
  ): Promise<void> {
    const scheduled = await this._scheduleDeclaredTaskOccurrence(
      task,
      new Date(),
      payload.scheduledFor
    );
    this._updateDeclaredScheduledTaskSchedule(task, ownerKey, scheduled);
  }

  private _declaredScheduledTaskContext(
    task: NormalizedDeclaredTask,
    payload: DeclaredScheduledTaskPayload,
    ownerKey: string
  ): ThinkScheduledTaskContext {
    const occurrenceKey = `${payload.taskId}:${payload.scheduledFor}`;
    return {
      taskId: payload.taskId,
      scheduledFor: payload.scheduledFor,
      scheduledForDate: new Date(payload.scheduledFor),
      occurrenceKey,
      idempotencyKey: `think-schedule:${ownerKey}:${occurrenceKey}`,
      schedule: task.schedule.normalizedSchedule,
      scheduleKind: task.schedule.kind,
      ...(task.schedule.kind === "wall-clock" && {
        timezone: task.schedule.timezone
      }),
      ...(task.metadata !== undefined && { metadata: task.metadata })
    };
  }

  async _runDeclaredScheduledTask(
    payload: DeclaredScheduledTaskPayload
  ): Promise<void> {
    if (
      !payload ||
      typeof payload.taskId !== "string" ||
      typeof payload.scheduleHash !== "string" ||
      typeof payload.scheduledFor !== "number"
    ) {
      throw new Error("Invalid declared scheduled task payload");
    }

    const row = this._readDeclaredScheduledTaskRow(payload.taskId);
    if (!row || row.schedule_hash !== payload.scheduleHash) return;
    if (row.next_run_at !== null && row.next_run_at > payload.scheduledFor) {
      return;
    }

    const tasks = await this._declaredScheduledTasksForNow();
    const task = tasks.get(payload.taskId);
    if (!task || task.scheduleHash !== payload.scheduleHash) return;

    const ownerKey = this._declaredScheduleOwnerKey();
    const context = this._declaredScheduledTaskContext(task, payload, ownerKey);

    let actionError: unknown;
    try {
      await this.retry(async () => {
        if (task.prompt !== undefined) {
          const prompt =
            typeof task.prompt === "function"
              ? await task.prompt()
              : task.prompt;
          await this.submitMessages(
            [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text: prompt }]
              }
            ],
            {
              idempotencyKey: context.idempotencyKey,
              metadata: {
                ...task.metadata,
                source: "scheduled-task",
                ownerKey,
                taskId: payload.taskId,
                scheduledFor: payload.scheduledFor,
                schedule: task.schedule.normalizedSchedule
              }
            }
          );
        } else {
          await task.handler?.(context);
        }
      }, task.retry);
    } catch (error) {
      actionError = error;
    } finally {
      await this._advanceDeclaredScheduledTask(task, payload, ownerKey);
    }

    if (actionError !== undefined) {
      console.error(
        `[Think] Scheduled task "${payload.taskId}" failed; next occurrence was still scheduled`,
        actionError
      );
      try {
        await this.onError(actionError);
      } catch {
        // Preserve recurrence even if user error handling fails.
      }
    }
  }

  // ── Durable programmatic submissions ───────────────────────────

  private _ensureSubmissionTable(): void {
    if (this._submissionTableEnsured) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_think_submissions (
        submission_id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        request_id TEXT,
        stream_id TEXT,
        status TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        metadata_json TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        messages_applied_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS cf_think_submissions_status_created_idx
      ON cf_think_submissions (status, created_at, submission_id)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS cf_think_submissions_request_status_idx
      ON cf_think_submissions (request_id, status)
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS cf_think_submissions_status_completed_idx
      ON cf_think_submissions (status, completed_at, created_at)
    `;
    this._submissionTableEnsured = true;
  }

  private _ensureWorkflowNotificationTable(): void {
    if (this._workflowNotificationTableEnsured) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_think_workflow_notifications (
        notification_id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER
      )
    `;
    try {
      this.ctx.storage.sql.exec(
        "ALTER TABLE cf_think_workflow_notifications ADD COLUMN delivered_at INTEGER"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
    this.sql`
      CREATE INDEX IF NOT EXISTS cf_think_workflow_notifications_created_idx
      ON cf_think_workflow_notifications (delivered_at, created_at, notification_id)
    `;
    this._workflowNotificationTableEnsured = true;
  }

  private _readSubmission(submissionId: string): ThinkSubmissionRow | null {
    this._ensureSubmissionTable();
    const rows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      WHERE submission_id = ${submissionId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _readSubmissionByIdempotencyKey(
    idempotencyKey: string
  ): ThinkSubmissionRow | null {
    this._ensureSubmissionTable();
    const rows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _normalizeStatusFilter(
    status?: ThinkSubmissionStatus | ThinkSubmissionStatus[]
  ): Set<ThinkSubmissionStatus> | null {
    if (!status) return null;
    return new Set(Array.isArray(status) ? status : [status]);
  }

  private _listSubmissionRows(
    options?: ListSubmissionsOptions
  ): ThinkSubmissionRow[] {
    this._ensureSubmissionTable();
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
    const statuses = this._normalizeStatusFilter(options?.status);
    if (statuses) {
      return [...statuses]
        .flatMap((status) => this._listSubmissionRowsByStatus(status, limit))
        .sort((a, b) =>
          b.created_at === a.created_at
            ? b.submission_id.localeCompare(a.submission_id)
            : b.created_at - a.created_at
        )
        .slice(0, limit);
    }

    const rows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      ORDER BY created_at DESC, submission_id DESC
      LIMIT ${limit}
    `;
    return rows;
  }

  private _listSubmissionRowsByStatus(
    status: ThinkSubmissionStatus,
    limit: number
  ): ThinkSubmissionRow[] {
    return this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      WHERE status = ${status}
      ORDER BY created_at DESC, submission_id DESC
      LIMIT ${limit}
    `;
  }

  private _inspectionFromSubmissionRow(
    row: ThinkSubmissionRow
  ): ThinkSubmissionInspection {
    const metadata = this._parseJsonObject(row.metadata_json);
    return {
      submissionId: row.submission_id,
      idempotencyKey: row.idempotency_key ?? undefined,
      requestId: row.request_id ?? undefined,
      status: row.status,
      error: row.error_message ?? undefined,
      metadata: metadata ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined
    };
  }

  private _parseJsonObject(
    value: string | null
  ): Record<string, unknown> | null {
    if (value === null) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid metadata should not prevent inspection.
    }
    return null;
  }

  private _parseSubmissionMessages(value: string): UIMessage[] {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Stored submission messages are invalid");
    }
    return parsed as UIMessage[];
  }

  private _serializeSubmissionMessages(messages: UIMessage[]): string {
    return JSON.stringify(
      messages.map((message) => enforceRowSizeLimit(sanitizeMessage(message)))
    );
  }

  private _serializeMetadata(
    metadata: Record<string, unknown> | undefined
  ): string | null {
    return metadata === undefined ? null : JSON.stringify(metadata);
  }

  private _readWorkflowPromptContext(
    metadata: Record<string, unknown> | null
  ): ThinkWorkflowPromptContext | null {
    const workflowPromptValue = metadata?.[THINK_WORKFLOW_PROMPT_METADATA_KEY];
    if (
      workflowPromptValue === null ||
      typeof workflowPromptValue !== "object" ||
      Array.isArray(workflowPromptValue)
    ) {
      return null;
    }
    const workflowPrompt = workflowPromptValue as Record<string, unknown>;
    const workflowValue = workflowPrompt.workflow;
    if (
      workflowValue === null ||
      typeof workflowValue !== "object" ||
      Array.isArray(workflowValue)
    ) {
      return null;
    }
    const workflowRecord = workflowValue as Record<string, unknown>;
    if (
      typeof workflowRecord.name !== "string" ||
      typeof workflowRecord.id !== "string" ||
      typeof workflowRecord.stepName !== "string" ||
      typeof workflowRecord.eventType !== "string"
    ) {
      return null;
    }
    const output = workflowPrompt.output;
    const outputRecord =
      output !== null && typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, unknown>)
        : null;
    return {
      workflow: {
        name: workflowRecord.name,
        id: workflowRecord.id,
        stepName: workflowRecord.stepName,
        eventType: workflowRecord.eventType
      },
      ...(outputRecord
        ? {
            output: {
              schema: outputRecord.schema
            }
          }
        : {}),
      ...(typeof workflowPrompt.fingerprint === "string" && {
        fingerprint: workflowPrompt.fingerprint
      })
    };
  }

  private async _emitSubmissionStatus(
    row: ThinkSubmissionRow,
    output?: unknown
  ): Promise<void> {
    const inspection = this._inspectionFromSubmissionRow(row);
    this._emit("submission:status", {
      submissionId: inspection.submissionId,
      requestId: inspection.requestId,
      status: inspection.status
    });
    if (inspection.status === "error" && inspection.error) {
      this._emit("submission:error", {
        submissionId: inspection.submissionId,
        requestId: inspection.requestId,
        error: inspection.error
      });
    }
    if (this._isTerminalSubmissionStatus(inspection.status)) {
      await this._enqueueWorkflowNotification(inspection, output);
    }
    await this.keepAliveWhile(async () => {
      try {
        await this.onSubmissionStatus(inspection);
      } catch (error) {
        console.error("[Think] onSubmissionStatus failed", error);
      }
    });
  }

  protected onSubmissionStatus(
    _submission: ThinkSubmissionInspection
  ): void | Promise<void> {}

  private async _enqueueWorkflowNotification(
    submission: ThinkSubmissionInspection,
    output?: unknown
  ): Promise<void> {
    this._insertWorkflowNotification(submission, output);
    this._startWorkflowNotificationDrain();
  }

  private _insertWorkflowNotification(
    submission: ThinkSubmissionInspection,
    output?: unknown,
    override?: { status: ThinkSubmissionStatus; error: string }
  ): boolean {
    const workflowPrompt = this._readWorkflowPromptContext(
      submission.metadata ?? null
    );
    if (!workflowPrompt) return false;

    this._ensureWorkflowNotificationTable();
    const now = Date.now();
    const status = override?.status ?? submission.status;
    const error = override?.error ?? submission.error;
    const payload = {
      submissionId: submission.submissionId,
      status,
      ...(status === "completed" && { output }),
      ...(error && { error })
    };
    this.sql`
      INSERT OR IGNORE INTO cf_think_workflow_notifications (
        notification_id, submission_id, workflow_name, workflow_id, event_type,
        payload_json, attempts, last_error, created_at, updated_at, delivered_at
      )
      VALUES (
        ${`${submission.submissionId}:${workflowPrompt.workflow.eventType}`},
        ${submission.submissionId},
        ${workflowPrompt.workflow.name},
        ${workflowPrompt.workflow.id},
        ${workflowPrompt.workflow.eventType},
        ${JSON.stringify(payload)},
        0,
        NULL,
        ${now},
        ${now},
        NULL
      )
    `;
    return true;
  }

  private _recoverWorkflowNotifications(): void {
    this._ensureSubmissionTable();
    this._ensureWorkflowNotificationTable();
    const terminalRows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      WHERE status IN ('aborted', 'skipped', 'error')
      ORDER BY completed_at DESC, created_at DESC
      LIMIT 100
    `;

    let recovered = false;
    for (const row of terminalRows) {
      const inspection = this._inspectionFromSubmissionRow(row);
      const workflowPrompt = this._readWorkflowPromptContext(
        inspection.metadata ?? null
      );
      if (!workflowPrompt) continue;
      const notificationId = `${inspection.submissionId}:${workflowPrompt.workflow.eventType}`;
      const existing = this.sql<{ notification_id: string }>`
        SELECT notification_id
        FROM cf_think_workflow_notifications
        WHERE notification_id = ${notificationId}
        LIMIT 1
      `;
      if (existing[0]) continue;

      recovered = this._insertWorkflowNotification(inspection) || recovered;
    }
    if (recovered) this._startWorkflowNotificationDrain();
  }

  private _startWorkflowNotificationDrain(): void {
    void this.keepAliveWhile(() => this._drainWorkflowNotifications()).catch(
      (error) => {
        console.error("[Think] Failed to drain workflow notifications", error);
        void this._scheduleWorkflowNotificationAlarm();
      }
    );
  }

  private async _drainWorkflowNotifications(): Promise<void> {
    if (this._drainingWorkflowNotifications) return;
    this._ensureWorkflowNotificationTable();
    this._drainingWorkflowNotifications = true;
    try {
      const rows = this.sql<ThinkWorkflowNotificationRow>`
        SELECT notification_id, submission_id, workflow_name, workflow_id,
               event_type, payload_json, attempts, last_error, created_at,
               updated_at, delivered_at
        FROM cf_think_workflow_notifications
        WHERE delivered_at IS NULL
        ORDER BY created_at ASC, notification_id ASC
        LIMIT 25
      `;
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload_json) as unknown;
          await this.sendWorkflowEvent(
            row.workflow_name as string & {},
            row.workflow_id,
            {
              type: row.event_type,
              payload
            }
          );
          this.sql`
            UPDATE cf_think_workflow_notifications
            SET payload_json = '{}',
                last_error = NULL,
                updated_at = ${Date.now()},
                delivered_at = ${Date.now()}
            WHERE notification_id = ${row.notification_id}
              AND delivered_at IS NULL
          `;
        } catch (error) {
          this.sql`
            UPDATE cf_think_workflow_notifications
            SET attempts = attempts + 1,
                last_error = ${error instanceof Error ? error.message : String(error)},
                updated_at = ${Date.now()}
            WHERE notification_id = ${row.notification_id}
          `;
        }
      }
    } finally {
      this._drainingWorkflowNotifications = false;
    }
    await this._scheduleWorkflowNotificationAlarm();
  }

  private async _scheduleWorkflowNotificationAlarm(): Promise<void> {
    this._ensureWorkflowNotificationTable();
    const pending = this.sql<{ attempts: number }>`
      SELECT attempts
      FROM cf_think_workflow_notifications
      WHERE delivered_at IS NULL
      ORDER BY created_at ASC, notification_id ASC
      LIMIT 1
    `;
    if (!pending[0]) return;
    const delayMs = Math.min(
      5 * 60 * 1000,
      1000 * 2 ** Math.min(pending[0].attempts, 8)
    );
    const nextAlarm = Date.now() + delayMs;
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null || existingAlarm > nextAlarm) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  async inspectSubmission(
    submissionId: string
  ): Promise<ThinkSubmissionInspection | null> {
    const row = this._readSubmission(submissionId);
    return row ? this._inspectionFromSubmissionRow(row) : null;
  }

  async listSubmissions(
    options?: ListSubmissionsOptions
  ): Promise<ThinkSubmissionInspection[]> {
    return this._listSubmissionRows(options).map((row) =>
      this._inspectionFromSubmissionRow(row)
    );
  }

  async deleteSubmission(submissionId: string): Promise<boolean> {
    const row = this._readSubmission(submissionId);
    if (!row || !this._isTerminalSubmissionStatus(row.status)) return false;
    this.sql`
      DELETE FROM cf_think_submissions
      WHERE submission_id = ${submissionId}
        AND status IN ('completed', 'aborted', 'skipped', 'error')
    `;
    return true;
  }

  async deleteSubmissions(options?: DeleteSubmissionsOptions): Promise<number> {
    this._ensureSubmissionTable();
    const statuses =
      this._normalizeStatusFilter(options?.status) ??
      new Set<ThinkSubmissionStatus>([
        "completed",
        "aborted",
        "skipped",
        "error"
      ]);
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const completedBefore = options?.completedBefore?.getTime();
    const rows = [...statuses]
      .flatMap((status) =>
        this._listTerminalSubmissionRowsForDelete(
          status,
          limit,
          completedBefore
        )
      )
      .sort((a, b) =>
        (a.completed_at ?? a.created_at) === (b.completed_at ?? b.created_at)
          ? a.created_at - b.created_at
          : (a.completed_at ?? a.created_at) - (b.completed_at ?? b.created_at)
      )
      .slice(0, limit);

    let deleted = 0;
    for (const row of rows) {
      if (!this._isTerminalSubmissionStatus(row.status)) continue;
      this.sql`
        DELETE FROM cf_think_submissions
        WHERE submission_id = ${row.submission_id}
          AND status IN ('completed', 'aborted', 'skipped', 'error')
      `;
      deleted++;
    }
    return deleted;
  }

  private _listTerminalSubmissionRowsForDelete(
    status: ThinkSubmissionStatus,
    limit: number,
    completedBefore: number | undefined
  ): ThinkSubmissionRow[] {
    if (completedBefore === undefined) {
      return this.sql<ThinkSubmissionRow>`
        SELECT submission_id, idempotency_key, request_id, stream_id, status,
               messages_json, metadata_json, error_message, created_at,
               messages_applied_at, started_at, completed_at
        FROM cf_think_submissions
        WHERE status = ${status}
        ORDER BY completed_at ASC, created_at ASC
        LIMIT ${limit}
      `;
    }

    return this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      WHERE status = ${status}
        AND completed_at IS NOT NULL
        AND completed_at < ${completedBefore}
      ORDER BY completed_at ASC, created_at ASC
      LIMIT ${limit}
    `;
  }

  private _isTerminalSubmissionStatus(status: ThinkSubmissionStatus): boolean {
    return (
      status === "completed" ||
      status === "aborted" ||
      status === "skipped" ||
      status === "error"
    );
  }

  async cancelSubmission(
    submissionId: string,
    reason?: unknown
  ): Promise<void> {
    const row = this._readSubmission(submissionId);
    if (!row || this._isTerminalSubmissionStatus(row.status)) return;

    const completedAt = Date.now();
    const errorMessage =
      reason === undefined
        ? null
        : reason instanceof Error
          ? reason.message
          : String(reason);
    this._submissionAbortControllers.get(submissionId)?.abort(reason);
    if (row.request_id) {
      this.abortRequest(row.request_id, reason);
    }

    this.sql`
      UPDATE cf_think_submissions
      SET status = 'aborted',
          error_message = ${errorMessage},
          completed_at = ${completedAt}
      WHERE submission_id = ${submissionId}
        AND status IN ('pending', 'running')
    `;

    const updated = this._readSubmission(submissionId);
    if (updated?.status === "aborted") {
      await this._emitSubmissionStatus(updated);
    }
  }

  async submitMessages(
    messages: UIMessage[],
    options?: SubmitMessagesOptions
  ): Promise<SubmitMessagesResult> {
    this._ensureSubmissionTable();
    if (messages.length === 0) {
      throw new Error("submitMessages requires at least one message");
    }

    const existingById = options?.submissionId
      ? this._readSubmission(options.submissionId)
      : null;
    const existingByKey = options?.idempotencyKey
      ? this._readSubmissionByIdempotencyKey(options.idempotencyKey)
      : null;

    if (
      existingById &&
      existingByKey &&
      existingById.submission_id !== existingByKey.submission_id
    ) {
      throw new Error(
        "submissionId and idempotencyKey refer to different submissions"
      );
    }
    if (
      existingByKey &&
      options?.submissionId &&
      existingByKey.submission_id !== options.submissionId
    ) {
      throw new Error(
        "submissionId and idempotencyKey refer to different submissions"
      );
    }
    if (
      existingById &&
      options?.idempotencyKey &&
      existingById.idempotency_key !== null &&
      existingById.idempotency_key !== options.idempotencyKey
    ) {
      throw new Error(
        "submissionId and idempotencyKey refer to different submissions"
      );
    }

    const existing = existingById ?? existingByKey;
    if (existing) {
      if (existing.status === "pending") {
        await this._scheduleSubmissionDrain();
        this._startSubmissionDrain();
      }
      return {
        ...this._inspectionFromSubmissionRow(existing),
        accepted: false
      };
    }

    const submissionId = options?.submissionId ?? crypto.randomUUID();
    const requestId = submissionId;
    const now = Date.now();
    const messagesJson = this._serializeSubmissionMessages(messages);
    const metadataJson = this._serializeMetadata(options?.metadata);

    this.sql`
      INSERT INTO cf_think_submissions (
        submission_id, idempotency_key, request_id, stream_id, status,
        messages_json, metadata_json, error_message, created_at,
        messages_applied_at, started_at, completed_at
      )
      VALUES (
        ${submissionId}, ${options?.idempotencyKey ?? null}, ${requestId},
        NULL, 'pending', ${messagesJson}, ${metadataJson}, NULL, ${now},
        NULL, NULL, NULL
      )
    `;

    const row = this._readSubmission(submissionId);
    if (!row) {
      throw new Error("Failed to persist submission");
    }

    this._emit("submission:create", {
      submissionId: row.submission_id,
      requestId: row.request_id ?? undefined,
      idempotencyKey: row.idempotency_key ?? undefined
    });
    await this._emitSubmissionStatus(row);
    await this._scheduleSubmissionDrain();
    this._startSubmissionDrain();

    return {
      ...this._inspectionFromSubmissionRow(row),
      accepted: true
    };
  }

  private async _scheduleSubmissionDrain(): Promise<void> {
    await this.schedule(0, "_drainThinkSubmissions", undefined, {
      idempotent: true
    });
  }

  private _startSubmissionDrain(): void {
    void this.keepAliveWhile(() => this._drainSubmissions()).catch((error) => {
      console.error("[Think] Failed to drain submissions", error);
    });
  }

  async _drainThinkSubmissions(): Promise<void> {
    await this._drainSubmissions();
  }

  private async _drainSubmissions(): Promise<void> {
    this._ensureSubmissionTable();
    if (this._drainingSubmissions) return;
    this._drainingSubmissions = true;
    try {
      while (true) {
        const rows = this.sql<ThinkSubmissionRow>`
          SELECT submission_id, idempotency_key, request_id, stream_id, status,
                 messages_json, metadata_json, error_message, created_at,
                 messages_applied_at, started_at, completed_at
          FROM cf_think_submissions
          WHERE status = 'pending'
          ORDER BY created_at ASC, submission_id ASC
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) break;
        await this._runSubmission(row);
      }
    } finally {
      this._drainingSubmissions = false;
    }
  }

  private async _runSubmission(row: ThinkSubmissionRow): Promise<void> {
    const requestId = row.request_id ?? row.submission_id;
    const startedAt = Date.now();
    this.sql`
      UPDATE cf_think_submissions
      SET status = 'running',
          request_id = ${requestId},
          started_at = ${startedAt}
      WHERE submission_id = ${row.submission_id}
        AND status = 'pending'
    `;

    const claimed = this._readSubmission(row.submission_id);
    if (!claimed || claimed.status !== "running") return;
    await this._emitSubmissionStatus(claimed);

    const controller = new AbortController();
    this._submissionAbortControllers.set(row.submission_id, controller);
    let output: unknown;
    try {
      const messages = this._parseSubmissionMessages(row.messages_json);
      const metadata = this._parseJsonObject(row.metadata_json);
      const workflowPrompt = this._readWorkflowPromptContext(metadata);
      const result = await this._runProgrammaticMessagesTurn(
        requestId,
        messages,
        {
          signal: controller.signal,
          captureProgrammaticStreamError: true,
          captureOutput: Boolean(workflowPrompt?.output),
          workflowPrompt: workflowPrompt ?? undefined,
          onMessagesApplied: () => {
            this.sql`
              UPDATE cf_think_submissions
              SET messages_applied_at = ${Date.now()}
              WHERE submission_id = ${row.submission_id}
                AND status = 'running'
                AND messages_applied_at IS NULL
            `;
          }
        }
      );
      output = result.output;
      const streamId =
        this._resumableStream
          .getAllStreamMetadata()
          .find((metadata) => metadata.request_id === result.requestId)?.id ??
        null;
      const streamError = this._programmaticStreamErrors.get(result.requestId);
      const finalStatus = this._getSubmissionFinalStatus(
        result.status,
        result.error ?? streamError
      );
      const errorMessage = result.error ?? streamError ?? null;
      const completedAt = Date.now();
      this.ctx.storage.transactionSync(() => {
        this.sql`
          UPDATE cf_think_submissions
          SET status = ${finalStatus},
              request_id = ${result.requestId},
              stream_id = ${streamId},
              error_message = ${finalStatus === "error" ? errorMessage : null},
              completed_at = ${completedAt}
          WHERE submission_id = ${row.submission_id}
            AND status = 'running'
        `;
        this._insertWorkflowNotification(
          {
            ...this._inspectionFromSubmissionRow(claimed),
            requestId: result.requestId,
            status: finalStatus,
            error:
              finalStatus === "error" ? (errorMessage ?? undefined) : undefined,
            completedAt
          },
          output
        );
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const completedAt = Date.now();
      this.ctx.storage.transactionSync(() => {
        this.sql`
          UPDATE cf_think_submissions
          SET status = 'error',
              error_message = ${errorMessage},
              completed_at = ${completedAt}
          WHERE submission_id = ${row.submission_id}
            AND status = 'running'
        `;
        this._insertWorkflowNotification({
          ...this._inspectionFromSubmissionRow(claimed),
          status: "error",
          error: errorMessage,
          completedAt
        });
      });
    } finally {
      this._programmaticStreamErrors.delete(requestId);
      this._submissionAbortControllers.delete(row.submission_id);
      const updated = this._readSubmission(row.submission_id);
      if (updated && this._isTerminalSubmissionStatus(updated.status)) {
        await this._emitSubmissionStatus(updated, output);
      }
    }
  }

  private _getSubmissionFinalStatus(
    resultStatus: SaveMessagesResult["status"],
    streamError: string | undefined
  ): ThinkSubmissionStatus {
    return resultStatus === "completed" && streamError ? "error" : resultStatus;
  }

  private _markPendingSubmissionsSkipped(): ThinkSubmissionRow[] {
    this._ensureSubmissionTable();
    const pending = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      WHERE status = 'pending'
    `;
    this.sql`
      UPDATE cf_think_submissions
      SET status = 'skipped',
          error_message = 'Submission was skipped by turn reset.',
          completed_at = ${Date.now()}
      WHERE status = 'pending'
    `;
    return pending;
  }

  private async _emitSkippedSubmissions(
    skipped: ThinkSubmissionRow[]
  ): Promise<void> {
    for (const row of skipped) {
      const updated = this._readSubmission(row.submission_id);
      if (updated?.status === "skipped") {
        await this._emitSubmissionStatus(updated);
      }
    }
  }

  private async _recoverSubmissionsOnStart(): Promise<void> {
    this._ensureSubmissionTable();

    const running = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      WHERE status = 'running'
    `;

    for (const row of running) {
      if (row.messages_applied_at === null) {
        let appliedState: "none" | "partial" | "all";
        try {
          appliedState = await this._getSubmissionMessagesAppliedState(row);
        } catch (error) {
          this.sql`
            UPDATE cf_think_submissions
            SET status = 'error',
                error_message = ${error instanceof Error ? error.message : String(error)},
                completed_at = ${Date.now()}
            WHERE submission_id = ${row.submission_id}
              AND status = 'running'
          `;
          const updated = this._readSubmission(row.submission_id);
          if (updated?.status === "error") {
            await this._emitSubmissionStatus(updated);
          }
          continue;
        }
        if (appliedState !== "none") {
          this.sql`
            UPDATE cf_think_submissions
            SET status = 'error',
                error_message = ${appliedState === "all" ? "Submission was interrupted after messages were applied." : "Submission was interrupted after messages were partially applied."},
                completed_at = ${Date.now()}
            WHERE submission_id = ${row.submission_id}
              AND status = 'running'
          `;
          const updated = this._readSubmission(row.submission_id);
          if (updated?.status === "error") {
            await this._emitSubmissionStatus(updated);
          }
          continue;
        }
        this.sql`
          UPDATE cf_think_submissions
          SET status = 'pending',
              started_at = NULL
          WHERE submission_id = ${row.submission_id}
            AND status = 'running'
        `;
        const updated = this._readSubmission(row.submission_id);
        if (updated?.status === "pending") {
          await this._emitSubmissionStatus(updated);
        }
        continue;
      }

      if (
        row.request_id &&
        ((this._hasRecoverableChatTurn(row.request_id) &&
          this._hasFreshRecoverableSubmissionEvidence(row)) ||
          this._hasScheduledRecoveredContinuation(row.request_id))
      ) {
        continue;
      }

      this.sql`
        UPDATE cf_think_submissions
        SET status = 'error',
            error_message = 'Submission was interrupted after messages were applied.',
            completed_at = ${Date.now()}
        WHERE submission_id = ${row.submission_id}
          AND status = 'running'
      `;
      const updated = this._readSubmission(row.submission_id);
      if (updated?.status === "error") {
        await this._emitSubmissionStatus(updated);
      }
    }
  }

  private async _getSubmissionMessagesAppliedState(
    row: ThinkSubmissionRow
  ): Promise<"none" | "partial" | "all"> {
    const messages = this._parseSubmissionMessages(row.messages_json);
    if (messages.length === 0) return "all";

    let applied = 0;
    for (const message of messages) {
      if (await this.session.getMessage(message.id)) applied++;
    }

    if (applied === 0) return "none";
    return applied === messages.length ? "all" : "partial";
  }

  private _hasRecoverableChatTurn(requestId: string): boolean {
    const fiberRows = this.sql<{ id: string }>`
      SELECT id FROM cf_agents_runs
      WHERE name = ${(this.constructor as typeof Think).CHAT_FIBER_NAME + ":" + requestId}
      LIMIT 1
    `;
    if (fiberRows.length > 0) return true;

    const streamRows = this.sql<{ id: string }>`
      SELECT id FROM cf_ai_chat_stream_metadata
      WHERE request_id = ${requestId}
        AND status = 'streaming'
      LIMIT 1
    `;
    return streamRows.length > 0;
  }

  private _hasFreshRecoverableSubmissionEvidence(row: ThinkSubmissionRow) {
    if (!row.request_id) return false;
    const cutoff =
      Date.now() - (this.constructor as typeof Think).submissionRecoveryStaleMs;

    const fiberRows = this.sql<{ created_at: number }>`
      SELECT created_at FROM cf_agents_runs
      WHERE name = ${(this.constructor as typeof Think).CHAT_FIBER_NAME + ":" + row.request_id}
      LIMIT 1
    `;
    if (fiberRows[0] && fiberRows[0].created_at >= cutoff) return true;

    const streamRows = this.sql<{ created_at: number }>`
      SELECT created_at FROM cf_ai_chat_stream_metadata
      WHERE request_id = ${row.request_id}
        AND status = 'streaming'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return streamRows[0] ? streamRows[0].created_at >= cutoff : false;
  }

  private _hasScheduledRecoveredContinuation(requestId: string): boolean {
    const rows = this.sql<{ payload: string | null }>`
      SELECT payload FROM cf_agents_schedules
      WHERE callback = '_chatRecoveryContinue'
    `;
    return rows.some((row) => {
      if (!row.payload) return false;
      try {
        const payload = JSON.parse(row.payload) as unknown;
        return (
          payload !== null &&
          typeof payload === "object" &&
          "recoveredRequestId" in payload &&
          (payload as { recoveredRequestId?: unknown }).recoveredRequestId ===
            requestId
        );
      } catch {
        return false;
      }
    });
  }

  // ── Programmatic API ───────────────────────────────────────────

  /**
   * Inject messages and trigger a model turn — without a WebSocket request.
   *
   * Use for scheduled responses, webhook-triggered turns, proactive agents,
   * or chaining from `onChatResponse`.
   *
   * Accepts static messages or a callback that derives messages from the
   * current state (useful when multiple calls queue up — the callback runs
   * with the latest messages when the turn actually starts).
   *
   * Pass `options.signal` to cancel the turn from outside without knowing
   * the internally-generated request id. The signal is linked to the
   * registry's controller for this turn — when it aborts, the inference
   * loop's signal aborts and the result reports `status: "aborted"`.
   * Pre-aborted signals short-circuit before any model work runs. See
   * {@link SaveMessagesOptions} for the integration point.
   *
   * @example Scheduled follow-up
   * ```typescript
   * async onScheduled() {
   *   await this.saveMessages([{
   *     id: crypto.randomUUID(),
   *     role: "user",
   *     parts: [{ type: "text", text: "Time for your daily summary." }]
   *   }]);
   * }
   * ```
   *
   * @example Function form
   * ```typescript
   * await this.saveMessages((current) => [
   *   ...current,
   *   { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: "Continue." }] }
   * ]);
   * ```
   *
   * @example External cancellation (helper-as-sub-agent)
   * ```typescript
   * // Inside a parent agent's tool execute — forward the AI SDK's
   * // abortSignal so a parent stop / tab close cancels the helper.
   * await helper.saveMessages([userMsg], { signal: abortSignal });
   * ```
   */
  async saveMessages(
    messages:
      | UIMessage[]
      | ((currentMessages: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    const requestId = crypto.randomUUID();
    return this._runProgrammaticMessagesTurn(requestId, messages, options);
  }

  private async _runProgrammaticMessagesTurn(
    requestId: string,
    messages:
      | UIMessage[]
      | ((currentMessages: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: SaveMessagesOptions & {
      onMessagesApplied?: () => void;
      captureProgrammaticStreamError?: boolean;
      captureOutput?: boolean;
      body?: Record<string, unknown>;
      workflowPrompt?: ThinkWorkflowPromptContext;
    }
  ): Promise<ProgrammaticMessagesResult> {
    const clientTools = this._lastClientTools;
    const body = options?.body ?? this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;
    let output: unknown;
    let wasAborted = false;

    await this.keepAliveWhile(async () => {
      await this._turnQueue.enqueue(requestId, async () => {
        const resolved =
          typeof messages === "function"
            ? await messages(this.messages)
            : messages;

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        for (const msg of resolved) {
          await this._appendMessageToHistory(msg);
        }
        options?.onMessagesApplied?.();
        this._broadcastMessages();

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        const abortSignal = this._aborts.getSignal(requestId);
        // Wire the optional external signal to the registry's controller
        // for this request. Detacher MUST run in `finally` to avoid
        // leaking listeners on a long-lived parent signal that drives
        // many helper turns.
        const detachExternal = this._aborts.linkExternal(
          requestId,
          options?.signal
        );
        try {
          const programmaticBody = async () => {
            const result = await agentContext.run(
              {
                agent: this,
                connection: undefined,
                request: undefined,
                email: undefined
              },
              () =>
                this._runInferenceLoop({
                  signal: abortSignal,
                  clientTools,
                  body,
                  workflowPrompt: options?.workflowPrompt,
                  continuation: false
                })
            );

            if (result) {
              const streamResult = await this._streamResult(
                requestId,
                result,
                abortSignal,
                {
                  captureProgrammaticStreamError:
                    options?.captureProgrammaticStreamError,
                  captureOutput: options?.captureOutput
                }
              );
              status = streamResult.status;
              error = streamResult.error;
              output = streamResult.output;
            }
          };

          if (this.chatRecovery) {
            await this._runChatRecoveryFiber(
              requestId,
              false,
              programmaticBody
            );
          } else {
            await programmaticBody();
          }
        } finally {
          if (abortSignal?.aborted) wasAborted = true;
          detachExternal();
          this._aborts.remove(requestId);
        }
      });
    });

    if (
      this._turnQueue.generation !== epoch &&
      shouldMarkSkippedAfterGenerationChange(status)
    ) {
      status = "skipped";
    } else if (wasAborted && status === "completed") {
      status = "aborted";
    }

    return {
      requestId,
      status,
      ...(error !== undefined && { error }),
      ...(output !== undefined && { output })
    };
  }

  /**
   * Run a new LLM call following the last assistant message.
   *
   * The model sees the full conversation (including the last assistant
   * response) and generates a new response. The new response is persisted
   * as a separate assistant message. Building block for chat recovery
   * (Phase 4), "generate more" buttons, and self-correction.
   *
   * Note: this creates a new message, not an append to the existing one.
   * True continuation-as-append (chunk rewriting) is planned for Phase 4.
   *
   * Returns early with `status: "skipped"` if there is no assistant message
   * to continue from.
   *
   * Pass `options.signal` to cancel the continuation from outside —
   * matches the {@link saveMessages} contract.
   */
  protected async continueLastTurn(
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    const lastLeaf = await this.session.getLatestLeaf();
    if (!lastLeaf || lastLeaf.role !== "assistant") {
      return { requestId: "", status: "skipped" };
    }

    const requestId = crypto.randomUUID();
    const clientTools = this._lastClientTools;
    const resolvedBody = body ?? this._lastBody;
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;
    let wasAborted = false;

    await this.keepAliveWhile(async () => {
      await this._turnQueue.enqueue(requestId, async () => {
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        const abortSignal = this._aborts.getSignal(requestId);
        const detachExternal = this._aborts.linkExternal(
          requestId,
          options?.signal
        );
        try {
          const continueTurnBody = async () => {
            const result = await agentContext.run(
              {
                agent: this,
                connection: undefined,
                request: undefined,
                email: undefined
              },
              () =>
                this._runInferenceLoop({
                  signal: abortSignal,
                  clientTools,
                  body: resolvedBody,
                  continuation: true
                })
            );

            if (result) {
              const streamResult = await this._streamResult(
                requestId,
                result,
                abortSignal,
                {
                  continuation: true
                }
              );
              status = streamResult.status;
              error = streamResult.error;
            }
          };

          if (this.chatRecovery) {
            await this._runChatRecoveryFiber(requestId, true, continueTurnBody);
          } else {
            await continueTurnBody();
          }
        } finally {
          if (abortSignal?.aborted) wasAborted = true;
          detachExternal();
          this._aborts.remove(requestId);
        }
      });
    });

    if (
      this._turnQueue.generation !== epoch &&
      shouldMarkSkippedAfterGenerationChange(status)
    ) {
      status = "skipped";
    } else if (wasAborted && status === "completed") {
      status = "aborted";
    }

    return { requestId, status, ...(error !== undefined && { error }) };
  }

  private async _retryLastUserTurn(
    clientTools?: ClientToolSchema[],
    body?: Record<string, unknown>,
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    const lastLeaf = await this.session.getLatestLeaf();
    if (!lastLeaf || lastLeaf.role !== "user") {
      return { requestId: "", status: "skipped" };
    }

    const requestId = crypto.randomUUID();
    const epoch = this._turnQueue.generation;
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;
    let wasAborted = false;

    await this.keepAliveWhile(async () => {
      await this._turnQueue.enqueue(requestId, async () => {
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        const abortSignal = this._aborts.getSignal(requestId);
        const detachExternal = this._aborts.linkExternal(
          requestId,
          options?.signal
        );
        try {
          const retryTurnBody = async () => {
            const result = await agentContext.run(
              {
                agent: this,
                connection: undefined,
                request: undefined,
                email: undefined
              },
              () =>
                this._runInferenceLoop({
                  signal: abortSignal,
                  clientTools,
                  body,
                  continuation: false
                })
            );

            if (result) {
              const streamResult = await this._streamResult(
                requestId,
                result,
                abortSignal
              );
              status = streamResult.status;
              error = streamResult.error;
            }
          };

          if (this.chatRecovery) {
            await this._runChatRecoveryFiber(requestId, false, retryTurnBody);
          } else {
            await retryTurnBody();
          }
        } finally {
          if (abortSignal?.aborted) wasAborted = true;
          detachExternal();
          this._aborts.remove(requestId);
        }
      });
    });

    if (
      this._turnQueue.generation !== epoch &&
      shouldMarkSkippedAfterGenerationChange(status)
    ) {
      status = "skipped";
    } else if (wasAborted && status === "completed") {
      status = "aborted";
    }

    return { requestId, status, ...(error !== undefined && { error }) };
  }

  // ── WebSocket protocol ──────────────────────────────────────────

  private _setupProtocolHandlers() {
    const _onConnect = this.onConnect.bind(this);
    this.onConnect = async (
      connection: Connection,
      ctx: { request: Request }
    ) => {
      const requestTargetsSubAgent = this._cf_requestTargetsSubAgent(
        ctx.request
      );
      if (requestTargetsSubAgent) {
        return _onConnect(connection, ctx);
      }

      if (this._resumableStream.hasActiveStream()) {
        // A stream is still in flight. The resume flow is the
        // authoritative source of state: `_notifyStreamResuming` tells
        // the client to send `STREAM_RESUME_ACK`, after which the
        // server replays buffered chunks and delivers a final
        // `MSG_CHAT_MESSAGES` broadcast once the turn completes.
        //
        // Sending `MSG_CHAT_MESSAGES` here would clobber the in-progress
        // assistant the client rebuilds from the replayed chunks,
        // because `this.messages` at this point still only contains
        // the user message — the assistant message is not persisted
        // until the stream finishes.
        this._notifyStreamResuming(connection);
      } else {
        connection.send(
          JSON.stringify({
            type: MSG_CHAT_MESSAGES,
            messages: this.messages
          })
        );
      }
      return _onConnect(connection, ctx);
    };

    const _onClose = this.onClose.bind(this);
    this.onClose = async (
      connection: Connection,
      code: number,
      reason: string,
      wasClean: boolean
    ) => {
      this._pendingResumeConnections.delete(connection.id);
      this._continuation.awaitingConnections.delete(connection.id);
      if (this._continuation.pending?.connectionId === connection.id) {
        this._continuation.pending = null;
      }
      if (this._continuation.activeConnectionId === connection.id) {
        this._continuation.activeConnectionId = null;
      }
      return _onClose(connection, code, reason, wasClean);
    };

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      const connectionTargetsSubAgent =
        this._cf_connectionTargetsSubAgent(connection);
      if (connectionTargetsSubAgent) {
        return _onMessage(connection, message);
      }

      if (typeof message === "string") {
        const event = parseProtocolMessage(message);
        if (event) {
          await this._handleProtocolEvent(connection, event);
          return;
        }
      }
      return _onMessage(connection, message);
    };

    const _onRequest = this.onRequest.bind(this);
    this.onRequest = async (request: Request) => {
      const url = new URL(request.url);
      if (
        url.pathname === "/get-messages" ||
        url.pathname.endsWith("/get-messages")
      ) {
        return Response.json(this.messages);
      }
      const messengerResponse =
        await this._messengerRuntime?.handleRequest(request);
      if (messengerResponse) {
        return messengerResponse;
      }
      return _onRequest(request);
    };
  }

  private async _handleProtocolEvent(
    connection: Connection,
    event: NonNullable<ReturnType<typeof parseProtocolMessage>>
  ): Promise<void> {
    switch (event.type) {
      case "stream-resume-request":
        this._handleStreamResumeRequest(connection);
        break;

      case "stream-resume-ack":
        await this._handleStreamResumeAck(connection, event.id);
        break;

      case "chat-request":
        if (event.init?.method === "POST") {
          await this._handleChatRequest(connection, event);
        }
        break;

      case "tool-result": {
        if (
          event.clientTools &&
          Array.isArray(event.clientTools) &&
          event.clientTools.length > 0
        ) {
          this._lastClientTools = event.clientTools as ClientToolSchema[];
          this._persistClientTools();
        }
        const resultPromise = Promise.resolve().then(async () => {
          await this._applyToolResult(
            event.toolCallId,
            event.output,
            event.state as "output-error" | undefined,
            event.errorText
          );
          return true;
        });
        this._pendingInteractionPromise = resultPromise;
        resultPromise
          .finally(() => {
            if (this._pendingInteractionPromise === resultPromise) {
              this._pendingInteractionPromise = null;
            }
          })
          .catch(() => {});
        if (event.autoContinue) {
          this._scheduleAutoContinuation(connection);
        }
        break;
      }

      case "tool-approval": {
        const approvalPromise = Promise.resolve().then(async () => {
          await this._applyToolApproval(event.toolCallId, event.approved);
          return true;
        });
        this._pendingInteractionPromise = approvalPromise;
        approvalPromise
          .finally(() => {
            if (this._pendingInteractionPromise === approvalPromise) {
              this._pendingInteractionPromise = null;
            }
          })
          .catch(() => {});
        if (event.autoContinue) {
          this._scheduleAutoContinuation(connection);
        }
        break;
      }

      case "clear":
        await this._handleClear(connection);
        break;

      case "cancel":
        this._aborts.cancel(event.id);
        break;

      case "messages":
        break;
    }
  }

  private _handleStreamResumeRequest(connection: Connection): void {
    if (this._resumableStream.hasActiveStream()) {
      if (
        this._continuation.activeRequestId ===
          this._resumableStream.activeRequestId &&
        this._continuation.activeConnectionId !== null &&
        this._continuation.activeConnectionId !== connection.id
      ) {
        sendIfOpen(
          connection,
          JSON.stringify({ type: MSG_STREAM_RESUME_NONE })
        );
      } else {
        this._notifyStreamResuming(connection);
      }
    } else if (
      this._continuation.pending !== null &&
      this._continuation.pending.connectionId === connection.id
    ) {
      this._continuation.awaitingConnections.set(connection.id, connection);
    } else {
      sendIfOpen(connection, JSON.stringify({ type: MSG_STREAM_RESUME_NONE }));
    }
  }

  private async _handleStreamResumeAck(
    connection: Connection,
    requestId: string
  ): Promise<void> {
    this._pendingResumeConnections.delete(connection.id);
    if (
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeRequestId === requestId
    ) {
      const orphanedStreamId = this._resumableStream.replayChunks(
        connection,
        this._resumableStream.activeRequestId
      );
      if (orphanedStreamId) {
        await this._persistOrphanedStream(orphanedStreamId);
      }
    } else if (this._resumableStream.hasActiveStream()) {
      // Ignore ACKs for a different active stream request id.
    } else if (
      !this._resumableStream.replayCompletedChunksByRequestId(
        connection,
        requestId
      )
    ) {
      sendIfOpen(
        connection,
        JSON.stringify({
          body: "",
          done: true,
          id: requestId,
          type: MSG_CHAT_RESPONSE,
          replay: true
        })
      );
    }
  }

  private async _handleChatRequest(
    connection: Connection,
    event: Extract<
      NonNullable<ReturnType<typeof parseProtocolMessage>>,
      { type: "chat-request" }
    >
  ) {
    if (!event.init?.body) return;

    let rawParsed: Record<string, unknown>;
    try {
      rawParsed = JSON.parse(event.init.body) as Record<string, unknown>;
    } catch {
      return;
    }

    const {
      messages: incomingMessages,
      clientTools: rawClientTools,
      trigger: rawTrigger,
      ...customBody
    } = rawParsed as {
      messages?: UIMessage[];
      clientTools?: ClientToolSchema[];
      trigger?: string;
      [key: string]: unknown;
    };
    if (!Array.isArray(incomingMessages)) return;

    const isRegeneration = rawTrigger === "regenerate-message";
    const isSubmitMessage = !isRegeneration;
    const requestId = event.id;

    // ── Concurrency decision (before persisting anything) ────────
    const concurrencyDecision =
      this._getSubmitConcurrencyDecision(isSubmitMessage);

    if (concurrencyDecision.action === "drop") {
      this._rollbackDroppedSubmit(connection);
      this._completeSkippedRequest(connection, requestId);
      return;
    }

    const releasePendingEnqueue = this._submitConcurrency.beginEnqueue();
    let pendingEnqueue = true;
    const epoch = this._turnQueue.generation;
    const releaseIfPending = () => {
      if (!pendingEnqueue) return;
      pendingEnqueue = false;
      releasePendingEnqueue();
    };

    try {
      // ── Persist client tools and body (only for accepted requests) ──
      const requestClientTools =
        rawClientTools && rawClientTools.length > 0
          ? rawClientTools
          : undefined;
      if (requestClientTools) {
        this._lastClientTools = requestClientTools;
        this._persistClientTools();
      } else if (rawClientTools !== undefined) {
        this._lastClientTools = undefined;
        this._persistClientTools();
      }

      const requestBody =
        Object.keys(customBody).length > 0 ? customBody : undefined;
      this._lastBody = requestBody;
      this._persistBody();

      // ── Reconcile, persist, and broadcast user messages ──────────
      //
      // The client may post an in-flight assistant snapshot it minted
      // optimistically (e.g. while a previous tool call is still
      // streaming). Reconcile against the server's current active path
      // so client IDs map onto server IDs and stale client states pick
      // up the server's tool outputs. Without this, Session's
      // INSERT-OR-IGNORE-by-ID would persist a duplicate orphan
      // assistant row alongside the real server-generated one.
      const clientToolsForTurn = this._lastClientTools;
      const bodyForTurn = this._lastBody;

      const serverMessages = await this._readMessagesFromStorage();
      const reconciled = reconcileMessages(
        incomingMessages,
        serverMessages,
        sanitizeMessage
      );

      let branchParentId: string | undefined;
      if (isRegeneration && reconciled.length > 0) {
        branchParentId = reconciled[reconciled.length - 1].id;
      }

      if (this._turnQueue.generation !== epoch) {
        this._completeSkippedRequest(connection, requestId);
        return;
      }

      for (const msg of reconciled) {
        if (this._turnQueue.generation !== epoch) {
          this._completeSkippedRequest(connection, requestId);
          return;
        }

        await this._persistIncomingMessage(msg, serverMessages);
      }

      if (this._turnQueue.generation !== epoch) {
        this._completeSkippedRequest(connection, requestId);
        return;
      }

      await this._syncMessages();
      this._broadcastMessages([connection.id]);

      // ── Enter turn queue ────────────────────────────────────────
      const abortSignal = this._aborts.getSignal(requestId);

      await this.keepAliveWhile(async () => {
        const turnPromise = this._turnQueue.enqueue(
          requestId,
          async () => {
            // Superseded by a later overlapping submit (latest/merge/debounce)
            if (
              this._submitConcurrency.isSuperseded(
                concurrencyDecision.submitSequence
              )
            ) {
              this._completeSkippedRequest(connection, requestId);
              return;
            }

            // Debounce: wait for quiet period
            if (concurrencyDecision.debounceUntilMs !== null) {
              await this._submitConcurrency.waitForTimestamp(
                concurrencyDecision.debounceUntilMs
              );

              if (this._turnQueue.generation !== epoch) {
                this._completeSkippedRequest(connection, requestId);
                return;
              }
              if (
                this._submitConcurrency.isSuperseded(
                  concurrencyDecision.submitSequence
                )
              ) {
                this._completeSkippedRequest(connection, requestId);
                return;
              }
            }

            const chatTurnBody = async () => {
              const result = await agentContext.run(
                {
                  agent: this,
                  connection,
                  request: undefined,
                  email: undefined
                },
                () =>
                  this._runInferenceLoop({
                    signal: abortSignal,
                    clientTools: clientToolsForTurn,
                    body: bodyForTurn,
                    continuation: false
                  })
              );

              if (result) {
                await this._streamResult(requestId, result, abortSignal, {
                  parentId: branchParentId
                });
              } else {
                this._broadcastChat({
                  type: MSG_CHAT_RESPONSE,
                  id: requestId,
                  body: "No response was generated.",
                  done: true
                });
              }
            };

            if (this.chatRecovery) {
              await this._runChatRecoveryFiber(requestId, false, chatTurnBody);
            } else {
              await chatTurnBody();
            }
          },
          {
            generation: epoch
          }
        );
        releaseIfPending();

        const turnResult = await turnPromise;

        if (turnResult.status === "stale") {
          this._broadcastChat({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: "",
            done: true
          });
        }
      });
    } catch (error) {
      this._broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: error instanceof Error ? error.message : "Error",
        done: true,
        error: true
      });
    } finally {
      releaseIfPending();
      this._aborts.remove(requestId);
    }
  }

  /**
   * Abort the active turn, invalidate queued turns, and reset
   * concurrency/continuation state. Call this when intercepting
   * clear events or implementing custom reset logic.
   *
   * Does NOT clear messages, streams, or persisted state —
   * only turn execution state.
   */
  protected resetTurnState(): void {
    this._turnQueue.reset();
    this._aborts.destroyAll();
    for (const controller of this._submissionAbortControllers.values()) {
      controller.abort(new Error("Turn state reset"));
    }
    this._submissionAbortControllers.clear();
    const skippedSubmissions = this._markPendingSubmissionsSkipped();
    void this.keepAliveWhile(() =>
      this._emitSkippedSubmissions(skippedSubmissions)
    ).catch((error) => {
      console.error("[Think] Failed to skip pending submissions", error);
    });
    if (this._continuationTimer) {
      clearTimeout(this._continuationTimer);
      this._continuationTimer = null;
    }
    this._submitConcurrency.reset();
    this._pendingInteractionPromise = null;
    this._continuation.sendResumeNone();
    this._continuation.clearAll();
  }

  /**
   * Abort a single in-flight chat turn by request id.
   *
   * Equivalent to the cancel path that fires when a client sends a
   * `chat-request-cancel` WebSocket message — the inference loop's
   * signal aborts, partial chunks already streamed are still
   * persisted, and the turn's `ChatResponseResult` reports
   * `status: "aborted"`.
   *
   * No-op if no controller exists for `requestId` (the turn already
   * completed, was never started, or used a different id).
   *
   * `chat()` callers can read the request id from
   * {@link StreamCallback.onStart} and later pass it here from another
   * RPC call.
   *
   * Prefer {@link SaveMessagesOptions.signal} when driving a turn
   * programmatically — it threads the abort intent in from the start
   * without requiring the caller to know the id.
   */
  cancelChat(requestId: string, reason?: string): void {
    this._aborts.cancel(requestId, reason);
  }

  /** Abort every in-flight chat turn on this agent. */
  cancelAllChats(): void {
    this._aborts.destroyAll();
  }

  protected abortRequest(requestId: string, reason?: unknown): void {
    this._aborts.cancel(requestId, reason);
  }

  /**
   * Abort every in-flight chat turn on this agent.
   *
   * Aborts all controllers in the registry and clears it. Used by
   * subclasses that drive single-purpose turns (e.g. a sub-agent
   * helper that runs one turn at a time over RPC) and want a coarse
   * "cancel whatever is running" handle without tracking request ids.
   *
   * Does NOT reset queued turns, continuation timers, or submit
   * concurrency state — use {@link resetTurnState} for the full
   * teardown that runs on `chat-clear`.
   */
  protected abortAllRequests(): void {
    this._aborts.destroyAll();
  }

  private async _handleClear(connection?: Connection) {
    this.resetTurnState();

    this._resumableStream.clearAll();
    this._pendingResumeConnections.clear();
    this._lastClientTools = undefined;
    this._persistClientTools();
    this._lastBody = undefined;
    this._persistBody();
    await this._clearHistory();
    this._broadcast(
      { type: MSG_CHAT_CLEAR },
      connection ? [connection.id] : undefined
    );
  }

  private async _streamResultToRpcCallback(
    requestId: string,
    result: StreamableResult,
    callback: StreamCallback,
    abortSignal?: AbortSignal
  ): Promise<void> {
    const streamId = this._resumableStream.start(requestId);
    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID()
    });

    let streamFinalized = false;
    let assistantMsg: UIMessage | null = null;
    let aborted = false;
    let doneSent = false;
    let streamError: string | undefined;
    let pendingRpcError: string | undefined;

    try {
      this._insideInferenceLoop = true;
      let chunksSinceFlush = 0;
      let hasFlushedContent = false;
      try {
        for await (const chunk of result.toUIMessageStream()) {
          if (abortSignal?.aborted) {
            aborted = true;
            break;
          }

          // RPC callbacks receive serialized UIMessage chunks directly; unlike
          // the WebSocket protocol, there is no wrapper frame to rewrite for
          // accumulator actions such as `error`.
          const streamChunk = chunk as unknown as StreamChunkData;
          const { action } = accumulator.applyChunk(streamChunk);

          if (action?.type === "error") {
            streamError = action.error;
            this._emit("message:error", { error: streamError });
            this._broadcastChat({
              type: MSG_CHAT_RESPONSE,
              id: requestId,
              body: action.error,
              done: false,
              error: true
            });
            break;
          }

          const chunkBody = JSON.stringify(chunk);
          this._resumableStream.storeChunk(streamId, chunkBody);
          chunksSinceFlush++;
          if (
            this._shouldFlushRpcStreamChunk(
              streamChunk,
              chunksSinceFlush,
              hasFlushedContent
            )
          ) {
            this._resumableStream.flushBuffer();
            chunksSinceFlush = 0;
            hasFlushedContent = true;
          }
          this._broadcastChat({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: chunkBody,
            done: false
          });
          await callback.onEvent(chunkBody);
        }
      } finally {
        this._insideInferenceLoop = false;
      }

      if (streamError) {
        this._resumableStream.markError(streamId);
      } else {
        this._resumableStream.complete(streamId);
      }
      streamFinalized = true;
      this._broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true
      });
      doneSent = true;

      assistantMsg = accumulator.toMessage();
      if (accumulator.parts.length > 0) {
        await this._persistAssistantMessage(assistantMsg);
        this._broadcastMessages();
      }

      if (streamError) {
        await this._fireResponseHook({
          message: assistantMsg,
          requestId,
          continuation: false,
          status: "error",
          error: streamError
        });
        pendingRpcError = streamError;
      } else if (!aborted) {
        await callback.onDone();
        await this._fireResponseHook({
          message: assistantMsg,
          requestId,
          continuation: false,
          status: "completed"
        });
      } else {
        await this._fireResponseHook({
          message: assistantMsg,
          requestId,
          continuation: false,
          status: "aborted"
        });
      }
    } catch (error) {
      if (!streamFinalized) {
        this._resumableStream.markError(streamId);
        streamFinalized = true;
      }
      if (!doneSent) {
        const streamError =
          error instanceof Error ? error.message : "Stream error";
        this._broadcastChat({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: streamError,
          done: true,
          error: true
        });
        doneSent = true;
      }

      if (!assistantMsg && accumulator.parts.length > 0) {
        assistantMsg = accumulator.toMessage();
        await this._persistAssistantMessage(assistantMsg);
        this._broadcastMessages();
      }

      const wrapped = this.onChatError(error);
      const errorMessage =
        wrapped instanceof Error ? wrapped.message : String(wrapped);

      if (assistantMsg) {
        await this._fireResponseHook({
          message: assistantMsg,
          requestId,
          continuation: false,
          status: "error",
          error: errorMessage
        });
      }

      await callback.onError(errorMessage);
    }

    if (pendingRpcError) {
      await callback.onError(pendingRpcError);
    }
  }

  private _shouldFlushRpcStreamChunk(
    chunk: StreamChunkData,
    chunksSinceFlush: number,
    hasFlushedContent: boolean
  ): boolean {
    const isRecoverableContent =
      chunk.type === "text-delta" ||
      chunk.type === "reasoning-delta" ||
      chunk.type === "tool-input-available" ||
      chunk.type === "tool-output-available" ||
      chunk.type === "tool-output-error";

    return (
      isRecoverableContent && (!hasFlushedContent || chunksSinceFlush >= 10)
    );
  }

  private async _streamResult(
    requestId: string,
    result: StreamableResult,
    abortSignal?: AbortSignal,
    options?: {
      continuation?: boolean;
      parentId?: string;
      captureProgrammaticStreamError?: boolean;
      captureOutput?: boolean;
    }
  ): Promise<StreamResultStatus> {
    const clearGen = this._turnQueue.generation;
    const streamId = this._resumableStream.start(requestId);
    const continuation = options?.continuation ?? false;
    const parentId = options?.parentId;

    if (this._continuation.pending?.requestId === requestId) {
      this._continuation.activatePending();
      this._continuation.flushAwaitingConnections((c) =>
        this._notifyStreamResuming(c as Connection)
      );
    }

    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID()
    });

    let doneSent = false;
    let streamAborted = false;
    let streamError: string | undefined;
    let output: unknown;

    try {
      this._insideInferenceLoop = true;
      try {
        for await (const chunk of result.toUIMessageStream()) {
          if (abortSignal?.aborted) {
            streamAborted = true;
            break;
          }

          const { action } = accumulator.applyChunk(
            chunk as unknown as StreamChunkData
          );

          if (action?.type === "error") {
            streamError = action.error;
            if (options?.captureProgrammaticStreamError) {
              this._programmaticStreamErrors.set(requestId, streamError);
            }
            this._emit("message:error", { error: streamError });
            this._broadcastChat({
              type: MSG_CHAT_RESPONSE,
              id: requestId,
              body: action.error,
              done: false,
              error: true
            });
            break;
          }

          const chunkBody = JSON.stringify(chunk);
          this._resumableStream.storeChunk(streamId, chunkBody);
          this._broadcastChat({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: chunkBody,
            done: false
          });
        }
      } finally {
        this._insideInferenceLoop = false;
      }

      if (streamError) {
        this._resumableStream.markError(streamId);
      } else {
        this._resumableStream.complete(streamId);
      }
      this._pendingResumeConnections.clear();
      this._broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true
      });
      doneSent = true;
    } catch (error) {
      streamError = error instanceof Error ? error.message : "Stream error";
      if (options?.captureProgrammaticStreamError) {
        this._programmaticStreamErrors.set(requestId, streamError);
      }
      this._resumableStream.markError(streamId);
      this._pendingResumeConnections.clear();
      if (!doneSent) {
        this._broadcastChat({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: streamError,
          done: true,
          error: true
        });
        doneSent = true;
      }
    } finally {
      if (!doneSent) {
        this._resumableStream.markError(streamId);
        this._pendingResumeConnections.clear();
        this._broadcastChat({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: "",
          done: true
        });
      }
    }

    if (
      options?.captureOutput &&
      result.output &&
      !streamError &&
      !streamAborted
    ) {
      try {
        output = await result.output;
      } catch (error) {
        streamError =
          error instanceof Error ? error.message : "Structured output error";
        if (options.captureProgrammaticStreamError) {
          this._programmaticStreamErrors.set(requestId, streamError);
        }
      }
    }

    if (this._turnQueue.generation === clearGen) {
      try {
        const assistantMsg = accumulator.toMessage();

        if (accumulator.parts.length > 0) {
          await this._persistAssistantMessage(assistantMsg, parentId);
          this._broadcastMessages();
        }

        await this._fireResponseHook({
          message: assistantMsg,
          requestId,
          continuation,
          status: streamError
            ? "error"
            : streamAborted
              ? "aborted"
              : "completed",
          error: streamError
        });
      } catch (e) {
        console.error("Failed to persist assistant message:", e);
      }
    }

    return streamError
      ? { status: "error", error: streamError }
      : {
          status: streamAborted ? "aborted" : "completed",
          ...(output !== undefined && { output })
        };
  }

  // ── Session-backed persistence ──────────────────────────────────

  private async _persistAssistantMessage(
    msg: UIMessage,
    parentId?: string
  ): Promise<void> {
    await this._upsertMessageInHistory(msg, parentId);
  }

  /**
   * Persist an incoming message after reconciliation. For assistant
   * messages, also resolve their ID against any server-side row that
   * already owns the same `toolCallId` so we update the existing row
   * instead of inserting an orphan duplicate.
   */
  private async _persistIncomingMessage(
    msg: UIMessage,
    serverMessages: readonly UIMessage[]
  ): Promise<void> {
    const resolved =
      msg.role === "assistant" ? resolveToolMergeId(msg, serverMessages) : msg;
    await this._upsertMessageInHistory(resolved);
  }

  private _persistClientTools(): void {
    if (this._lastClientTools) {
      this._configSet("lastClientTools", JSON.stringify(this._lastClientTools));
    } else {
      this._configDelete("lastClientTools");
    }
  }

  private _restoreClientTools(): void {
    const raw = this._configGet("lastClientTools");
    if (raw) {
      try {
        this._lastClientTools = JSON.parse(raw);
      } catch {
        this._lastClientTools = undefined;
      }
    }
  }

  private _persistBody(): void {
    if (this._lastBody) {
      this._configSet("lastBody", JSON.stringify(this._lastBody));
    } else {
      this._configDelete("lastBody");
    }
  }

  private _restoreBody(): void {
    const raw = this._configGet("lastBody");
    if (raw) {
      try {
        this._lastBody = JSON.parse(raw);
      } catch {
        this._lastBody = undefined;
      }
    }
  }

  // ── Tool state updates (shared primitives from agents/chat) ─────

  private async _applyToolResult(
    toolCallId: string,
    output: unknown,
    overrideState?: "output-error",
    errorText?: string
  ): Promise<void> {
    const update = toolResultUpdate(
      toolCallId,
      output,
      overrideState,
      errorText
    );
    await this._applyToolUpdateToMessages(update);
  }

  private async _applyToolApproval(
    toolCallId: string,
    approved: boolean
  ): Promise<void> {
    const update = toolApprovalUpdate(toolCallId, approved);
    await this._applyToolUpdateToMessages(update);
  }

  private async _applyToolUpdateToMessages(update: {
    toolCallId: string;
    matchStates: string[];
    apply: (part: Record<string, unknown>) => Record<string, unknown>;
  }): Promise<void> {
    const history = await this._readMessagesFromStorage();
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      const result = applyToolUpdate(
        msg.parts as Array<Record<string, unknown>>,
        update
      );
      if (result) {
        const updatedMsg = {
          ...msg,
          parts: result.parts as UIMessage["parts"]
        };
        const safe = await this._updateMessageInHistory(updatedMsg);
        // Patch the live cache in place instead of doing a full
        // `_syncMessages()` round-trip.
        // A full re-read during a streaming turn drops in-flight messages
        // whose parent chain hasn't been persisted yet (see commits
        // 3f615a24 "revert _syncMessages in _applyToolUpdateToMessages"
        // and 6e76bd49 "update cached messages in-place"). The cache is
        // the source of truth during a turn; we only reconcile it here to
        // reflect the tool update that was just written to storage.
        this._broadcast({ type: MSG_MESSAGE_UPDATED, message: safe });
        return;
      }
    }
  }

  // ── Stability + pending interactions ─────────────────────────────

  protected hasPendingInteraction(): boolean {
    return this.messages.some(
      (message) =>
        message.role === "assistant" &&
        this._messageHasPendingInteraction(message)
    );
  }

  protected async waitUntilStable(options?: {
    timeout?: number;
  }): Promise<boolean> {
    const deadline =
      options?.timeout != null ? Date.now() + options.timeout : null;

    while (true) {
      if (
        (await this._awaitWithDeadline(
          this._submitConcurrency.waitForIdle(() =>
            this._turnQueue.waitForIdle()
          ),
          deadline
        )) === TIMED_OUT
      ) {
        return false;
      }

      if (!this.hasPendingInteraction()) {
        return true;
      }

      const pending = this._pendingInteractionPromise;
      if (pending) {
        let result: boolean | typeof TIMED_OUT;
        try {
          result = await this._awaitWithDeadline(pending, deadline);
        } catch {
          continue;
        }
        if (result === TIMED_OUT) {
          return false;
        }
      } else {
        if (
          (await this._awaitWithDeadline(
            new Promise<void>((resolve) => setTimeout(resolve, 100)),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
      }
    }
  }

  private async _awaitWithDeadline<T>(
    promise: Promise<T>,
    deadline: number | null
  ): Promise<T | typeof TIMED_OUT> {
    if (deadline == null) {
      return promise;
    }
    const remainingMs = Math.max(0, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), remainingMs);
      })
    ]);
    clearTimeout(timer!);
    return result;
  }

  private _messageHasPendingInteraction(message: UIMessage): boolean {
    return message.parts.some(
      (part) =>
        "state" in part &&
        ((part as Record<string, unknown>).state === "input-available" ||
          (part as Record<string, unknown>).state === "approval-requested")
    );
  }

  // ── Chat recovery via fibers ───────────────────────────────────

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    if (await this._messengerRuntime?.handleFiberRecovery(ctx)) {
      return true;
    }

    const chatPrefix = (this.constructor as typeof Think).CHAT_FIBER_NAME + ":";
    if (!ctx.name.startsWith(chatPrefix)) {
      return false;
    }

    const requestId = ctx.name.slice(chatPrefix.length);
    const { snapshot: recoverySnapshot, user: recoveryData } =
      unwrapChatFiberSnapshot<"think-chat-turn">(
        "__cfThinkChatFiberSnapshot",
        ctx.snapshot,
        "think-chat-turn"
      );

    let streamId = "";
    let streamStatus: "streaming" | "completed" | "error" | undefined;
    if (requestId) {
      const rows = this.sql<{
        id: string;
        status: "streaming" | "completed" | "error";
      }>`
        SELECT id, status FROM cf_ai_chat_stream_metadata
        WHERE request_id = ${requestId}
        ORDER BY created_at DESC LIMIT 1
      `;
      if (rows.length > 0) {
        streamId = rows[0].id;
        streamStatus = rows[0].status;
      }
    }
    if (!streamId && this._resumableStream.hasActiveStream()) {
      streamId = this._resumableStream.activeStreamId ?? "";
      streamStatus = "streaming";
    }

    const partial = streamId
      ? this._getPartialStreamText(streamId)
      : { text: "", parts: [] as MessagePart[] };

    const options =
      (await this.onChatRecovery({
        streamId: streamId ?? "",
        requestId,
        partialText: partial.text,
        partialParts: partial.parts,
        recoveryData,
        messages: [...this.messages],
        lastBody: recoverySnapshot?.lastBody ?? this._lastBody,
        lastClientTools:
          recoverySnapshot?.lastClientTools ?? this._lastClientTools,
        createdAt: ctx.createdAt
      })) ?? {};

    const streamStillActive =
      streamId &&
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeStreamId === streamId;

    const streamIsTerminal =
      streamStatus === "completed" || streamStatus === "error";

    if (
      options.persist !== false &&
      streamId &&
      (streamStillActive || streamIsTerminal)
    ) {
      await this._persistOrphanedStream(streamId);
    }

    if (streamStillActive) {
      this._resumableStream.complete(streamId);
    }

    const retryTargetUserId = await this._recoverablePreStreamUserId(
      recoverySnapshot,
      streamId ?? "",
      partial
    );
    const shouldRetry =
      retryTargetUserId !== null &&
      options.continue !== false &&
      !streamIsTerminal;
    const canContinue =
      !shouldRetry && options.continue !== false && !streamIsTerminal;
    const hasRunningSubmission = this._hasRunningSubmission(requestId);

    if (streamIsTerminal && hasRunningSubmission) {
      await this._completeRecoveredSubmission(
        requestId,
        streamStatus === "completed" ? "completed" : "error",
        requestId,
        streamStatus === "completed"
          ? null
          : "Recovered chat stream had already errored."
      );
    }

    const recoveredRequestId =
      (canContinue || shouldRetry) && hasRunningSubmission
        ? requestId
        : undefined;

    if (shouldRetry) {
      await this.schedule(
        0,
        "_chatRecoveryRetry",
        {
          targetUserId: retryTargetUserId,
          originalRequestId: requestId,
          lastBody: recoverySnapshot?.lastBody ?? null,
          lastClientTools: recoverySnapshot?.lastClientTools ?? null,
          ...(recoveredRequestId ? { recoveredRequestId } : {})
        },
        { idempotent: true }
      );
    } else if (canContinue) {
      const lastLeaf = await this.session.getLatestLeaf();
      const targetId = lastLeaf?.role === "assistant" ? lastLeaf.id : undefined;
      await this.schedule(
        0,
        "_chatRecoveryContinue",
        {
          ...(targetId ? { targetAssistantId: targetId } : {}),
          originalRequestId: requestId,
          ...(recoverySnapshot
            ? {
                lastBody: recoverySnapshot.lastBody ?? null,
                lastClientTools: recoverySnapshot.lastClientTools ?? null
              }
            : {}),
          ...(recoveredRequestId ? { recoveredRequestId } : {})
        },
        { idempotent: true }
      );
    } else if (options.continue === false && !streamIsTerminal) {
      await this._markRecoveredSubmissionInterrupted(
        requestId,
        "Submission was interrupted and chat recovery was disabled."
      );
    }

    return true;
  }

  private async _recoverablePreStreamUserId(
    snapshot: ChatFiberSnapshot<"think-chat-turn"> | null,
    streamId: string,
    partial: { text: string; parts: MessagePart[] }
  ): Promise<string | null> {
    if (
      !snapshot ||
      snapshot.continuation ||
      !snapshot.latestUserMessageId ||
      streamId ||
      partial.text ||
      partial.parts.length > 0
    ) {
      return null;
    }

    const lastLeaf = await this.session.getLatestLeaf();
    return lastLeaf?.role === "user" &&
      lastLeaf.id === snapshot.latestUserMessageId
      ? snapshot.latestUserMessageId
      : null;
  }

  async _chatRecoveryRetry(data?: ChatRecoveryRetryData): Promise<void> {
    const recoveredSubmission = data?.recoveredRequestId
      ? this._readRunningSubmissionByRequestId(data.recoveredRequestId)
      : null;
    if (data?.recoveredRequestId && !recoveredSubmission) {
      return;
    }

    const controller = recoveredSubmission ? new AbortController() : null;
    if (recoveredSubmission && controller) {
      this._submissionAbortControllers.set(
        recoveredSubmission.submission_id,
        controller
      );
    }

    try {
      const ready = await this.waitUntilStable({ timeout: 10_000 });
      if (!ready) {
        if (data?.recoveredRequestId) {
          await this._completeRecoveredSubmission(
            data.recoveredRequestId,
            "error",
            null,
            "Recovered chat retry timed out waiting for stable state."
          );
        }
        return;
      }

      const lastLeaf = await this.session.getLatestLeaf();
      if (!lastLeaf || lastLeaf.role !== "user") {
        if (data?.recoveredRequestId) {
          await this._completeRecoveredSubmission(
            data.recoveredRequestId,
            "error",
            null,
            "Recovered chat retry was skipped because there is no unanswered user message."
          );
        }
        return;
      }

      if (data?.targetUserId && lastLeaf.id !== data.targetUserId) {
        if (data?.recoveredRequestId) {
          await this._completeRecoveredSubmission(
            data.recoveredRequestId,
            "error",
            null,
            "Recovered chat retry was skipped because the conversation changed."
          );
        }
        return;
      }

      this._applyRecoveredRequestContext(data);
      const result = await this._retryLastUserTurn(
        this._lastClientTools,
        this._lastBody,
        controller ? { signal: controller.signal } : undefined
      );
      if (data?.recoveredRequestId) {
        await this._completeRecoveredSubmission(
          data.recoveredRequestId,
          result.status,
          result.requestId || null,
          result.status === "completed"
            ? null
            : (result.error ?? `Recovery retry ${result.status}.`)
        );
      }
    } catch (error) {
      if (data?.recoveredRequestId) {
        await this._completeRecoveredSubmission(
          data.recoveredRequestId,
          "error",
          null,
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    } finally {
      if (recoveredSubmission) {
        this._submissionAbortControllers.delete(
          recoveredSubmission.submission_id
        );
      }
    }
  }

  private _hasRunningSubmission(requestId: string): boolean {
    return this._readRunningSubmissionByRequestId(requestId) !== null;
  }

  private _readRunningSubmissionByRequestId(
    requestId: string
  ): ThinkSubmissionRow | null {
    this._ensureSubmissionTable();
    const rows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      WHERE request_id = ${requestId}
        AND status = 'running'
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async _markRecoveredSubmissionInterrupted(
    requestId: string,
    message: string
  ): Promise<void> {
    this._ensureSubmissionTable();
    const rows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      WHERE request_id = ${requestId}
        AND status = 'running'
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return;
    this.sql`
      UPDATE cf_think_submissions
      SET status = 'error',
          error_message = ${message},
          completed_at = ${Date.now()}
      WHERE submission_id = ${row.submission_id}
        AND status = 'running'
    `;
    const updated = this._readSubmission(row.submission_id);
    if (updated) await this._emitSubmissionStatus(updated);
  }

  private async _completeRecoveredSubmission(
    originalRequestId: string,
    status: ThinkSubmissionStatus,
    requestId: string | null,
    errorMessage: string | null
  ): Promise<void> {
    this._ensureSubmissionTable();
    const completedAt = Date.now();
    const streamId = requestId
      ? (this._resumableStream
          .getAllStreamMetadata()
          .find((metadata) => metadata.request_id === requestId)?.id ?? null)
      : null;
    this.sql`
      UPDATE cf_think_submissions
      SET status = ${status},
          request_id = COALESCE(${requestId}, request_id),
          stream_id = COALESCE(${streamId}, stream_id),
          error_message = ${errorMessage},
          completed_at = ${completedAt}
      WHERE request_id = ${originalRequestId}
        AND status = 'running'
    `;
    const rows = this.sql<ThinkSubmissionRow>`
      SELECT submission_id, idempotency_key, request_id, stream_id, status,
             messages_json, metadata_json, error_message, created_at,
             messages_applied_at, started_at, completed_at
      FROM cf_think_submissions
      WHERE request_id = COALESCE(${requestId}, ${originalRequestId})
      ORDER BY completed_at DESC
      LIMIT 1
    `;
    const updated = rows[0];
    if (updated && this._isTerminalSubmissionStatus(updated.status)) {
      await this._emitSubmissionStatus(updated);
    }
  }

  protected async onChatRecovery(
    _ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions | void> {
    return {};
  }

  async _chatRecoveryContinue(data?: ChatRecoveryContinueData): Promise<void> {
    const recoveredSubmission = data?.recoveredRequestId
      ? this._readRunningSubmissionByRequestId(data.recoveredRequestId)
      : null;
    if (data?.recoveredRequestId && !recoveredSubmission) {
      return;
    }

    const controller = recoveredSubmission ? new AbortController() : null;
    if (recoveredSubmission && controller) {
      this._submissionAbortControllers.set(
        recoveredSubmission.submission_id,
        controller
      );
    }

    try {
      const ready = await this.waitUntilStable({ timeout: 10_000 });
      if (!ready) {
        console.warn(
          "[Think] _chatRecoveryContinue timed out waiting for stable state, skipping continuation"
        );
        if (data?.recoveredRequestId) {
          await this._completeRecoveredSubmission(
            data.recoveredRequestId,
            "error",
            null,
            "Recovered chat continuation timed out waiting for stable state."
          );
        }
        return;
      }

      const targetId = data?.targetAssistantId;
      const lastLeaf = await this.session.getLatestLeaf();
      if (targetId && lastLeaf?.id !== targetId) {
        if (data?.recoveredRequestId) {
          await this._completeRecoveredSubmission(
            data.recoveredRequestId,
            "error",
            null,
            "Recovered chat continuation was skipped because the conversation changed."
          );
        }
        return;
      }

      this._applyRecoveredRequestContext(data);
      const result = await this.continueLastTurn(
        undefined,
        controller ? { signal: controller.signal } : undefined
      );
      if (data?.recoveredRequestId) {
        await this._completeRecoveredSubmission(
          data.recoveredRequestId,
          result.status,
          result.requestId || null,
          result.status === "completed"
            ? null
            : (result.error ?? `Recovery ${result.status}.`)
        );
      }
    } catch (error) {
      if (data?.recoveredRequestId) {
        await this._completeRecoveredSubmission(
          data.recoveredRequestId,
          "error",
          null,
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    } finally {
      if (recoveredSubmission) {
        this._submissionAbortControllers.delete(
          recoveredSubmission.submission_id
        );
      }
    }
  }

  private _applyRecoveredRequestContext(
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined
  ): void {
    if (!data) return;
    if ("lastClientTools" in data) {
      this._lastClientTools = data.lastClientTools ?? undefined;
      this._persistClientTools();
    }
    if ("lastBody" in data) {
      this._lastBody = data.lastBody ?? undefined;
      this._persistBody();
    }
  }

  private _getPartialStreamText(streamId: string): {
    text: string;
    parts: MessagePart[];
  } {
    const chunks = this._resumableStream.getStreamChunks(streamId);
    const parts: MessagePart[] = [];

    for (const chunk of chunks) {
      try {
        const data = JSON.parse(chunk.body);
        applyChunkToParts(parts, data);
      } catch {
        // skip malformed chunks
      }
    }

    const text = parts
      .filter(
        (p): p is MessagePart & { type: "text"; text: string } =>
          p.type === "text" && "text" in p
      )
      .map((p) => p.text)
      .join("");

    return { text, parts };
  }

  // ── Concurrency strategies ──────────────────────────────────────

  private _getSubmitConcurrencyDecision(
    isSubmitMessage: boolean
  ): SubmitConcurrencyDecision {
    return this._submitConcurrency.decide({
      concurrency: this.messageConcurrency,
      isSubmitMessage,
      queuedTurns: this._turnQueue.queuedCount()
    });
  }

  private _completeSkippedRequest(
    connection: Connection,
    requestId: string
  ): void {
    connection.send(
      JSON.stringify({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true
      })
    );
  }

  private _rollbackDroppedSubmit(connection: Connection): void {
    connection.send(
      JSON.stringify({
        type: MSG_CHAT_MESSAGES,
        messages: this.messages
      })
    );
  }

  // ── Auto-continuation ──────────────────────────────────────────

  private _scheduleAutoContinuation(connection: Connection): void {
    if (this._continuation.pending?.pastCoalesce) {
      this._continuation.deferred = {
        connection,
        connectionId: connection.id,
        clientTools: this._lastClientTools,
        body: undefined,
        errorPrefix: "[Think] Auto-continuation failed:",
        prerequisite: null
      };
      return;
    }

    if (this._continuation.pending) {
      this._continuation.pending.connection = connection;
      this._continuation.pending.connectionId = connection.id;
      this._continuation.pending.clientTools = this._lastClientTools;
      this._continuation.awaitingConnections.set(connection.id, connection);
      return;
    }

    if (this._continuationTimer) {
      clearTimeout(this._continuationTimer);
    }
    this._continuationTimer = setTimeout(() => {
      this._continuationTimer = null;
      this._fireAutoContinuation(connection);
    }, 50);
  }

  private _fireAutoContinuation(connection: Connection): void {
    if (!this._continuation.pending) {
      const requestId = crypto.randomUUID();
      this._continuation.pending = {
        connection,
        connectionId: connection.id,
        requestId,
        clientTools: this._lastClientTools,
        body: undefined,
        errorPrefix: "[Think] Auto-continuation failed:",
        prerequisite: null,
        pastCoalesce: false
      };
      this._continuation.awaitingConnections.set(connection.id, connection);
    }

    const { requestId, clientTools } = this._continuation.pending!;
    const abortSignal = this._aborts.getSignal(requestId);

    this.keepAliveWhile(async () => {
      await this._turnQueue.enqueue(requestId, async () => {
        if (this._continuation.pending) {
          this._continuation.pending.pastCoalesce = true;
        }
        let streamed = false;
        try {
          const continuationBody = async () => {
            const result = await agentContext.run(
              {
                agent: this,
                connection,
                request: undefined,
                email: undefined
              },
              () =>
                this._runInferenceLoop({
                  signal: abortSignal,
                  clientTools,
                  body: this._lastBody,
                  continuation: true
                })
            );
            if (result) {
              await this._streamResult(requestId, result, abortSignal, {
                continuation: true
              });
              streamed = true;
            }
          };

          if (this.chatRecovery) {
            await this._runChatRecoveryFiber(requestId, true, continuationBody);
          } else {
            await continuationBody();
          }
        } finally {
          this._aborts.remove(requestId);
          if (!streamed) {
            this._continuation.sendResumeNone();
          }
          this._continuation.clearPending();
          this._activateDeferredContinuation();
        }
      });
    }).catch((error) => {
      console.error("[Think] Auto-continuation failed:", error);
      this._aborts.remove(requestId);
    });
  }

  private _activateDeferredContinuation(): void {
    const pending = this._continuation.activateDeferred(() =>
      crypto.randomUUID()
    );
    if (!pending) return;

    this._fireAutoContinuation(pending.connection as Connection);
  }

  // ── Response hook ──────────────────────────────────────────────

  private async _fireResponseHook(result: ChatResponseResult): Promise<void> {
    if (this._insideResponseHook) return;
    this._insideResponseHook = true;
    try {
      await this.onChatResponse(result);
    } catch (err) {
      console.error("[Think] onChatResponse error:", err);
    } finally {
      this._insideResponseHook = false;
    }
  }

  // ── Resume helpers ──────────────────────────────────────────────

  private _notifyStreamResuming(connection: Connection): void {
    if (!this._resumableStream.hasActiveStream()) return;
    const sent = sendIfOpen(
      connection,
      JSON.stringify({
        type: MSG_STREAM_RESUMING,
        id: this._resumableStream.activeRequestId
      })
    );
    if (sent) {
      this._pendingResumeConnections.add(connection.id);
    }
  }

  private async _persistOrphanedStream(streamId: string): Promise<void> {
    this._resumableStream.flushBuffer();
    const chunks = this._resumableStream.getStreamChunks(streamId);
    if (chunks.length === 0) return;

    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID()
    });
    for (const chunk of chunks) {
      try {
        accumulator.applyChunk(JSON.parse(chunk.body) as StreamChunkData);
      } catch {
        // skip malformed chunks
      }
    }

    if (accumulator.parts.length > 0) {
      await this._persistAssistantMessage(accumulator.toMessage());
      this._broadcastMessages();
    }
  }

  private _broadcastChat(message: Record<string, unknown>, exclude?: string[]) {
    const allExclusions = [
      ...(exclude || []),
      ...this._pendingResumeConnections
    ];
    this.broadcast(JSON.stringify(message), allExclusions);
  }

  private _broadcast(message: Record<string, unknown>, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  private _broadcastMessages(exclude?: string[]) {
    this._broadcast(
      { type: MSG_CHAT_MESSAGES, messages: this.messages },
      exclude
    );
  }
}
