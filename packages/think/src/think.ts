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
 *     return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.7-code");
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

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  FlexibleSchema,
  InferSchema,
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
  hasToolCall,
  jsonSchema,
  stepCountIs,
  streamText,
  tool
} from "ai";
import * as skills from "agents/skills";
import { SkillRegistry } from "agents/skills";
import type { SkillScriptRunner, SkillSource } from "agents/skills";

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
export { skills };
export type { SkillRunContext, SkillSource } from "agents/skills";
import {
  Agent,
  callable,
  getCurrentAgent,
  isPlatformTransientError,
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
  cleanupStreamBuffers,
  STREAM_CLEANUP_DELAY_SECONDS,
  ContinuationState,
  PreStreamTurns,
  AutoContinuationController,
  TIMED_OUT,
  awaitWithDeadline,
  drainInteractionApplies,
  interceptAgentToolBroadcast,
  SubmitConcurrencyController,
  createToolsFromClientSchemas,
  AbortRegistry,
  applyToolUpdate,
  toolResultUpdate,
  crossMessageToolResultUpdate,
  toolApprovalUpdate,
  pausedExecutionUpdate,
  hasIncompleteToolBatch,
  partAwaitsClientInteraction,
  clientResolvableToolNames,
  parseProtocolMessage,
  aiSdkRecoveryCodec,
  ResumeHandshake,
  normalizeToolInput,
  repairInterruptedToolParts,
  toolPartHasSettledResult,
  persistReconstructedOrphan,
  reconcileMessages,
  resolveToolMergeId,
  createChatFiberSnapshot,
  unwrapChatFiberSnapshot,
  wrapChatFiberSnapshot,
  MAX_BOUND_PARAMS,
  buildInClauseStrings,
  resolveChatRecoveryConfig,
  chatRecoverySchedulePolicy,
  ChatRecoveryEngine,
  runChatRecoveryExhaustion,
  ChatStreamStalledError,
  iterateWithStallWatchdog,
  sweepStaleChatRecoveryIncidents,
  readChatRecoveryProgress,
  bumpChatRecoveryProgress,
  recordChatTerminal,
  clearChatTerminal,
  pendingChatTerminal,
  buildChatRecoveringFrame,
  setChatRecovering,
  AgentToolStreamProgressThrottle,
  StreamProgressCreditThrottle,
  shouldCreditStreamProgress,
  classifyAgentToolChildRecovery,
  type ChatRecoveryAdapter,
  type ChatFiberWakeHooks,
  type ResolvedRecoveryStream,
  type ClassifyRecoveredTurnInput,
  type DispatchRecoveredTurnInput,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryIncident,
  type ChatRecoveryKind
} from "agents/chat";
import type {
  StreamChunkData,
  ClientToolSchema,
  ClientToolExecutor,
  MessagePart,
  SubmitConcurrencyDecision,
  ChatFiberSnapshot,
  OrphanPersistStore
} from "agents/chat";
import { Session } from "agents/experimental/memory/session";
import type { SessionMessage } from "agents/experimental/memory/session";
import { truncateOlderMessages } from "agents/experimental/memory/utils";
import {
  evictLargeMediaFromMessage,
  resolveMediaEvictionConfig,
  type MediaEvictionConfig,
  type ResolvedMediaEvictionConfig
} from "./media-eviction";

/**
 * The recent-message span the model sees at FULL fidelity each turn —
 * `truncateOlderMessages`' default `keepRecent` (see `_assembleModelMessages`).
 *
 * Both memory bounds are anchored to this window (#1710):
 * - budgeted hydration never shrinks `this.messages` below it (the floor
 *   passed to `session.getRecentHistory`), so windowing cannot starve the
 *   model's context;
 * - media eviction never rewrites messages inside it (the
 *   `keepRecentMessages` clamp), so content the model still replays at full
 *   fidelity is never replaced with markers.
 */
const MODEL_RECENT_WINDOW = 4;
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const ACTION_OUTPUT_MAX_CHARS = 20_000;
const MAX_REPLY_ATTACHMENTS_PER_TURN = 32;
const ACTION_LEDGER_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const ACTION_LEDGER_LAST_SWEPT_KEY = "cf_think_action_ledger:last_swept_at";
const ACTION_PENDING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const ACTION_PENDING_LAST_SWEPT_KEY =
  "cf_think_action_pending_approvals:last_swept_at";
/** Prefix for durable-pause action execution ids (vs codemode execution ids). */
const ACTION_PAUSE_ID_PREFIX = "actpause_";
import { Workspace } from "@cloudflare/shell";
import { createWorkspaceTools } from "./tools/workspace";
import { truncatePausedExecutionOutput } from "./tools/execute";
import { ExtensionManager, sanitizeName } from "./extensions/manager";
import { ThinkMessengerRuntime } from "./messengers/chat-sdk";
import type {
  DeliveryKind,
  MessengerContext,
  MessengerDeliverySurface,
  ThinkMessengers,
  MessengerThinkHost
} from "./messengers";
import { resolveChannels } from "./channels";
import type {
  ChannelContext,
  NormalizedChannelDefinition,
  ThinkChannels
} from "./channels";

export { defineChannels, messengerChannel } from "./channels";
export type {
  ChannelCapabilities,
  ChannelContext,
  ChannelDefinition,
  ChannelDeliveryPolicy,
  ChannelDeliverySurface,
  ChannelIngress,
  ChannelKind,
  NormalizedChannelDefinition,
  ThinkChannels
} from "./channels";
export type { DeliveryKind, DeliveryTag } from "./messengers";
export { Session } from "agents/experimental/memory/session";
export type { SessionMessage } from "agents/experimental/memory/session";
export { Workspace } from "@cloudflare/shell";
export type { FiberContext, FiberRecoveryContext } from "agents";
export type { WorkspaceLike } from "./tools/workspace";
import type { WorkspaceLike } from "./tools/workspace";

// ── Wire protocol constants ────────────────────────────────────────
const MSG_CHAT_MESSAGES = CHAT_MESSAGE_TYPES.CHAT_MESSAGES;
const MSG_CHAT_RESPONSE = CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE;
const MSG_CHAT_CLEAR = CHAT_MESSAGE_TYPES.CHAT_CLEAR;
const MSG_MESSAGE_UPDATED = CHAT_MESSAGE_TYPES.MESSAGE_UPDATED;
const MSG_CHAT_RECOVERING = CHAT_MESSAGE_TYPES.CHAT_RECOVERING;

function shouldMarkSkippedAfterGenerationChange(
  status: SaveMessagesResult["status"]
): boolean {
  return status === "completed";
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return `${value.toString()}n`;
    return JSON.stringify(value) ?? "undefined";
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

function stableJsonEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function actionErrorEnvelope(error: unknown): {
  error: { name: string; message: string };
} {
  return {
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error)
    }
  };
}

function streamErrorToString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function actionAuthorizationErrorEnvelope(
  reason: string | undefined,
  permissions: string[]
): {
  error: { name: string; message: string; permissions: string[] };
} {
  return {
    error: {
      name: "ActionAuthorizationError",
      message: reason ?? "Action is not authorized",
      permissions
    }
  };
}

function actionApprovalInputErrorEnvelope(): {
  error: { name: string; message: string };
} {
  return {
    error: {
      name: "ActionApprovalInputError",
      message: "Approved action input cannot be changed by beforeToolCall"
    }
  };
}

function actionPendingErrorEnvelope(): {
  error: { name: string; message: string };
} {
  return {
    error: {
      name: "ActionPendingError",
      message:
        "A prior attempt of this action is in an unknown state; not re-executed. Manual reconciliation may be required."
    }
  };
}

function actionKeyConflictEnvelope(
  actionName: string,
  key: string
): {
  error: { name: string; message: string };
} {
  return {
    error: {
      name: "ActionKeyConflict",
      message: `Idempotency key "${key}" for action "${actionName}" was reused with different input. This is a programming error; do not retry.`
    }
  };
}

function encodeActionLedgerOutput(
  output: unknown
): { ok: true; json: string; value: unknown } | { ok: false } {
  try {
    const json = JSON.stringify({
      valuePresent: output !== undefined,
      value: output
    });
    if (json === undefined) return { ok: false };
    const parsed = JSON.parse(json) as {
      valuePresent: boolean;
      value?: unknown;
    };
    if (output !== undefined && !("value" in parsed)) {
      return { ok: false };
    }
    return {
      ok: true,
      json,
      value: parsed.valuePresent ? parsed.value : undefined
    };
  } catch {
    return { ok: false };
  }
}

function decodeActionLedgerOutput(json: string | null): unknown {
  if (json === null) return undefined;
  const parsed = JSON.parse(json) as {
    valuePresent?: unknown;
    value?: unknown;
  };
  return parsed.valuePresent === true ? parsed.value : undefined;
}

function safeStringifyActionOutput(output: unknown): {
  value?: string;
  lossy: boolean;
  error?: string;
} {
  const seen = new WeakSet<object>();
  let lossy = false;
  try {
    const value = JSON.stringify(output, (_key, value: unknown) => {
      if (typeof value === "bigint") {
        lossy = true;
        return `${value.toString()}n`;
      }
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          lossy = true;
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    });
    return { value, lossy };
  } catch (error) {
    return {
      lossy: true,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function prepareActionOutputForModel(output: unknown): unknown {
  if (typeof output === "string") {
    if (output.length <= ACTION_OUTPUT_MAX_CHARS) return output;
    return `${output.slice(0, ACTION_OUTPUT_MAX_CHARS)}\n\n[truncated ${output.length - ACTION_OUTPUT_MAX_CHARS} chars]`;
  }

  const serialized = safeStringifyActionOutput(output);
  if (serialized.error) {
    return {
      serialized: false,
      error: serialized.error
    };
  }
  if (serialized.value === undefined) return output;
  if (serialized.value.length <= ACTION_OUTPUT_MAX_CHARS) {
    if (!serialized.lossy) return output;
    return JSON.parse(serialized.value) as unknown;
  }

  return {
    truncated: true,
    chars: serialized.value.length,
    preview: `${serialized.value.slice(0, ACTION_OUTPUT_MAX_CHARS)}\n\n[truncated ${serialized.value.length - ACTION_OUTPUT_MAX_CHARS} chars]`
  };
}

function createActionAbortSignal(
  turnSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abortFromTurn = () => controller.abort(turnSignal?.reason);

  if (turnSignal?.aborted) {
    abortFromTurn();
  } else {
    turnSignal?.addEventListener("abort", abortFromTurn, { once: true });
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeout = setTimeout(() => {
        controller.abort(new Error(`Action timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      turnSignal?.removeEventListener("abort", abortFromTurn);
    }
  };
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
  incidentId?: string;
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
  recoveredRequestId?: string;
};

type ChatRecoveryContinueData = {
  targetAssistantId?: string;
  originalRequestId?: string;
  incidentId?: string;
  lastBody?: Record<string, unknown> | null;
  lastClientTools?: ClientToolSchema[] | null;
  recoveredRequestId?: string;
};

/**
 * `Think`'s `classifyRecoveredTurn` detail (the {@link ChatFiberWakeHooks}
 * generic). `retryTargetUserId` is the pre-stream user message the turn re-runs
 * when it had no partial; the dispatch decision re-derives `streamIsTerminal` from
 * `streamStatus` rather than carrying it here.
 */
type ThinkRecoveryClassification = { retryTargetUserId: string | null };

// `ChatRecoveryIncident` / `ChatRecoveryKind` / `CHAT_RECOVERY_INCIDENT_KEY_PREFIX`
// are the canonical shared symbols from `agents/chat` (imported above); the
// persisted incident shape and key prefix are owned by the engine package so
// both consumers round-trip the same record across the deploy that ships them.

// The durable, monotonic forward-progress counter (`CHAT_RECOVERY_PROGRESS_KEY`)
// and its read/bump helpers now live in the shared engine (agents/chat) —
// `readChatRecoveryProgress` / `bumpChatRecoveryProgress`. Bumped on each durable
// content flush (`_storeChunkDurably`) — production time, so it reflects genuinely
// new content and is immune to reconnects/re-persists; never recomputed from the
// (compactable) transcript.
// Recovery budget defaults (maxAttempts, maxRecoveryWork, stableTimeoutMs,
// terminalMessage, noProgressTimeoutMs, alarm debounce) now live in the shared
// incident engine (agents/chat) and are applied by `resolveChatRecoveryConfig`
// / `evaluateChatRecoveryIncident`. See design/rfc-chat-recovery-foundation.md.
// Auto-continuation barrier (#1649 / #1650): when the model emits parallel tool
// calls, the client answers each one independently and sends a `tool-result`
// with `autoContinue` per result. A fast tool's result must NOT trigger
// inference while a slower sibling is still `input-available` — doing so feeds
// the provider an incomplete tool-result set (MissingToolResultsError) or, with
// the transcript-repair backstop, silently flips the in-flight sibling to
// errored and runs a spurious extra continuation. So we hold the continuation
// until the step's batch settles (no `input-available`/`approval-requested`
// siblings).
//
// The barrier is event-driven (#1650): auto-continuation is only ever triggered
// by a tool-result/approval event, so instead of waiting on a fixed timer we
// drain the in-flight applies, re-check, and — if a sibling is still unanswered
// — simply return, leaving the pending continuation in place. The next sibling's
// result re-arms the coalesce timer (or, after eviction, re-creates the pending
// state from the persisted transcript) and re-runs the check; the continuation
// fires once the final sibling lands. This means a legitimately slow answer (a
// human-in-the-loop tool with no `execute`, an unbounded RPC) never fires
// through to a spurious error, and a true orphan (a sibling that never arrives)
// simply never auto-continues — the isolate is not pinned waiting for it.
// (Stable-state retry delay `CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS` and the
// incident sweep — TTL selection, key prefix, and batched delete — now live in
// agents/chat; the reschedule is owned by the shared engine and the sweep by the
// shared `sweepStaleChatRecoveryIncidents` helper.)
// (The recovering-flag key/TTL and the stream-cleanup delay/re-arm loop now live
// in agents/chat — the durable recovery UX is driven via the shared
// `setChatRecovering` / `buildChatRecoveringFrame` helpers, and buffer cleanup via
// `STREAM_CLEANUP_DELAY_SECONDS` / `cleanupStreamBuffers`. The N9 throttle lives
// there too as `AgentToolStreamProgressThrottle`.)

// Ephemeral user message appended when a model request would otherwise end in
// an assistant message (see `ensureValidContinueCheckpoint`).
const CONTINUE_CHECKPOINT_PROMPT =
  "Continue your previous response from exactly where it left off. Do not repeat any of it.";

/**
 * Ensure a model request does not end in an assistant message.
 *
 * Continuing a partial assistant turn (e.g. after a deploy interrupts a stream)
 * replays a transcript whose final message is that partial assistant message —
 * an "assistant prefill". Modern chat models reject this: Anthropic Claude 4.6+
 * returns a 400 ("This model does not support assistant message prefill. The
 * conversation must end with a user message."). To reach a valid continue
 * checkpoint across providers we append an ephemeral user message. This shapes
 * only the model request; it is never persisted to the transcript.
 */
function ensureValidContinueCheckpoint(
  messages: ModelMessage[]
): ModelMessage[] {
  if (messages.length === 0) return messages;
  if (messages[messages.length - 1]?.role !== "assistant") return messages;
  return [...messages, { role: "user", content: CONTINUE_CHECKPOINT_PROMPT }];
}

// (The terminal-record key and the recovering-flag key now live in agents/chat;
// the durable terminal/recovering records are driven via the shared
// `recordChatTerminal` / `clearChatTerminal` / `pendingChatTerminal` /
// `setChatRecovering` / `buildChatRecoveringFrame` helpers.)

/**
 * A best-effort internal `onStart` step that failed on this wake and was
 * skipped so the agent could still come up (#1710).
 *
 * - `transcript-hydration` — reading the persisted conversation into the
 *   in-memory message cache failed (e.g. `SQLITE_NOMEM` on an oversized,
 *   media-heavy transcript). The agent starts with an empty in-memory view;
 *   persisted history is untouched and the next safe-boundary sync retries.
 * - `scheduled-task-reconcile` — declarative scheduled tasks were not
 *   reconciled on this wake; the next successful wake reconciles them.
 * - `durable-work-recovery` — pending submissions / workflow notifications
 *   were not recovered or drained on this wake.
 */
export interface OnStartDegradation {
  step:
    | "transcript-hydration"
    | "scheduled-task-reconcile"
    | "durable-work-recovery";
  error: unknown;
}

export type { MediaEvictionConfig } from "./media-eviction";

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
  /**
   * The current attempt was interrupted (a stream-stall watchdog abort routed
   * into bounded recovery, #1626) and its final outcome will NOT arrive through
   * this callback. One of two things is true:
   *  - a scheduled continuation — running in a LATER isolate invocation, without
   *    this callback — will produce the answer (delivered to other channels,
   *    e.g. WebSocket connections), OR
   *  - the recovery budget was exhausted, so the turn was already terminalized
   *    out-of-band (the configured `terminalMessage` + `onExhausted`) and is
   *    terminally over — there is NO continuation to come.
   *
   * This is NOT `onDone` (this attempt did not complete) and NOT `onError` (the
   * raw stall is not surfaced as a terminal error here); without it the contract
   * `onStart → onEvent* → (onDone | onError)` is silently abandoned and a
   * consumer that treats the clean resolve as success finalizes a truncated
   * partial.
   *
   * Consumers should AVOID finalizing the partial on this signal — surface a
   * "recovering…" / "interrupted, please retry" state, or re-attach via a
   * durable channel — but must ALSO NOT block indefinitely waiting for a
   * continuation: per the exhausted case above, one may never come. Optional →
   * defaults to a no-op, so this is fully backward-compatible.
   *
   * Note: a deploy/eviction interruption kills the isolate (and this callback)
   * before this can fire — the caller observes a transport break instead. This
   * fires only for an in-isolate interruption (the stall→recovery path).
   */
  onInterrupted?(): void | Promise<void>;
}

/**
 * Minimal interface for the result of the inference loop.
 * The AI SDK's `streamText()` result satisfies this interface.
 */
export interface StreamableResult {
  toUIMessageStream(options?: {
    sendReasoning?: boolean;
    onError?: (error: unknown) => string;
  }): AsyncIterable<unknown>;
  output?: PromiseLike<unknown>;
}

/**
 * Options for a chat turn (sub-agent RPC entry point).
 */
export interface ChatOptions {
  signal?: AbortSignal;
  /**
   * Client-defined tool schemas to expose to the model for this turn, mirroring
   * the `clientTools` carried over the WebSocket chat protocol. Use this when a
   * parent agent delegates to a Think sub-agent over RPC but the sub-agent still
   * needs access to tools the client (or parent) defines at runtime.
   *
   * On their own these are execute-less — the model's call surfaces as a tool
   * call through the stream callback. Provide {@link ChatOptions.onClientToolCall}
   * to also resolve those calls inline so the turn can continue to completion.
   */
  clientTools?: ClientToolSchema[];
  /**
   * Executes a client tool call and returns its output, completing the
   * round trip for {@link ChatOptions.clientTools} within the same turn.
   *
   * Without this, a client-tool call has no result and the turn ends with a
   * dangling tool call (the RPC stream callback has no inbound result channel).
   * With it, the model can call a client tool, receive the result, and keep
   * going — the same multi-step behavior the WebSocket path gets from
   * `cf_agent_tool_result` messages.
   */
  onClientToolCall?: ClientToolExecutor;
  /** Channel id this turn belongs to. See {@link RunTurnBase.channel}. */
  channel?: string;
}

/** Input accepted by {@link Think.runTurn}. */
export type TurnInputMessages =
  | string
  | UIMessage
  | UIMessage[]
  | ((current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>);

/** Shared base for {@link RunTurnOptions}; only `input` is common across modes. */
export interface RunTurnBase {
  input?: TurnInputMessages;
  /**
   * Channel id this turn belongs to (resolved against `configureChannels()` /
   * `getMessengers()`). Sets the turn-scoped channel context and is persisted on
   * the user message so a recovered/continued turn re-resolves it. Defaults to
   * the implicit `web` channel.
   */
  channel?: string;
}

/** Options for {@link Think.runTurn} with `mode: "wait"` (the default). */
export interface RunTurnWait extends RunTurnBase {
  mode?: "wait";
  continuation?: boolean;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Options for {@link Think.runTurn} with `mode: "submit"`. */
export interface RunTurnSubmit extends RunTurnBase {
  mode: "submit";
  submissionId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

/** Options for {@link Think.runTurn} with `mode: "stream"`. */
export interface RunTurnStream extends RunTurnBase {
  mode: "stream";
  callback: StreamCallback;
  clientTools?: ClientToolSchema[];
  onClientToolCall?: ClientToolExecutor;
  signal?: AbortSignal;
}

export type RunTurnOptions = RunTurnWait | RunTurnSubmit | RunTurnStream;

/** Result of {@link Think.runTurn} in `mode: "wait"`. */
export type TurnResult = SaveMessagesResult & {
  message?: SessionMessage;
  continuation: boolean;
};

const ACTION_BRAND: unique symbol = Symbol.for(
  "cf.think.action"
) as typeof ACTION_BRAND;

export type ActionKind =
  | "server"
  | "client"
  | "approval-gated"
  | "durable-pause"
  | "delegated-agent";

export interface ActionContext {
  /** The agent instance currently executing the action. */
  agent: Think;
  env: Cloudflare.Env;
  /** Current turn request id. */
  requestId: string;
  toolCallId: string;
  /** Model messages visible to the tool call. */
  messages: ReadonlyArray<ModelMessage>;
  /** Combined action timeout and turn abort signal. */
  signal: AbortSignal;
  /**
   * Record an advisory delivery hint for this turn's final reply (voice note,
   * card, email draft, ...). Does not change the model-visible tool output.
   * No-op for approval/permission/idempotency policy evaluation and for
   * durable-pause approved-action resumes (their reply is delivered by a
   * later continuation turn in v1).
   */
  attachReply(attachment: ReplyAttachment): void;
}

/**
 * The attachment shape accepted by {@link ActionContext.attachReply}. An open
 * union: the named variants give autocomplete for common channels, and the
 * trailing `{ type: string; [k]: unknown }` keeps it extensible. Advisory only
 * — surfaces that don't recognize a `type` ignore it.
 */
export type ReplyAttachment =
  | { type: "voice_note" }
  | { type: "email_draft"; subject?: string; to?: string[] }
  | { type: "card"; payload: unknown }
  | { type: string; [k: string]: unknown };

export type ActionApprovalPolicy<Input> =
  | boolean
  | ((args: {
      input: Input;
      ctx: ActionContext;
    }) => boolean | Promise<boolean>);

export type ActionPermissionSpec<Input> =
  | readonly string[]
  | ((args: {
      input: Input;
      ctx: ActionContext;
    }) => readonly string[] | Promise<readonly string[]>);

export type ActionIdempotencyKey<Input> =
  | string
  | ((args: { input: Input; ctx: ActionContext }) => string | Promise<string>);

export type ActionAuthorizationDecision =
  | boolean
  | {
      allowed: boolean;
      reason?: string;
      grantedPermissions?: readonly string[];
    };

export interface ActionAuthorizationContext {
  requestId: string;
  toolCallId: string;
  action: string;
  kind: ActionKind;
  input: unknown;
  requiredPermissions: readonly string[];
  grantedPermissions?: readonly string[];
  messages: ReadonlyArray<ModelMessage>;
  agent: Think;
  env: Cloudflare.Env;
}

export interface ActionApprovalDescriptor {
  requestId: string;
  toolCallId: string;
  action: string;
  summary: string;
  input: unknown;
  permissions: string[];
  risk?: "low" | "medium" | "high";
  kind: "approval-gated" | "durable-pause";
}

/**
 * A single approval awaiting a human decision, unified across pause backends so
 * dashboards/voice/messenger can list and reconcile everything pending with one
 * call. `source: "action"` is a parked `kind: "durable-pause"` action;
 * `source: "codemode"` is a paused `execute`-tool execution. Both resolve via
 * {@link Think.approveExecution} / {@link Think.rejectExecution}.
 */
export interface PendingApproval {
  executionId: string;
  source: "action" | "codemode";
  descriptor: ActionApprovalDescriptor;
}

export interface ActionConfig<
  InputSchema extends FlexibleSchema = FlexibleSchema,
  Output = unknown
> {
  /** Defaults to the registration key when returned from getActions(). */
  name?: string;
  description: string;
  inputSchema: InputSchema;
  /** Reserved metadata; output validation is not enforced yet. */
  outputSchema?: FlexibleSchema<Output>;
  /**
   * Stable key used to replay settled action results without re-running side
   * effects. Use domain identifiers that survive recovery retries (for example,
   * an order id or inbound event id); avoid request ids, timestamps, and random
   * values.
   */
  idempotencyKey?: ActionIdempotencyKey<InferSchema<InputSchema>>;
  permissions?: ActionPermissionSpec<InferSchema<InputSchema>>;
  approval?: ActionApprovalPolicy<InferSchema<InputSchema>>;
  approvalSummary?: string;
  approvalRisk?: "low" | "medium" | "high";
  timeoutMs?: number;
  kind?: ActionKind;
  execute(
    input: InferSchema<InputSchema>,
    ctx: ActionContext
  ): Promise<Output> | Output;
}

export interface Action<
  InputSchema extends FlexibleSchema = FlexibleSchema,
  Output = unknown
> {
  readonly [ACTION_BRAND]: true;
  readonly config: ActionConfig<InputSchema, Output>;
}

export function action<
  const InputSchema extends FlexibleSchema,
  Output = unknown
>(config: ActionConfig<InputSchema, Output>): Action<InputSchema, Output> {
  if (config.kind === "durable-pause" && config.approval === false) {
    throw new Error(
      `Action "${config.name ?? "(anonymous)"}": kind "durable-pause" with ` +
        `approval: false never parks for approval, defeating the purpose. ` +
        `Use kind "server" for an inline action, or omit approval (or set a ` +
        `predicate) to gate when it parks.`
    );
  }
  const descriptor: Action<InputSchema, Output> = {
    [ACTION_BRAND]: true,
    config: Object.freeze({ ...config })
  };
  return Object.freeze(descriptor);
}

export function isAction(value: unknown): value is Action {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [ACTION_BRAND]?: unknown })[ACTION_BRAND] === true
  );
}

type CompiledActionMetadata = {
  actionName: string;
  summary: string;
  permissions?: string[];
  risk?: "low" | "medium" | "high";
  kind: "approval-gated" | "durable-pause";
};

type NormalizedActionAuthorization = {
  allowed: boolean;
  reason?: string;
  grantedPermissions?: readonly string[];
};

type TurnTrigger =
  | "ws-chat"
  | "rpc"
  | "programmatic"
  | "submission"
  | "scheduled"
  | "agent-tool"
  | "auto-continuation"
  | "recovery-continue"
  | "recovery-retry";

type TurnAdmission = "queue" | "submit" | "execute-submission";

type AdmittedQueueResult<T> =
  | { status: "completed"; value: T }
  | { status: "stale" };

type QueueTurnSpec<T> = {
  admission: "queue";
  trigger: TurnTrigger;
  requestId: string;
  generation?: number;
  continuation?: boolean;
  allowNested?: boolean;
  channel?: string;
  onQueued?: () => void;
  getStatus?: () => string | undefined;
  execute: () => Promise<T>;
};

type NonQueueTurnSpec<T> = {
  admission: Exclude<TurnAdmission, "queue">;
  trigger: TurnTrigger;
  channel?: string;
  execute: () => Promise<T>;
};

type TurnSpec<T> = QueueTurnSpec<T> | NonQueueTurnSpec<T>;

const admittedTurnContext = new AsyncLocalStorage<{
  agent: unknown;
  requestId: string;
}>();

/** Options for {@link Think.addMessages}. */
export interface AddMessagesOptions {
  /**
   * Parent to attach the first message under. Omitted (`undefined`) attaches to
   * the latest committed leaf at call time; `null` attaches at the root. An
   * explicit id that does not exist throws (fail fast rather than silently
   * misattaching). Subsequent messages in an array chain under the previous one.
   */
  parentId?: string | null;
  /**
   * `"append"` (default) inserts new rows, idempotent by message id.
   * `"upsert"` inserts, or updates in place when the id already exists (in which
   * case `parentId` is ignored — re-parenting is not supported).
   *
   * Idempotency is by id against the whole session tree, not just the target
   * path: if a message id already exists *anywhere* in history, `"append"` is a
   * no-op for it (no new row, no re-parent) and `"upsert"` updates it in place
   * wherever it lives. In both modes the next message in the array chains under
   * that existing id, so passing already-present ids mid-array threads new
   * messages onto the existing branch rather than forking a new one.
   */
  mode?: "append" | "upsert";
  /**
   * Broadcast the change to connected clients. Default `true`. Has no effect
   * when called from inside an active turn (e.g. a tool `execute`), where the
   * live view is intentionally not touched until the next turn's sync.
   */
  broadcast?: boolean;
}

/** Options for {@link Think.deliverNotice}. */
export interface DeliverNoticeOptions {
  /**
   * Target channel id. Defaults to the active turn's channel, else `"web"`.
   */
  channel?: string;
  /**
   * Also record the notice in the model-visible transcript so the next turn
   * knows it was said. Default `false`. For the `web` channel the note is always
   * appended to the transcript (its only render path); `informModel` then only
   * controls the phrasing.
   */
  informModel?: boolean;
  /** Delivery kind for the wire tag. Default `"notice"`. */
  kind?: DeliveryKind;
  /**
   * Conversation/thread hint, required for out-of-turn delivery to a
   * multi-thread messenger channel.
   */
  thread?: string;
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

type ActionLedgerStatus = "pending" | "settled";

type ActionLedgerRow = {
  key: string;
  action_name: string;
  request_id: string | null;
  tool_call_id: string | null;
  input_hash: string;
  status: ActionLedgerStatus;
  result_json: string | null;
  created_at: number;
  updated_at: number;
};

type ActionLedgerClaim =
  | { outcome: "claimed" }
  | { outcome: "replay"; row: ActionLedgerRow }
  | { outcome: "pending"; row: ActionLedgerRow }
  | { outcome: "reclaimed"; row: ActionLedgerRow }
  | { outcome: "conflict"; row: ActionLedgerRow };

type ActionLedgerRetentionConfig = {
  settledMs: number | false;
  pendingMs: number | false;
  maxSweepRows: number;
};

type ActionLedgerSweepStatus = Extract<
  ActionLedgerStatus,
  "pending" | "settled"
>;

type ActionLedgerEvent =
  | {
      type: "action:ledger:replayed";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:pending";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:conflict";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:serialize_failed";
      payload: { action: string; key: string };
    }
  | {
      type: "action:ledger:settled";
      payload: { action: string; key: string; inputHash: string };
    }
  | {
      type: "action:ledger:reclaimed";
      payload: {
        action: string;
        key: string;
        inputHash: string;
        ageMs: number;
      };
    }
  | {
      type: "action:ledger:swept";
      payload: { settled: number; pending: number };
    };

type ChannelEvent =
  | {
      type: "channel:resolved";
      payload: { channel: string; kind: string; requestId?: string };
    }
  | {
      type: "channel:delivered";
      payload: { channel: string; kind: DeliveryKind; turnEnded: boolean };
    }
  | {
      type: "notice:delivered";
      payload: { channel: string; kind: DeliveryKind; informModel: boolean };
    }
  | {
      type: "notice:failed";
      payload: { channel: string; error: string };
    };

/**
 * A durably-parked `kind: "durable-pause"` action awaiting human approval. The
 * row is the compaction-safe record of everything needed to run `execute` on
 * approve (the transcript part can be summarized away before approval), so it
 * carries the action name, the model's input, and the approval descriptor.
 */
type ActionPendingRow = {
  execution_id: string;
  action_name: string;
  tool_call_id: string;
  request_id: string | null;
  input_json: string;
  descriptor_json: string | null;
  created_at: number;
};

type ActionPauseEvent =
  | {
      type: "action:pause:created";
      payload: { action: string; executionId: string; toolCallId: string };
    }
  | {
      type: "action:pause:approved";
      payload: { action: string; executionId: string };
    }
  | {
      type: "action:pause:rejected";
      payload: { action: string; executionId: string };
    }
  | {
      type: "action:pause:swept";
      payload: { swept: number };
    };

type ActionReplyEvent = {
  type: "action:reply-attached";
  payload: { action?: string; attachmentType: string };
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
  /** Channel id this submission belongs to. See {@link RunTurnBase.channel}. */
  channel?: string;
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

/**
 * Reserved name for the synthetic tool a workflow `step.prompt` turn uses to
 * deliver its structured final answer. The agent runs a full multi-step,
 * tool-using turn and ends it by calling this tool with arguments matching the
 * requested schema — exactly the way a sub-agent returns a result.
 *
 * Why a tool instead of the AI SDK `output`/`response_format` path: streaming a
 * JSON Schema `response_format` is rejected by some providers (Workers AI
 * returns `AiError 5023: JSON Schema mode is not supported with stream mode`),
 * whereas plain tool-calling streams on every provider. Capturing the tool
 * call's INPUT as the result keeps Think's single streaming engine intact
 * (persistence, recovery, resumable streams) and works uniformly across
 * Workers AI, OpenAI, and Anthropic.
 *
 * The name is namespaced to avoid clashing with user tools; if a user tool
 * already uses it, the turn picks a suffixed variant (see `_handleTurn`).
 */
const THINK_FINAL_ANSWER_TOOL_NAME = "think_final_answer";

/**
 * Whether `name` is (or is a collision-suffixed variant of) the reserved
 * structured-output final-answer tool. Used to strip the internal tool's parts
 * from persisted assistant messages regardless of which per-turn name was used.
 */
function isThinkFinalAnswerToolName(name: string): boolean {
  return (
    name === THINK_FINAL_ANSWER_TOOL_NAME ||
    name.startsWith(`${THINK_FINAL_ANSWER_TOOL_NAME}_`)
  );
}

/**
 * Build the system-prompt instruction that tells the model to terminate a
 * structured workflow turn by calling the given final-answer tool.
 */
function thinkFinalAnswerInstruction(toolName: string): string {
  return (
    "When you have everything you need to answer, you MUST call the " +
    `\`${toolName}\` tool exactly once with arguments that match the required ` +
    "schema. Do not write the final answer as plain text — the " +
    `\`${toolName}\` tool call IS the answer and ends the task.`
  );
}

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
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryExhaustedContext,
  ChatRecoveryProgressContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  ResolvedChatRecoveryConfig,
  SaveMessagesOptions,
  SaveMessagesResult
} from "agents/chat";
import type {
  ChatResponseResult,
  ChatRecoveryConfig,
  ChatRecoveryContext,
  ChatRecoveryOptions,
  MessageConcurrency,
  ResolvedChatRecoveryConfig,
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
  /**
   * Executor that resolves client-tool calls inline (RPC `chat()` path). When
   * present, `clientTools` are built WITH an `execute` that delegates to it, so
   * the turn completes the tool round trip itself instead of surfacing a
   * dangling tool call. Not persisted — recovery cannot replay a live executor.
   */
  clientToolExecutor?: ClientToolExecutor;
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
  /**
   * Override the stream-stall inactivity watchdog timeout for THIS turn only
   * (ms; `0` disables it for this turn). Defaults to the instance-level
   * `chatStreamStallTimeoutMs`. Because the watchdog measures the gap between
   * UI-message-stream chunks — which includes server-side tool execution — a
   * turn known to invoke a slow tool can raise (or disable) the timeout for
   * just that turn instead of permanently widening the global window. Auto-
   * resets after the turn.
   */
  chatStreamStallTimeoutMs?: number;
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
   * Optional AI SDK stream transform(s) for this turn (`experimental_transform`).
   * Forwarded to `streamText` so callers can inspect/rewrite the stream — e.g.
   * detecting tool results that carry `{ content, sources }` and enqueuing
   * additional `source` parts via the transform's controller. Accepts a single
   * transform or an array applied in order.
   */
  experimental_transform?: Parameters<
    typeof streamText
  >[0]["experimental_transform"];
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
 * Provider-agnostic semantic classification of a chat-turn error.
 *
 * Think ships **no** provider-specific string/code matching — the app owns
 * that knowledge (it knows which provider/model it talks to), exactly like the
 * `tokenCounter` it already passes to `compactAfter()`. An app teaches Think
 * what an error *means* by overriding `classifyChatError()`; Think then reacts
 * generically (e.g. compact-and-retry on `context_overflow`).
 *
 * - `context_overflow` — the prompt exceeded the model's context window
 *   (Anthropic `"prompt is too long"`, OpenAI `context_length_exceeded`, …).
 *   The only category Think currently acts on (auto-compact + retry).
 * - `rate_limit` / `transient` — reserved for future backoff/retry policies.
 * - `fatal` — unrecoverable; surface terminally.
 * - `unknown` — default; Think applies its existing terminal behavior.
 */
export type ChatErrorClassification =
  | "context_overflow"
  | "rate_limit"
  | "transient"
  | "fatal"
  | "unknown";

/**
 * Opt-in handling for a turn that overflows the model's context window
 * mid-flight. Compaction (`compactAfter()`) is only checked between turns, so a
 * long, tool-heavy turn can grow past the window before the next check; the
 * provider then rejects the request (`"prompt is too long"` /
 * `context_length_exceeded`). Both layers reuse the session's compaction
 * function and are provider-agnostic — the app maps the error via
 * {@link Think.classifyChatError}; Think never matches provider strings itself.
 *
 * Set `Think.contextOverflow` to enable. Leaving it unset disables both layers
 * (existing terminal behavior).
 */
export interface ContextOverflowConfig {
  /**
   * Reactive backstop. When a turn fails with an error classified as
   * `"context_overflow"`, discard the truncated partial, run
   * `session.compact()`, and re-run the turn from the compacted history. The
   * partial is intentionally not persisted: the turn restarts from scratch, so
   * keeping the cut-off assistant message would orphan it beside the recovered
   * answer (and duplicate any tool work the retry re-issues). If compaction
   * cannot shorten history or the retry budget is spent, the overflow surfaces
   * terminally through `onChatError` (classified) — it never loops or ends
   * silently. Default `false`.
   */
  reactive?: boolean;

  /**
   * Maximum compact-and-retry attempts for a single overflowing turn (the
   * reactive backstop). Independent of the proactive guard's cap — see
   * {@link proactive.maxCompactions}. Default `1`.
   */
  maxRetries?: number;

  /**
   * Proactive guard. Before each step, read the previous step's model-reported
   * `usage.inputTokens` and, if it crosses `maxInputTokens * (headroom ?? 0.9)`,
   * compact in place and feed the recompacted history into the upcoming step —
   * heading off the provider rejection before it happens. Keys off usage (every
   * provider reports it), not provider error strings. Unset disables it.
   *
   * If a provider omits `inputTokens`, the guard falls back to `usage.totalTokens`
   * (input + output) — a safe over-approximation that compacts slightly early
   * rather than missing the threshold. If neither is reported, the guard does
   * nothing that step (the reactive backstop still catches a genuine overflow).
   *
   * `maxCompactions` caps how many times the guard may compact within a single
   * step loop (default `1`, floored at `1`). It is independent of
   * {@link maxRetries} (the reactive budget): a no-op compaction would repeat on
   * every step, so the cap stops the guard from compacting (and emitting
   * `chat:context:compacted`) on each one.
   */
  proactive?: {
    maxInputTokens: number;
    headroom?: number;
    maxCompactions?: number;
  };
}

/**
 * Matches the context-window-overflow error messages of the common providers.
 * Anthropic (`prompt is too long`), OpenAI (`context_length_exceeded`,
 * `maximum context length`, `reduce the length of …`), Google Gemini (`exceeds
 * the maximum number of tokens`, `input token count`), Bedrock / Mistral /
 * others (`input is too long`, `too many tokens`, `context window`).
 *
 * This default deliberately favors recall over precision: a missed overflow
 * means no recovery (the feature's whole point), whereas a false positive
 * self-heals — the retry hits the same non-overflow error, the budget is spent,
 * and it surfaces terminally anyway. The vaguest fragment (`reduce the length`)
 * is anchored to `of` to match the real OpenAI phrasing without matching
 * unrelated prose. Apps that need stricter matching can wrap this classifier.
 */
const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|exceeds the maximum number of tokens|input token count|reduce the length of|input is too long|too many (?:input )?tokens|context window/i;

/**
 * Opt-in default classifier for {@link Think.classifyChatError}. Matches the
 * context-window-overflow error messages of the common providers (Anthropic,
 * OpenAI, Google, Bedrock, Mistral, …) and returns `"context_overflow"`.
 *
 * Think ships this as an explicitly-imported helper rather than wiring it into
 * core, so the framework default stays free of provider strings. Assign it (or
 * delegate to it) when you do not need custom classification:
 *
 * @example
 * ```typescript
 * import { Think, defaultContextOverflowClassifier } from "@cloudflare/think";
 *
 * export class MyAgent extends Think<Env> {
 *   override contextOverflow = { reactive: true };
 *   override classifyChatError = defaultContextOverflowClassifier;
 * }
 * ```
 *
 * Or combine with your own checks:
 *
 * @example
 * ```typescript
 * override classifyChatError(error: unknown): ChatErrorClassification | void {
 *   if (isMyRateLimit(error)) return "rate_limit";
 *   return defaultContextOverflowClassifier(error);
 * }
 * ```
 */
export function defaultContextOverflowClassifier(
  error: unknown
): ChatErrorClassification | undefined {
  let text: string;
  if (error instanceof Error) {
    text = error.message;
  } else if (typeof error === "string") {
    text = error;
  } else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
  }
  return CONTEXT_OVERFLOW_PATTERN.test(text) ? "context_overflow" : undefined;
}

export interface ChatErrorContext {
  requestId?: string;
  stage: "parse" | "persist" | "turn" | "stream" | "recovery" | "transcript";
  messagesPersisted?: boolean;
  /**
   * App-provided semantic classification (from `classifyChatError`), when
   * known. Lets `onChatError` overrides and observers distinguish e.g. a
   * context-overflow from a generic provider failure without re-matching
   * provider strings.
   */
  classification?: ChatErrorClassification;
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
  // Root requestId of the in-flight recovery chain, threaded into each
  // continuation's snapshot so chained continuations keep owning the original
  // submission. This is a single instance field, NOT per-incident: it is only
  // safe because turns (and recovery fibers) are serialized by the turn queue,
  // so at most one recovery chain is active at a time. The `try/finally`
  // restore in `_chatRecoveryRetry` / `_chatRecoveryContinue` returns it to the
  // prior value once a continuation settles. If turns ever run concurrently,
  // this must move to per-incident storage.
  private _activeChatRecoveryRootRequestId: string | undefined;

  private static readonly CONFIG_KEYS = [
    "_think_config",
    "lastClientTools",
    "lastBody",
    "skillsFingerprint"
  ] as const;
  /**
   * Wait for MCP server connections to be ready before the inference
   * loop. MCP tools are auto-merged into the tool set.
   *
   * Set to `true` for a default 10s timeout, or `{ timeout: ms }`
   * for a custom timeout. Defaults to `false` (no waiting).
   */
  waitForMcpConnections: boolean | { timeout: number } = false;

  private _skillRegistry: SkillRegistry | null = null;
  private _loggedSkillWarnings = new Set<string>();
  private _loggedProtocolWarnings = new Set<string>();

  /**
   * Controls how overlapping user submit requests behave while another
   * chat turn is already active or queued.
   *
   * @default "queue"
   */
  messageConcurrency: MessageConcurrency = "queue";

  /**
   * Byte budget for hydrating the persisted transcript into the in-memory
   * message cache (`this.messages`).
   *
   * Hydration runs on every wake (and at safe boundaries during a session).
   * Without a budget it materializes the ENTIRE stored conversation — for
   * long-lived, media-heavy sessions that footprint approaches the isolate's
   * 128MB memory budget and the next SQLite allocation fails with
   * `SQLITE_NOMEM`, permanently bricking the DO (#1710).
   *
   * When the stored path exceeds the budget, only the most recent messages
   * that fit are hydrated — never fewer than the recent window the model
   * sees at full fidelity (the `truncateOlderMessages` default of 4), even
   * when those messages alone exceed the budget — a
   * `chat:hydration:windowed` observability event is emitted, and
   * `this.messages` exposes the bounded window. Durable storage is never
   * truncated by this — `session.getHistory()` still reads the full path.
   * The model-facing context is unaffected: older content is already
   * truncated at read time before each turn, and the hydration floor
   * guarantees the full-fidelity span is always present.
   *
   * The default (24MB) leaves headroom for the ~2-3x amplification between
   * stored JSON and parsed in-memory messages. Set to
   * `Number.POSITIVE_INFINITY` (or any non-positive value) to disable
   * windowing and always hydrate the full transcript.
   *
   * @default 24 * 1024 * 1024
   */
  hydrationByteBudget: number = 24 * 1024 * 1024;

  /**
   * Bound the PERSISTED transcript footprint by evicting oversized inline
   * media (base64 data-URL attachments, large strings inside tool outputs)
   * from messages that have aged out of the recent window.
   *
   * Read-time truncation already hides aged media from the model, but the
   * bytes stay in storage forever and are rehydrated on every wake — the
   * boot footprint grows with every image a session ever produced until
   * SQLite's allocator fails with `SQLITE_NOMEM` (#1710). Eviction passes
   * run in the background after the agent starts and as the conversation
   * grows; each pass processes a bounded number of oversized rows.
   *
   * By default evicted values are preserved as workspace files under
   * `/attachments/evicted/` (same Durable Object storage, but outside the
   * hydration path) and the in-message marker records the file path.
   * Pass a {@link MediaEvictionConfig} with `externalizeToWorkspace: false`
   * to drop the bytes instead of preserving them. Set this field to
   * `false` to disable eviction entirely.
   *
   * `keepRecentMessages` is clamped to at least the recent window the model
   * replays at full fidelity (4 messages), so eviction can never rewrite
   * content the model still sees.
   *
   * Requires a SessionProvider that implements `getHistoryRowStats`
   * (the default DO SQLite provider does); otherwise eviction is a no-op
   * and a warning is logged once.
   *
   * @default true
   */
  mediaEviction: MediaEvictionConfig | boolean = true;

  /**
   * When true, chat turns are wrapped in `runFiber` for durable execution.
   * Enables `onChatRecovery` hook and `this.stash()` during streaming.
   *
   * Assign this as a class field or in the constructor — NOT in `onStart()`.
   * On every wake the SDK evaluates recovery budgets (and may seal an
   * interrupted turn, firing `onExhausted`) before `onStart()` runs, so a config
   * set in `onStart()` is applied too late and the built-in defaults are used
   * for the recovery that matters. See {@link ChatRecoveryConfig}.
   */
  chatRecovery: ChatRecoveryConfig = true;

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

  /**
   * Internal onStart steps that failed on this wake and were skipped so the
   * agent could still come up.
   *
   * onStart failures are terminal: partyserver resets its init state and
   * rethrows, so every subsequent wake — including platform alarm retries —
   * re-runs the failing onStart. A data-driven failure (e.g. SQLITE_NOMEM
   * hydrating an oversized transcript) would otherwise permanently brick the
   * DO and drive an unbounded alarm-retry loop (#1710).
   */
  protected _onStartDegradations: OnStartDegradation[] = [];

  /**
   * Internal onStart steps that failed on this wake and were skipped so the
   * agent could still come up (see {@link OnStartDegradation}). Empty when
   * boot was clean. Lets hosts and operators surface degraded boots —
   * e.g. via a health RPC — without subclassing.
   */
  getOnStartDegradations(): ReadonlyArray<OnStartDegradation> {
    return [...this._onStartDegradations];
  }

  private _activeMessengerContext?: MessengerContext;

  /**
   * Turn-scoped channel context (superset of `_activeMessengerContext`). Set on
   * both the queue and submit admission paths via `_withChannelContext`, read by
   * `deliverNotice` and per-channel policy. Save/restore keeps nested turns safe.
   */
  private _activeChannelContext?: ChannelContext;

  /**
   * Live delivery surface for the active turn, bound by `deliverMessengerReply`
   * so `deliverNotice` can post to the originating channel mid-turn. Save/restore
   * keeps nested turns safe.
   */
  private _activeDeliverySurface?: MessengerDeliverySurface;

  private _messengerRuntime?: ThinkMessengerRuntime;

  /** Resolved channel registry (implicit web + configureChannels + messengers). */
  private _channels?: Map<string, NormalizedChannelDefinition>;

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

  /**
   * The codemode runtime behind the execute tool, when one has been created
   * via `createExecuteRuntime(this)` / `createExecuteTool(this)` (from
   * `@cloudflare/think/tools/execute`). Gives callables and lifecycle hooks
   * access to approvals (`approve`/`reject`/`pending`), the audit trail
   * (`executions`), `expirePaused`, and snippets.
   */
  codemode?: import("@cloudflare/codemode").CodemodeRuntimeHandle;

  /**
   * Include the default workspace Bash tool. Enabled by default so models can
   * run shell-style multi-file workflows against the workspace. Set to `false`
   * to omit it from the built-in workspace tools.
   */
  workspaceBash:
    | boolean
    | NonNullable<Parameters<typeof createWorkspaceTools>[1]>["bash"] = true;

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
            // The conversation grew — older messages may have aged out of
            // the keep-recent window. Only schedule the maintenance scan once
            // this session has actually observed oversized media; otherwise a
            // normal text-only chat would pay a row-stat read after every turn.
            this._scheduleMediaEvictionAfterAppend(event.message as UIMessage);
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

      await this._initializeSkills();

      // Force Session to initialize its tables (assistant_messages,
      // assistant_compactions, assistant_config, etc.) so that subsequent
      // config reads work.
      //
      // Hydration is bounded by `hydrationByteBudget` (a byte-budgeted
      // recent window on oversized transcripts), but even the budgeted read
      // can fail — and that failure must not escape onStart, or the DO is
      // bricked (#1710). Degrade to an empty in-memory view; persisted
      // history is untouched and the next safe-boundary `_syncMessages()`
      // retries.
      this._onStartDegradations = [];
      const hydrated = await this._runBestEffortOnStartStep(
        "transcript-hydration",
        () => this._syncMessages(),
        "The agent is starting with an empty in-memory message view; " +
          "persisted history is untouched. If the error is SQLITE_NOMEM, " +
          "the stored transcript is too large to hydrate (often inline " +
          "base64 media in tool results) — compact or clear the session " +
          "to recover."
      );
      if (!hydrated) {
        this._replaceCachedMessages([]);
      }
      this._refreshMediaEvictionSignalFromCache();

      // 3-6. Extension initialization (if extensionLoader is set)
      if (this.extensionLoader) {
        await this._initializeExtensions();
      }

      // 7. Protocol handlers
      this._resumableStream = new ResumableStream(this.sql.bind(this));
      this._restoreClientTools();
      this._restoreBody();
      this._setupProtocolHandlers();
      await this._initializeChannels();

      // 8. User's onStart
      await _onStart();

      // 9. Declarative scheduled tasks are code-defined and should reconcile
      // before draining any recovered programmatic work they may enqueue.
      // Best-effort: reconcile runs after the agent is otherwise functional,
      // and a failure (user getScheduledTasks() throwing, storage pressure)
      // must not brick the DO (#1710).
      await this._runBestEffortOnStartStep(
        "scheduled-task-reconcile",
        () => this._reconcileDeclaredScheduledTasks(),
        "Declared scheduled tasks were not reconciled on this wake; the " +
          "next successful wake will reconcile them."
      );

      // 10. Durable submissions may run user-defined model/hooks, so start them
      // after subclass initialization has completed. Best-effort for the same
      // reason as step 9.
      await this._runBestEffortOnStartStep(
        "durable-work-recovery",
        async () => {
          await this._sweepActionLedger();
          await this._sweepActionPendingApprovals();
          await this._recoverSubmissionsOnStart();
          this._recoverWorkflowNotifications();
          if (this._hasPendingSubmissions()) {
            this._startSubmissionDrain();
          }
          if (this._hasPendingWorkflowNotifications()) {
            this._startWorkflowNotificationDrain();
          }
        },
        "Pending submissions / workflow notifications were not recovered on " +
          "this wake; the next successful wake will recover them."
      );

      // 11. Background bound on the persisted transcript: if hydration was
      // windowed, evict aged inline media so the footprint can converge down
      // (#1710). Runs after `blockConcurrencyWhile` releases — no boot cost.
      if (this._lastHydration?.truncated) {
        this._scheduleMediaEvictionPass({ force: true });
      }
    };
  }

  /**
   * Conversation history as Think's live in-memory view.
   *
   * Storage remains the durable source of truth, but runtime logic should read
   * through this cache so in-flight turns, tool updates, and recovery state all
   * observe the same message list. Use `_syncMessages()` only at safe
   * boundaries where a full storage reread cannot drop in-flight state.
   *
   * When the stored transcript exceeds `hydrationByteBudget`, this view is a
   * bounded window of the most recent messages (see `_lastHydration`); the
   * full history remains readable via `session.getHistory()`.
   */
  get messages(): UIMessage[] {
    return this._cachedMessages;
  }

  /**
   * Read the durable message path from session storage.
   *
   * Intentionally UNBUDGETED — unlike the cache refresh in `_syncMessages`,
   * which routes through `session.getRecentHistory(hydrationByteBudget)`, this
   * returns the full active path. Callers (message reconciliation, tool-update
   * application) must see every message: reconciliation diffs incoming client
   * messages against the complete server transcript, and a tool result can
   * target any message on the path, so a windowed read would drop rows and
   * corrupt the result.
   *
   * These full reads are not the unbounded boot-time hydration that bricked the
   * DO in #1710: they run during a live turn (never in `onStart`), so an
   * `SQLITE_NOMEM` here surfaces as a recoverable turn-level error rather than a
   * partyserver init-reset/alarm-retry loop. They also inherit step 1's
   * mitigation — `session.getHistory()` now fetches content in bounded chunks
   * (`messagesByPathIds`) instead of carrying blobs through the recursive CTE
   * and its `ORDER BY` sorter — and background media eviction shrinks the stored
   * footprint over time, so the steady-state read size converges down.
   */
  private async _readMessagesFromStorage(): Promise<UIMessage[]> {
    return (await this.session.getHistory()) as UIMessage[];
  }

  /**
   * Whether a tool part already has a settled result the provider accepts, so
   * it must NOT be re-repaired into an errored result. Delegates to the shared
   * `agents/chat` primitive so the repair pass and the backstop detector
   * (`_incompleteToolCallIds`) share the single source of truth for terminal
   * tool states.
   */
  private _toolPartHasSettledResult(record: Record<string, unknown>): boolean {
    return toolPartHasSettledResult(record);
  }

  /**
   * Tool-call ids that still have no recorded result. After repair this should
   * be empty; a non-empty result means the backstop (`ignoreIncompleteToolCalls`)
   * will drop those calls — i.e. repair missed a shape and should be extended.
   *
   * `approval-responded` is deliberately excluded: an approved server tool has
   * no result *yet*, but it is not incomplete or abandoned — it is waiting for
   * its continuation to run `execute()`. `convertToModelMessages` keeps that
   * call (and the SDK executes it), so flagging it here would log a misleading
   * "repair gap" warning and emit a spurious `chat:transcript:repaired` event
   * on every approval continuation.
   */
  private _incompleteToolCallIds(messages: UIMessage[]): string[] {
    const ids: string[] = [];
    for (const message of messages) {
      for (const part of message.parts) {
        const record = part as Record<string, unknown>;
        const toolCallId =
          typeof record.toolCallId === "string" ? record.toolCallId : undefined;
        const isToolPart =
          typeof record.type === "string" &&
          (record.type.startsWith("tool-") || record.type === "dynamic-tool") &&
          toolCallId;
        if (!isToolPart) continue;
        if (record.state === "approval-responded") continue;
        if (!this._toolPartHasSettledResult(record)) ids.push(toolCallId);
      }
    }
    return ids;
  }

  /**
   * Repair a single interrupted tool call — a tool part with no settled result,
   * left behind when a stream was cut off mid-flight. Returns the replacement
   * part that takes its place in the transcript. `input` has already been
   * normalized to a valid object.
   *
   * The default flips it to an errored tool result so the record survives (no
   * "disappearing" tool call) and `convertToModelMessages` still gets a
   * tool-result for it (avoiding `AI_MissingToolResultsError`).
   *
   * Override to customize the repaired shape for client-resolved tools — e.g.
   * convert an interrupted `ask_user` (a question with no server `execute`,
   * normally answered by the user's next message) into a plain text part
   * carrying the question prose, so the model sees it as ordinary conversation
   * rather than a tool error and compaction keeps the question verbatim. This
   * runs DURING transcript repair — before the repaired transcript is persisted
   * and sent to the model — so the conversion shapes the current turn, not just
   * the next one. A returned tool part MUST carry a settled result
   * (`output-available` / `output-error` / `output-denied` or an
   * `output`/`result` field); returning a non-tool part (e.g. text) is fine.
   */
  protected repairInterruptedToolPart(
    part: UIMessage["parts"][number]
  ): UIMessage["parts"][number] {
    return {
      ...part,
      state: "output-error",
      errorText: "The tool call was interrupted before a result was recorded."
    } as UIMessage["parts"][number];
  }

  private _repairToolTranscriptParts(messages: UIMessage[]): {
    messages: UIMessage[];
    removedToolCalls: number;
    normalizedInputs: number;
    toolCallIds: string[];
  } {
    // Delegates to the shared `agents/chat` primitive so Think and ai-chat run
    // identical repair logic. The overridable `repairInterruptedToolPart` hook
    // (default: flip to an errored result; subclasses can preserve a
    // client-resolved tool such as `ask_user` as text) is threaded through, and
    // the settled-result / input-normalization helpers are the shared defaults.
    return repairInterruptedToolParts(messages, {
      repairPart: (part) => this.repairInterruptedToolPart(part),
      isSettled: (record) => this._toolPartHasSettledResult(record),
      normalizeInput: (input) => normalizeToolInput(input)
    });
  }

  private async _repairTranscriptForProvider(
    messages: UIMessage[]
  ): Promise<UIMessage[]> {
    const repair = this._repairToolTranscriptParts(messages);
    if (repair.removedToolCalls === 0 && repair.normalizedInputs === 0) {
      return messages;
    }

    // Repair preserves every message (orphans are flipped to errored in place,
    // never deleted), so there are no removed rows to delete — only updates.
    for (const message of repair.messages) {
      const original = messages.find(
        (candidate) => candidate.id === message.id
      );
      if (original && original.parts !== message.parts) {
        await this.session.updateMessage(sanitizeMessage(message));
      }
    }

    this._replaceCachedMessages(repair.messages);
    this._broadcastMessages();
    this._emit("chat:transcript:repaired", {
      removedToolCalls: repair.removedToolCalls,
      normalizedInputs: repair.normalizedInputs,
      toolCallIds: repair.toolCallIds
    });
    return repair.messages;
  }

  /**
   * Run a best-effort internal onStart step, degrading on failure instead of
   * throwing.
   *
   * Throwing out of `onStart` is terminal: partyserver resets its init state
   * and rethrows, so every wake — including platform alarm retries — re-runs
   * the failing `onStart` and fails again. A data-driven failure (oversized
   * transcript, bad declared-task config) would permanently brick the DO and
   * drive an unbounded alarm-retry loop (#1710). Instead, record the
   * degradation, emit `chat:onstart:degraded`, and let the agent come up so
   * it stays reachable for remediation (compaction, clearing, redeploy).
   *
   * Returns `true` when the step succeeded.
   */
  private async _runBestEffortOnStartStep(
    step: OnStartDegradation["step"],
    fn: () => unknown | Promise<unknown>,
    hint: string
  ): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (error) {
      this._onStartDegradations.push({ step, error });
      console.error(
        `[Think] onStart step "${step}" failed; continuing with degraded state. ${hint}`,
        error
      );
      this._emit("chat:onstart:degraded", {
        step,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private _mediaEvictionRunning = false;
  private _mediaEvictionScheduled = false;
  private _mediaEvictionObservedOversized = false;

  /**
   * Schedule a background media-eviction pass (see `mediaEviction`).
   * Coalesces repeated requests; the timer fires after the current
   * event-loop work (and after `onStart`'s `blockConcurrencyWhile`), so
   * boot and turn latency are unaffected.
   */
  private _scheduleMediaEvictionPass(options?: { force?: boolean }): void {
    if (this._mediaEvictionScheduled || this._mediaEvictionRunning) return;
    const config = resolveMediaEvictionConfig(this.mediaEviction);
    if (!config) return;
    if (!options?.force && !this._mediaEvictionObservedOversized) return;
    this._mediaEvictionScheduled = true;
    setTimeout(() => {
      this._mediaEvictionScheduled = false;
      void this._evictAgedMediaBestEffort();
    }, 0);
  }

  private _scheduleMediaEvictionAfterAppend(message: UIMessage): void {
    const config = resolveMediaEvictionConfig(this.mediaEviction);
    if (!config) return;
    if (!this._mediaEvictionObservedOversized) {
      this._mediaEvictionObservedOversized = this._messageMayNeedMediaEviction(
        message,
        config
      );
    }
    if (!this._mediaEvictionObservedOversized) return;

    const keepRecent = Math.max(config.keepRecentMessages, MODEL_RECENT_WINDOW);
    if (this._cachedMessages.length > keepRecent) {
      this._scheduleMediaEvictionPass({ force: true });
    }
  }

  private _refreshMediaEvictionSignalFromCache(): void {
    const config = resolveMediaEvictionConfig(this.mediaEviction);
    if (!config) {
      this._mediaEvictionObservedOversized = false;
      return;
    }
    this._mediaEvictionObservedOversized = this._cachedMessages.some(
      (message) => this._messageMayNeedMediaEviction(message, config)
    );
  }

  private _messageMayNeedMediaEviction(
    message: UIMessage,
    config: ResolvedMediaEvictionConfig
  ): boolean {
    return JSON.stringify(message).length >= config.minPartBytes;
  }

  private _warnedEvictionUnsupported = false;

  /**
   * Evict oversized inline media from aged stored messages (#1710).
   *
   * Memory-bounded by design: row sizes come from `getHistoryRowStats()`
   * (no content loaded), only rows large enough to contain an evictable
   * part are parsed, and they are processed one at a time via
   * `session.internal_rewriteMessage` — the maintenance write path that
   * skips the full-history token-estimate broadcast a public
   * `updateMessage` performs per row. Evicted values are written to the
   * workspace BEFORE the row is rewritten, so a failed pass never loses
   * data. Best-effort: failures are logged and the next pass retries.
   *
   * The aged cutoff is `keepRecentMessages` clamped to at least
   * `MODEL_RECENT_WINDOW`: messages the model still replays at full
   * fidelity each turn are never rewritten, regardless of configuration.
   *
   * When a pass stops at `maxRowsPerPass` with eligible rows remaining,
   * another pass is scheduled automatically so a large backlog drains
   * without waiting for new appends. Termination is guaranteed: every
   * rewritten row drops below `minPartBytes` and is skipped by later
   * passes, so the eligible set strictly shrinks.
   *
   * Returns the pass totals, or `null` when eviction is disabled, already
   * running, or the provider cannot enumerate row sizes (warned once).
   */
  protected async _evictAgedMediaBestEffort(): Promise<{
    messages: number;
    parts: number;
    bytes: number;
    externalizedBytes: number;
  } | null> {
    if (this._mediaEvictionRunning) return null;
    const config = resolveMediaEvictionConfig(this.mediaEviction);
    if (!config) return null;
    this._mediaEvictionRunning = true;
    let backlogRemains = false;
    try {
      const stats = await this.session.getHistoryRowStats();
      if (!stats) {
        if (!this._warnedEvictionUnsupported) {
          this._warnedEvictionUnsupported = true;
          console.warn(
            "[Think] mediaEviction is enabled but the configured " +
              "SessionProvider does not implement getHistoryRowStats; " +
              "media eviction is a no-op for this agent."
          );
        }
        return null;
      }
      const keepRecent = Math.max(
        config.keepRecentMessages,
        MODEL_RECENT_WINDOW
      );
      const aged = stats.slice(0, Math.max(0, stats.length - keepRecent));

      let processed = 0;
      const totals = { messages: 0, parts: 0, bytes: 0, externalizedBytes: 0 };
      for (const row of aged) {
        // A row smaller than the part threshold cannot contain an
        // evictable value — skip without parsing. Rewritten rows shrink
        // below the threshold, so later passes skip them here too.
        if (row.bytes < config.minPartBytes) continue;
        if (processed >= config.maxRowsPerPass) {
          backlogRemains = true;
          break;
        }
        processed++;

        const message = (await this.session.getMessage(
          row.id
        )) as UIMessage | null;
        if (!message) continue;

        const result = evictLargeMediaFromMessage(message, {
          minPartBytes: config.minPartBytes,
          externalize: config.externalizeToWorkspace,
          pathFor: (index, extension) =>
            `/attachments/evicted/${message.id}-${index}.${extension}`
        });
        if (!result.changed) continue;

        for (const blob of result.blobs) {
          await this.workspace.writeFile(blob.path, blob.data);
          totals.externalizedBytes += blob.data.length;
        }
        await this.session.internal_rewriteMessage(
          sanitizeMessage(result.message)
        );
        totals.messages++;
        totals.parts += result.parts;
        totals.bytes += result.bytes;
      }

      if (totals.messages > 0) {
        this._emit("chat:media:evicted", totals);
      }
      return totals;
    } catch (error) {
      console.error(
        "[Think] media eviction pass failed; a later pass will retry.",
        error
      );
      return null;
    } finally {
      this._mediaEvictionRunning = false;
      if (backlogRemains) this._scheduleMediaEvictionPass({ force: true });
    }
  }

  /** Replace the live cache with a durable storage snapshot. */
  private _replaceCachedMessages(messages: UIMessage[]): UIMessage[] {
    this._cachedMessages = messages;
    return this._cachedMessages;
  }

  /**
   * Result of the most recent cache refresh when `hydrationByteBudget` is
   * active. `truncated` means `this.messages` is a bounded recent window of
   * a larger stored transcript.
   */
  protected _lastHydration: {
    truncated: boolean;
    totalContentBytes: number;
    hydratedMessages: number;
  } | null = null;

  private _warnedHydrationWindowed = false;

  /**
   * Snapshot of the last `chat:hydration:windowed` emit, used to emit on
   * CHANGE rather than on every safe-boundary sync — a chronically
   * oversized session syncs many times per turn and would otherwise spam
   * identical events.
   */
  private _lastWindowedEmit: {
    totalContentBytes: number;
    hydratedMessages: number;
  } | null = null;

  /**
   * Refresh the live cache from durable storage at a safe boundary.
   *
   * Bounded by `hydrationByteBudget`: oversized transcripts hydrate as a
   * recent window instead of exhausting the isolate's memory (#1710). The
   * window never shrinks below `MODEL_RECENT_WINDOW` messages, so budgeted
   * hydration cannot starve the model-facing context assembly (which keeps
   * that many recent messages at full fidelity).
   */
  private async _syncMessages(): Promise<UIMessage[]> {
    const budget = this.hydrationByteBudget;
    if (!Number.isFinite(budget) || budget <= 0) {
      this._lastHydration = null;
      this._lastWindowedEmit = null;
      return this._replaceCachedMessages(await this._readMessagesFromStorage());
    }

    const recent = await this.session.getRecentHistory(
      budget,
      MODEL_RECENT_WINDOW
    );
    this._lastHydration = {
      truncated: recent.truncated,
      totalContentBytes: recent.totalContentBytes,
      hydratedMessages: recent.messages.length
    };
    if (recent.truncated) {
      if (!this._warnedHydrationWindowed) {
        this._warnedHydrationWindowed = true;
        console.warn(
          `[Think] Stored transcript (${recent.totalContentBytes} bytes) ` +
            `exceeds hydrationByteBudget (${budget} bytes); hydrated the ` +
            `most recent ${recent.messages.length} message(s) instead of ` +
            "the full history. Durable storage is untouched. Compact the " +
            "session (or enable media eviction) to shrink it."
        );
      }
      const changed =
        this._lastWindowedEmit === null ||
        this._lastWindowedEmit.totalContentBytes !== recent.totalContentBytes ||
        this._lastWindowedEmit.hydratedMessages !== recent.messages.length;
      if (changed) {
        this._lastWindowedEmit = {
          totalContentBytes: recent.totalContentBytes,
          hydratedMessages: recent.messages.length
        };
        this._emit("chat:hydration:windowed", {
          totalContentBytes: recent.totalContentBytes,
          budgetBytes: budget,
          hydratedMessages: recent.messages.length
        });
      }
    } else {
      this._lastWindowedEmit = null;
    }
    return this._replaceCachedMessages(recent.messages as UIMessage[]);
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

  /** Sanitize + row-size-compact a message before it touches storage. */
  private _rowSafe(message: UIMessage): UIMessage {
    return enforceRowSizeLimit(sanitizeMessage(message), {
      warn: (m) => console.warn(`[Think] ${m}`)
    });
  }

  private async _appendMessageToHistory(
    message: UIMessage,
    parentId?: string | null
  ): Promise<UIMessage> {
    const safe = this._rowSafe(message);
    await this.session.appendMessage(safe, parentId);
    return safe;
  }

  private async _updateMessageInHistory(
    message: UIMessage
  ): Promise<UIMessage> {
    const safe = this._rowSafe(message);
    await this.session.updateMessage(safe);
    return safe;
  }

  private async _upsertMessageInHistory(
    message: UIMessage,
    parentId?: string | null
  ): Promise<UIMessage> {
    const safe = this._rowSafe(message);
    const existing = await this.session.getMessage(safe.id);
    if (existing) {
      await this.session.updateMessage(safe);
    } else {
      await this.session.appendMessage(safe, parentId);
    }
    return safe;
  }

  /**
   * The orphan-persist store adapter — orphan-persist steps **(c)/(d)** route
   * their write through this shared `OrphanPersistStore` seam (the
   * `SessionProvider` write-subset). Delegates to `this.session` with `_rowSafe`
   * applied at the write boundary (sanitize + row-size cap), exactly as Think's
   * other Session call sites do. The `SessionMessage → UIMessage` read cast is
   * confined here, matching those call sites.
   * @internal
   */
  protected _orphanStore(): OrphanPersistStore {
    return {
      getMessage: async (id) =>
        (await this.session.getMessage(id)) as UIMessage | null,
      appendMessage: (message, parentId) =>
        this.session.appendMessage(this._rowSafe(message), parentId),
      updateMessage: (message) =>
        this.session.updateMessage(this._rowSafe(message))
    };
  }

  private async _clearHistory(): Promise<void> {
    await this.session.clearMessages();
    // Drop any pending terminal record (#1645) so a stale exhaustion can't
    // replay onto a freshly-cleared (empty) conversation on reconnect. Covers
    // both the WS `chat-clear` path and the programmatic `clearMessages()` API.
    await this._clearChatTerminal();
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
  /** Lazily-built shared resume-handshake driver (Tier-2). */
  private _resumeHandshakeInstance: ResumeHandshake | null = null;
  private _lastClientTools: ClientToolSchema[] | undefined;
  private _lastBody: Record<string, unknown> | undefined;
  private _continuation = new ContinuationState<Connection>();
  /**
   * Accepted-but-not-yet-streamed turns and the connections parked waiting for
   * one (#1784). See {@link ResumeHandshake} `preStream`.
   *
   * HIBERNATION INVARIANT: in-memory only, NOT persisted. Safe because the
   * pre-stream window cannot overlap hibernation — a turn between `begin()` and
   * stream start is an unresolved `onMessage` handler promise that pins the DO,
   * so eviction only happens once a durable stream exists (resumed via
   * `ResumableStream`) or the turn finished. Breaks if a pre-stream wait is ever
   * moved onto a durable alarm that releases the DO; if so, persist this state.
   */
  private _preStream = new PreStreamTurns<Connection>();
  // Shared auto-continuation barrier (#1649 / #1650): owns the coalesce timer
  // and the double-fire guard. Parameterized by this agent's stream-active
  // signal, apply-drain, and continuation-turn pipeline (`_fireAutoContinuation`).
  private _autoContinuation = new AutoContinuationController<Connection>({
    continuation: this._continuation,
    generateRequestId: () => crypto.randomUUID(),
    isStreamActive: () => this._streamingAssistant !== null,
    hasPendingInteraction: () => this._pendingInteractionPromise !== null,
    hasIncompleteToolBatch: () => this._hasIncompleteToolBatch(),
    drainInteractionApplies: () => this._drainInteractionApplies(),
    keepAliveWhile: <T>(fn: () => Promise<T>) => this.keepAliveWhile(fn),
    fire: () => this._fireAutoContinuation()
  });
  private _insideResponseHook = false;
  private _insideInferenceLoop = false;
  private _pendingInteractionPromise: Promise<boolean> | null = null;
  // Serialization tail for client-tool result/approval applies (#1649). Each
  // apply is a read-modify-write of the full message; running siblings from a
  // parallel tool batch concurrently lets last-write-wins clobber the others
  // back to `input-available`. Chaining every apply off this tail makes them
  // commit atomically in arrival order.
  private _interactionApplyTail: Promise<void> = Promise.resolve();
  // The in-flight assistant message for the active streaming turn. Until
  // `_persistAssistantMessage` writes it at a turn boundary, the message lives
  // ONLY in this accumulator — not in storage and not in `this.messages`. A
  // client tool result can arrive over the WebSocket before that write (the
  // tool-call chunk was already broadcast), so a storage-only lookup in
  // `_applyToolUpdateToMessages` would miss the message and the part would
  // later be repaired as "interrupted" (#1649). Exposing the accumulator here
  // lets the apply write the result in place so it rides into the eventual
  // persist. Null when no stream is active. Mirrors `@cloudflare/ai-chat`'s
  // `_streamingMessage` handling.
  private _streamingAssistant: StreamAccumulator | null = null;
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
  /**
   * Request id → run id for in-flight agent-tool turns (null = resolved as
   * not an agent-tool turn, cached so unrelated turns don't re-query SQLite
   * per frame). Drives frame attribution in {@link broadcast}: a frame
   * belongs to a run iff it carries that run's turn request id, so an error
   * in an unrelated turn or a concurrent run can never leak into another
   * run's state (#1575).
   */
  private _agentToolRunsByRequestId = new Map<string, string | null>();
  private _submissionTableEnsured = false;
  private _workflowNotificationTableEnsured = false;
  private _declaredScheduledTasksTableEnsured = false;
  private _actionLedgerTableEnsured = false;
  private _actionPendingTableEnsured = false;
  private _drainingSubmissions = false;
  private _drainingWorkflowNotifications = false;
  private _submissionAbortControllers = new Map<string, AbortController>();
  private _programmaticStreamErrors = new Map<string, string>();
  protected static submissionRecoveryStaleMs = 15 * 60 * 1000;

  override broadcast(
    msg: string | ArrayBuffer | ArrayBufferView,
    without?: string[]
  ): void {
    // Cheap idle guard so the common (no agent-tool child) broadcast path stays
    // allocation-free — only build the snoop hooks while a run is in flight.
    if (
      this._agentToolForwarders.size > 0 ||
      this._agentToolLiveSequences.size > 0
    ) {
      interceptAgentToolBroadcast(msg, {
        forwarders: this._agentToolForwarders,
        liveSequences: this._agentToolLiveSequences,
        lastErrors: this._agentToolLastErrors,
        responseType: MSG_CHAT_RESPONSE,
        runForRequest: (requestId) => this._agentToolRunForRequest(requestId)
      });
    }
    super.broadcast(msg, without);
  }

  /**
   * Resolve the agent-tool run whose turn owns a request id, or null when the
   * request is not an agent-tool turn. Falls back to the persisted child-run
   * row (whose `request_id` is written when the run's turn is bound, see
   * `startAgentToolRun`) so attribution survives a DO restart mid-run; either
   * outcome is cached.
   */
  private _agentToolRunForRequest(requestId: string): string | null {
    const cached = this._agentToolRunsByRequestId.get(requestId);
    if (cached !== undefined) return cached;
    // Active-run predicate: a child run is in flight while `status` is
    // `starting`/`running`; terminal rows set `status` AND `completed_at`
    // together (the lifecycle invariant), so this is equivalent to
    // `completed_at IS NULL` but states the intent. Kept consistent with
    // `_rebindAgentToolChildRunRequestId` and the ai-chat counterpart.
    const rows = this.sql<{ run_id: string }>`
      SELECT run_id FROM cf_agent_tool_child_runs
      WHERE request_id = ${requestId} AND status IN ('starting', 'running')
      LIMIT 1
    `;
    const runId = rows[0]?.run_id ?? null;
    this._agentToolRunsByRequestId.set(requestId, runId);
    return runId;
  }

  /**
   * Re-bind this facet's in-flight agent-tool child run to the CURRENT turn's
   * request id.
   *
   * When this facet is itself running as an agent-tool child and its turn is
   * interrupted (e.g. a deploy evicts it mid-run), the recovery continuation
   * (`continueLastTurn` / `_retryLastUserTurn`) mints a NEW request id. The
   * `cf_agent_tool_child_runs.request_id` column — and the in-memory attribution
   * map — still point at the pre-eviction turn, so `broadcast` can no longer
   * attribute the recovered turn's frames to the run. The parent's re-attach
   * tail then sees no forwarded chunks, its no-progress budget elapses, and it
   * abandons a healthy, still-advancing child as `interrupted`
   * (`agentToolReattachNoProgressTimeoutMs`). Re-binding the row to the recovery
   * turn's request id keeps frame attribution alive across recovery so the
   * parent re-attaches and follows the child to its real terminal.
   *
   * Safe to call on EVERY recovery continuation:
   *   - Facets that never ran as an agent-tool child have no
   *     `cf_agent_tool_child_runs` table → the guarded SELECT throws → no-op.
   *   - A facet whose run already settled has no `starting`/`running` row → no-op.
   *   - A child DO is addressed by its `runId` (`subAgent(cls, runId)`), so it
   *     owns AT MOST ONE child-run row for its whole lifetime and is never reused
   *     as a top-level chat agent — the single active row is unambiguously this
   *     recovery's run. The `ORDER BY started_at DESC LIMIT 1` is defensive
   *     belt-and-suspenders for that invariant.
   *
   * Uses the same `status IN ('starting','running')` active-run predicate as
   * `_agentToolRunForRequest` and the ai-chat counterpart (see the lifecycle
   * invariant note there).
   */
  private _rebindAgentToolChildRunRequestId(requestId: string): void {
    let runId: string | undefined;
    try {
      const rows = this.sql<{ run_id: string }>`
        SELECT run_id FROM cf_agent_tool_child_runs
        WHERE status IN ('starting', 'running')
        ORDER BY started_at DESC
        LIMIT 1
      `;
      runId = rows[0]?.run_id;
    } catch {
      // No child-run table on facets that never ran as an agent tool.
      return;
    }
    if (!runId) return;
    this._agentToolRunsByRequestId.set(requestId, runId);
    this.sql`
      UPDATE cf_agent_tool_child_runs
      SET request_id = ${requestId}
      WHERE run_id = ${runId}
    `;
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

  /** Return action descriptors compiled into tools for the assistant. */
  getActions(): Record<string, Action> | Promise<Record<string, Action>> {
    return {};
  }

  /** Return messenger integrations that should be routed through this Think agent. */
  getMessengers(): ThinkMessengers {
    return {};
  }

  /**
   * Return the channels for this agent. Wraps (does not supersede)
   * {@link getMessengers}: the implicit `web` channel is always present, each
   * messenger from `getMessengers()` is absorbed as a `kind: "messenger"`
   * channel, and these entries add `web`/`voice`/`custom` surfaces plus
   * per-channel policy. A channel id that collides with a `getMessengers()` id
   * is an error.
   */
  configureChannels(): ThinkChannels | Promise<ThinkChannels> {
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
      await this.chat(userMessage, callback, {
        ...options,
        channel: context.messengerId
      });
    } finally {
      this._activeMessengerContext = previous;
    }
  }

  /**
   * Bind the live messenger delivery surface for the active turn so
   * `deliverNotice` can post to the originating channel while a messenger turn
   * is running. Returns a restore function; save/restore keeps nested turns
   * safe. Called by `deliverMessengerReply`.
   */
  bindActiveDeliverySurface(surface: MessengerDeliverySurface): () => void {
    const previous = this._activeDeliverySurface;
    this._activeDeliverySurface = surface;
    return () => {
      this._activeDeliverySurface = previous;
    };
  }

  /**
   * The channel context for the active turn, if the turn resolved to a channel.
   * Readable from tools/hooks during a turn (e.g. to branch on `kind`).
   */
  get activeChannel(): ChannelContext | undefined {
    return this._activeChannelContext;
  }

  /** Resolve a channel id to a turn-scoped {@link ChannelContext}, if registered. */
  private _resolveChannelContext(
    channel: string | undefined
  ): ChannelContext | undefined {
    if (!channel) {
      return undefined;
    }
    const definition = this._channels?.get(channel);
    if (!definition) {
      // A channel was requested but is not registered. Don't throw (a recovered
      // turn may name a channel later removed from `configureChannels()`), but
      // warn so a typo'd channel id is visible rather than silently policy-free.
      // `_channels` is undefined for sub-agents (no channel registry), where a
      // missing channel is expected, so only warn once the registry exists.
      if (this._channels) {
        console.warn(
          `[Think] turn requested channel "${channel}" which is not registered ` +
            `(configureChannels()/getMessengers()); no per-channel policy applied`
        );
      }
      return undefined;
    }
    this._emitChannelEvent({
      type: "channel:resolved",
      payload: {
        channel,
        kind: definition.kind,
        requestId: admittedTurnContext.getStore()?.requestId
      }
    });
    return {
      channelId: channel,
      kind: definition.kind,
      capabilities: definition.capabilities,
      messenger:
        definition.kind === "messenger" ? this.getMessengerContext() : undefined
    };
  }

  /**
   * Run `fn` with the turn-scoped channel context set for `channel`. No-op (just
   * runs `fn`) when the channel is unset or unregistered. Save/restore keeps
   * nested turns safe — mirrors `chatWithMessengerContext`.
   */
  private async _withChannelContext<T>(
    channel: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const context = this._resolveChannelContext(channel);
    if (!context) {
      return fn();
    }
    const previous = this._activeChannelContext;
    this._activeChannelContext = context;
    try {
      return await fn();
    } finally {
      this._activeChannelContext = previous;
    }
  }

  /**
   * Stamp the channel id onto user messages so a recovered/continued turn can
   * re-resolve the channel from durable history.
   */
  private _stampChannel(
    messages: UIMessage[],
    channel: string | undefined
  ): UIMessage[] {
    if (!channel) {
      return messages;
    }
    return messages.map((message) =>
      message.role === "user"
        ? {
            ...message,
            metadata: {
              ...(message.metadata as Record<string, unknown> | undefined),
              channel
            }
          }
        : message
    );
  }

  /** The channel stamped on the latest user message in the given list, if any. */
  private _channelFromMessages(messages: UIMessage[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user") {
        const channel = (message.metadata as { channel?: unknown } | undefined)
          ?.channel;
        return typeof channel === "string" ? channel : undefined;
      }
    }
    return undefined;
  }

  /** Re-resolve the channel for a continuation from the latest user message. */
  private _channelFromLatestUserMessage(): string | undefined {
    return this._channelFromMessages(this.messages);
  }

  /**
   * Deliver a no-turn, channel-routed message — a deterministic status, fallback,
   * or notice — straight to the channel's delivery surface WITHOUT invoking the
   * model and WITHOUT opening a recovery incident.
   *
   * Routing precedence for the target channel: explicit `options.channel` → the
   * active turn's channel → `"web"`. The `web` channel renders via the transcript
   * (its only client render path), so a web notice is always transcript-visible;
   * messenger/voice deliver out of band and only touch the transcript when
   * `informModel: true`.
   *
   * Like `addMessages`, this bypasses the turn queue and is safe to call from
   * inside a tool `execute` without deadlocking.
   */
  async deliverNotice(
    text: string | { markdown: string },
    options?: DeliverNoticeOptions
  ): Promise<void> {
    const informModel = options?.informModel ?? false;
    const kind: DeliveryKind = options?.kind ?? "notice";
    const plain = typeof text === "string" ? text : text.markdown;
    const annotated = `[Delivered to the user out of band] ${plain}`;
    const channelId = options?.channel ?? this._activeChannelId() ?? "web";

    try {
      if (channelId === "web") {
        await this.addMessages([
          this._noticeMessage(informModel ? annotated : plain, kind)
        ]);
      } else {
        const surface =
          this._activeDeliverySurface ??
          (await this._messengerRuntime?.resolveDeliverySurface(
            channelId,
            options?.thread
          ));
        if (!surface) {
          const kindOf = this._channels?.get(channelId)?.kind;
          let hint: string;
          if (kindOf === undefined) {
            hint = `; channel "${channelId}" is not registered`;
          } else if (kindOf === "messenger") {
            hint = options?.thread
              ? ` (thread "${options.thread}")`
              : "; pass { thread } for out-of-turn messenger notices";
          } else {
            hint = `; channel kind "${kindOf}" has no out-of-turn delivery surface yet`;
          }
          throw new Error(
            `deliverNotice: cannot resolve a delivery surface for channel "${channelId}"${hint}`
          );
        }
        await surface.post(
          typeof text === "string" ? text : { markdown: text.markdown }
        );
        if (informModel) {
          await this.addMessages([this._noticeMessage(annotated, kind)]);
        }
      }
      this._emitChannelEvent({
        type: "notice:delivered",
        payload: { channel: channelId, kind, informModel }
      });
    } catch (error) {
      this._emitChannelEvent({
        type: "notice:failed",
        payload: {
          channel: channelId,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    }
  }

  /**
   * The active turn's channel id, if any. Prefers the turn-scoped channel
   * context, then the active messenger turn's id; web turns have none, so
   * `deliverNotice` defaults to `"web"`.
   */
  private _activeChannelId(): string | undefined {
    return (
      this._activeChannelContext?.channelId ??
      this._activeMessengerContext?.messengerId
    );
  }

  private _noticeMessage(
    text: string,
    kind: DeliveryKind = "notice"
  ): UIMessage {
    return {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text }],
      metadata: { deliveryKind: kind }
    };
  }

  private async _initializeChannels(): Promise<void> {
    if (this.parentPath.length > 0) {
      return;
    }

    const configured = await this.configureChannels();
    const messengers = this.getMessengers();
    const { channels, messengers: messengerDefs } = resolveChannels(
      configured,
      messengers
    );
    this._channels = channels;

    if (Object.keys(messengerDefs).length === 0) {
      return;
    }

    this._messengerRuntime = new ThinkMessengerRuntime(
      messengerDefs,
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
      recoveryRootRequestId: this._activeChatRecoveryRootRequestId ?? requestId,
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
   * Retention window for settled action ledger rows. Deleting a row ends the
   * idempotency guarantee for that key, so increase these windows for side
   * effects whose downstream idempotency horizon is longer. Set a status to
   * `false` to disable sweeping it.
   */
  actionLedgerRetention: ActionLedgerRetentionConfig = {
    settledMs: 30 * 24 * 60 * 60 * 1000,
    pendingMs: 90 * 24 * 60 * 60 * 1000,
    maxSweepRows: 500
  };

  /**
   * Lease window after which a durable `pending` action ledger row is assumed
   * abandoned (its executor isolate died) and may be reclaimed and re-run.
   * Reclaim re-runs `execute`, so it only applies to actions that declare an
   * explicit `idempotencyKey` — that key is the developer's assertion that the
   * keyed side effect is safe to retry. Fallback `tool:${toolCallId}` keys are
   * never reclaimed. Set to `false` to disable stale-pending reclaim entirely
   * (a stale row then blocks forever with `ActionPendingError`, the old
   * behavior). This is a retry lease, not a retention window: retention answers
   * "when may we delete old rows?"; the lease answers "when may we assume the
   * previous executor died and retry safely?". Keep `actionLedgerRetention.pendingMs`
   * well above this lease so reclaim happens before a sweep deletes the row.
   */
  actionLedgerPendingRetryLeaseMs: number | false = 5 * 60 * 1000;

  /**
   * Retention window for abandoned durable-pause approval rows — a
   * `kind: "durable-pause"` action that parked but was never approved or
   * rejected. Deleting a row makes that approval permanently unresolvable, so
   * default generously: "approve days later from a dashboard" is the use case.
   * Set to `false` to disable sweeping. Rows are deleted promptly on
   * approve/reject regardless; this only bounds truly abandoned pauses.
   */
  actionPendingApprovalTtlMs: number | false = 30 * 24 * 60 * 60 * 1000;

  /**
   * Whether reasoning chunks are sent to chat clients by default. Override
   * per turn by returning `sendReasoning` from `beforeTurn`.
   */
  sendReasoning = true;

  /**
   * Inactivity watchdog for the streaming read loop, in milliseconds.
   *
   * If a turn's model stream produces no chunk for this long, the watchdog
   * aborts the turn and surfaces a terminal stream error instead of letting the
   * loop park forever on a hung provider/transport (the "infinite spinner"
   * failure: the stream never throws, so no error and no `done` ever arrives).
   * A `chat:stream:stalled` observability event is emitted when it fires.
   *
   * This measures the gap *between UI-message-stream chunks*, which includes
   * time spent executing server-side tools (no chunks flow while a tool runs).
   * Set it comfortably above your slowest expected model time-to-first-token
   * and your slowest tool execution, or you will abort healthy long turns.
   *
   * Default `0` (disabled) — opt in by setting a value (e.g. `120_000`).
   *
   * Can be overridden per-turn via `TurnConfig.chatStreamStallTimeoutMs`
   * (returned from `beforeTurn`) for turns with known-slow tools.
   */
  chatStreamStallTimeoutMs = 0;

  /**
   * Per-turn stall-watchdog timeout resolved from `TurnConfig` in
   * `_runInferenceLoop`, read by the stream loop when arming the watchdog.
   * `undefined` falls back to the instance-level `chatStreamStallTimeoutMs`.
   * Turns are serialized, so a single active value is safe; it is reset at the
   * top of every `_runInferenceLoop`.
   */
  private _activeStallTimeoutMs: number | undefined;

  // ── Context-overflow handling (opt-in) ────────────────────────────
  //
  // Compaction normally only fires between turns (Session.compactAfter checks
  // the threshold on appendMessage). But a single long, tool-heavy turn grows
  // the prompt step-by-step inside one streamText loop and can exceed the
  // model's context window *mid-turn*, before the next pre-turn check — the
  // provider then 400s ("prompt is too long" / context_length_exceeded). The
  // `contextOverflow` config lets Think recover without baking provider
  // knowledge into core: the app classifies the error (`classifyChatError`),
  // Think reacts.

  /**
   * Opt-in handling for a turn that overflows the context window mid-flight.
   * See {@link ContextOverflowConfig}. Unset (the default) leaves the existing
   * terminal behavior unchanged.
   *
   * @example
   * ```typescript
   * override contextOverflow = {
   *   reactive: true,
   *   proactive: { maxInputTokens: 200_000 }
   * };
   * ```
   */
  contextOverflow?: ContextOverflowConfig;

  /** Whether the reactive compact-and-retry backstop is enabled. */
  private get _overflowReactiveEnabled(): boolean {
    return this.contextOverflow?.reactive === true;
  }

  /** Reactive compact-and-retry budget. */
  private get _overflowMaxRetries(): number {
    return this.contextOverflow?.maxRetries ?? 1;
  }

  /** Proactive guard config, when enabled. */
  private get _overflowGuard():
    | { maxInputTokens: number; headroom?: number; maxCompactions?: number }
    | undefined {
    return this.contextOverflow?.proactive;
  }

  /** Per-run cap on proactive compactions (independent of the reactive budget). */
  private get _overflowProactiveMaxCompactions(): number {
    return Math.max(1, this.contextOverflow?.proactive?.maxCompactions ?? 1);
  }

  /**
   * Count of model messages assembled from history at the start of the current
   * turn (captured in `_runInferenceLoop`). The proactive guard uses it to
   * splice this turn's in-flight steps onto a freshly recompacted head. Turns
   * are serialized, so a single value is safe.
   */
  private _turnModelMessageBaseline = 0;

  /**
   * The assembled tool set for the current turn, captured in
   * `_runInferenceLoop`. The proactive guard reuses it to convert the
   * recompacted history through the same `convertToModelMessages` tool schemas.
   * Turns are serialized, so a single value is safe.
   */
  private _activeTurnTools: ToolSet = {};
  private _activeTurnActionMetadata = new Map<string, CompiledActionMetadata>();
  private _activeTurnAuthorization: NormalizedActionAuthorization = {
    allowed: true
  };
  private _activeTurnActionApprovalDescriptors = new Map<
    string,
    ActionApprovalDescriptor
  >();
  private _activeTurnApprovedActionInputs = new Map<string, unknown>();
  private _activeActionLedgerExecutions = new Map<string, Promise<unknown>>();
  /**
   * Advisory reply attachments recorded by actions during the current admitted
   * turn (see `ctx.attachReply`). Single-slot because turns are serialized.
   * Reset at turn start in `_runInsideAdmittedTurnBody`; intentionally not
   * cleared at turn end so `onChatResponse` and `replyAttachments()` can read
   * it — the next turn's reset overwrites it.
   */
  private _activeTurnReplyAttachments: ReplyAttachment[] = [];
  private _activeTurnReplyAttachmentsRequestId: string | undefined;

  /**
   * Number of times the proactive guard has compacted within the current
   * `_runInferenceLoop` (reset at the top of each run). Capped at
   * `contextOverflow.proactive.maxCompactions` (default `1`) so a guard that
   * keeps reading over-budget usage can't compact on every step — once the head
   * is summarized, further compaction no-ops anyway, and a genuine remaining
   * overflow falls through to the reactive backstop.
   */
  private _proactiveCompactionsThisRun = 0;

  /** One-time guard for the "recovery enabled but no classifier" DX warning. */
  private _warnedMissingClassifier = false;

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
   * Return Agent Skills sources for this Think agent.
   *
   * Bundled skills are typically imported with the Agents Vite plugin:
   *
   * ```typescript
   * import productSkills from "agents:skills"; // -> ./skills next to this file
   * ```
   *
   * Sources are applied in order; the first source to register a skill name
   * wins, and later collisions are skipped with a logged warning.
   */
  getSkills(): SkillSource[] | Promise<SkillSource[]> {
    return [];
  }

  private async _initializeSkills(): Promise<void> {
    // A misconfigured or failing skill source must never prevent the agent
    // from starting. Any error here is logged and skills stay disabled.
    try {
      const sources = await this.getSkills();
      if (sources.length === 0) return;

      const registry = new SkillRegistry(sources, this.getSkillScriptRunner());
      await registry.load();
      this._logSkillWarnings(registry);
      this._skillRegistry = registry;

      await this.session.addContext(registry.contextLabel, {
        description: "Think skills: available skill catalog",
        provider: {
          get: () => registry.systemPrompt()
        }
      });

      const previous = this._configGet("skillsFingerprint");
      if (previous !== registry.fingerprint) {
        await this.session.refreshSystemPrompt();
        this._configSet("skillsFingerprint", registry.fingerprint);
      }
    } catch (error) {
      console.warn(
        `[think] Failed to initialize skills; continuing without them: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Log registry diagnostics (duplicate names, sources that failed to list),
   * deduped by message so a new collision after a deploy still surfaces while
   * the same warning is not repeated on every turn.
   */
  private _logSkillWarnings(registry: SkillRegistry): void {
    for (const warning of registry.warnings) {
      if (this._loggedSkillWarnings.has(warning)) continue;
      this._loggedSkillWarnings.add(warning);
      console.warn(`[think] ${warning}`);
    }
  }

  /**
   * Return an optional runner that enables the `run_skill_script` tool.
   *
   * @experimental Skill script execution is experimental and may change
   * before stabilizing.
   */
  getSkillScriptRunner(): SkillScriptRunner | null {
    return null;
  }

  private async _refreshSkillsIfChanged(): Promise<void> {
    if (!this._skillRegistry) return;

    // Refreshing pulls from live sources (e.g. R2); a transient failure must
    // not break the turn. Keep the last good catalog on error.
    try {
      await this._skillRegistry.refresh();
      this._logSkillWarnings(this._skillRegistry);
      const previous = this._configGet("skillsFingerprint");
      if (previous !== this._skillRegistry.fingerprint) {
        await this.session.refreshSystemPrompt();
        this._configSet("skillsFingerprint", this._skillRegistry.fingerprint);
      }
    } catch (error) {
      console.warn(
        `[think] Failed to refresh skills; using last known catalog: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
   * Authorize action permissions for the current turn. Returning `true` grants
   * all action permissions. Returning `grantedPermissions` limits the default
   * `authorizeAction` implementation to that permission set.
   */
  authorizeTurn(
    _ctx: TurnContext
  ): ActionAuthorizationDecision | Promise<ActionAuthorizationDecision> {
    return true;
  }

  /**
   * Authorize a single action call after its model input and required
   * permissions are known. Override this for app-specific policy; the default
   * implementation enforces the grant returned from `authorizeTurn`.
   */
  authorizeAction(
    ctx: ActionAuthorizationContext
  ): ActionAuthorizationDecision | Promise<ActionAuthorizationDecision> {
    const turnAuthorization = this._activeTurnAuthorization;
    if (!turnAuthorization.allowed) {
      return {
        allowed: false,
        reason: turnAuthorization.reason
      };
    }
    if (turnAuthorization.grantedPermissions === undefined) {
      return true;
    }
    const granted = new Set(turnAuthorization.grantedPermissions);
    const missing = ctx.requiredPermissions.filter(
      (permission) => !granted.has(permission)
    );
    if (missing.length === 0) return true;
    return {
      allowed: false,
      reason: `Missing required permission: ${missing.join(", ")}`
    };
  }

  /**
   * Enrich the approval descriptor shown in approval UIs for a paused codemode
   * `execute` execution. The default descriptor is derived from the first
   * pending action as `connector.method` with its args as the input; override
   * here to supply a human summary, the permissions it consumes, or a risk
   * level (returned fields are merged over the derived defaults).
   *
   * Not called for `kind: "durable-pause"` actions — those carry their own
   * descriptor from the `action()` config. Default returns `undefined` (use the
   * derived descriptor).
   */
  describePausedExecution(
    _pending: import("@cloudflare/codemode").PendingAction[],
    _ctx: { requestId: string; toolCallId: string }
  ): Partial<ActionApprovalDescriptor> | undefined {
    return undefined;
  }

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
  onChatError(error: unknown, _ctx?: ChatErrorContext): unknown {
    return error;
  }

  /**
   * Classify a raw chat-turn error into a provider-agnostic category.
   *
   * Think deliberately ships **no** provider-specific matching: it cannot know
   * that Anthropic's `"prompt is too long"` or OpenAI's
   * `context_length_exceeded` means "context overflow" without baking provider
   * knowledge into core. The app does know its provider/model, so it owns the
   * mapping — the same split Think already uses for `tokenCounter`.
   *
   * Currently this hook drives **only** context-overflow recovery: it is
   * consulted when a turn errors **and** `contextOverflow.reactive` is enabled
   * (if reactive is off, it is not called). Return `"context_overflow"` to run
   * the compact-and-retry backstop; if recovery cannot save the turn, that
   * classification is surfaced on the terminal `onChatError` call via
   * {@link ChatErrorContext.classification}. The other categories are reserved
   * for future use — returning one today is a no-op (the turn terminalizes as
   * usual) and it is **not** forwarded to `onChatError`. Returning
   * `void`/`"unknown"` keeps the existing terminal behavior.
   *
   * The argument may be an `Error`, an AI SDK `APICallError` (with
   * `statusCode`/`responseBody`), or — for in-stream provider errors that
   * surface as a stream error part rather than a throw — the error message
   * string. Narrow accordingly.
   *
   * The second argument carries a {@link ChatErrorContext}: when consulted for
   * overflow recovery it is `{ stage: "stream", requestId }`, so a classifier
   * can correlate the error with the in-flight turn (e.g. to call
   * {@link cancelChat}).
   *
   * @example Anthropic + OpenAI context-overflow
   * ```typescript
   * classifyChatError(error: unknown): ChatErrorClassification | void {
   *   const text = error instanceof Error ? error.message : String(error);
   *   if (/prompt is too long|context length|context_length_exceeded|maximum context/i.test(text)) {
   *     return "context_overflow";
   *   }
   * }
   * ```
   */
  classifyChatError(
    _error: unknown,
    _ctx?: ChatErrorContext
  ): ChatErrorClassification | void {}

  /**
   * Whether an error (thrown or surfaced as an in-stream error string) should
   * trigger the opt-in compact-and-retry backstop. Consults the app's
   * `classifyChatError` and the `contextOverflow.reactive` flag. Centralized
   * so both stream consumers (WebSocket + RPC) classify identically.
   */
  private _isRecoverableContextOverflow(
    error: unknown,
    requestId?: string
  ): boolean {
    if (!this._overflowReactiveEnabled) return false;
    // DX guard: enabling recovery without teaching Think which errors are
    // overflows silently does nothing. Warn once instead of failing quietly.
    if (this.classifyChatError === Think.prototype.classifyChatError) {
      if (!this._warnedMissingClassifier) {
        this._warnedMissingClassifier = true;
        console.warn(
          '[Think] contextOverflow.reactive is enabled but classifyChatError() is not overridden, so no error will ever be treated as a context overflow and recovery will never run. Override classifyChatError() (or assign the exported defaultContextOverflowClassifier) to return "context_overflow" for your provider\'s context-window error (e.g. Anthropic "prompt is too long", OpenAI context_length_exceeded).'
        );
      }
      return false;
    }
    let classification: ChatErrorClassification | void;
    try {
      classification = this.classifyChatError(error, {
        stage: "stream",
        requestId
      });
    } catch (err) {
      console.warn(
        `[Think] classifyChatError threw; treating as non-overflow: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
    return classification === "context_overflow";
  }

  /**
   * Compact the session in response to a context overflow (reactive backstop or
   * proactive guard). Returns whether history was actually shortened — a no-op
   * compaction (returns `null`) means a retry would just overflow again, so the
   * caller should fall through to the terminal error rather than loop.
   *
   * This is the single emit point for `chat:context:compacted`, so callers must
   * NOT emit it again.
   */
  private async _compactForContextOverflow(
    reason: "reactive" | "proactive",
    extra?: { requestId?: string; attempt?: number }
  ): Promise<boolean> {
    try {
      const result = await this.session.compact();
      const shortened = Boolean(result);
      this._emit("chat:context:compacted", {
        reason,
        shortened,
        ...extra
      });
      return shortened;
    } catch (err) {
      console.warn(
        `[Think] context-overflow compaction failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  /**
   * Finalize a context overflow that recovery could not fix (compaction was a
   * no-op, or the retry budget is spent). Routes the error through
   * `onChatError` with `classification: "context_overflow"` and emits
   * `chat:request:failed`, so every overflow terminal — whichever path it took
   * — is reported identically. Returns the (possibly app-reshaped) message for
   * the caller to deliver via its own transport (RPC callback / WS broadcast).
   */
  private _finalizeContextOverflowError(
    requestId: string,
    rawError: string | undefined
  ): string {
    const raw = rawError ?? "Context window exceeded.";
    const wrapped = this.onChatError(raw, {
      requestId,
      stage: "stream",
      messagesPersisted: true,
      classification: "context_overflow"
    });
    const message =
      wrapped instanceof Error ? wrapped.message : String(wrapped);
    this._emit("chat:request:failed", {
      requestId,
      stage: "stream",
      messagesPersisted: true,
      error: message
    });
    return message;
  }

  // ── Extension initialization ───────────────────────────────────

  private async _initializeExtensions(): Promise<void> {
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
   * Assemble provider-ready model messages from the current session history:
   * repair the transcript, truncate older messages, drop any still-incomplete
   * tool calls, and convert to `ModelMessage[]`. Shared by the turn entry point
   * and the proactive context guard so a mid-turn recompaction rebuilds the
   * head through the exact same pipeline.
   */
  private async _assembleModelMessages(
    tools: ToolSet
  ): Promise<Awaited<ReturnType<typeof convertToModelMessages>>> {
    const history = await this._repairTranscriptForProvider(this.messages);
    const truncated = truncateOlderMessages(history) as UIMessage[];
    // `_repairTranscriptForProvider` above already heals orphan tool calls
    // (flipping them to errored results, preserving the record). This is the
    // last-line backstop: if any incomplete tool call still slips through
    // (compaction edge, addToolOutput race, an unrecognized part shape), drop it
    // here rather than letting the provider 400 with AI_MissingToolResultsError.
    //
    // The backstop drops silently. Repair should have left nothing incomplete,
    // so a non-empty set here means repair missed a shape — surface it (rather
    // than masking a repair bug) without breaking the turn.
    const incompleteAfterRepair = this._incompleteToolCallIds(truncated);
    if (incompleteAfterRepair.length > 0) {
      console.warn(
        `[Think] ${incompleteAfterRepair.length} incomplete tool call(s) survived transcript repair and will be dropped by ignoreIncompleteToolCalls: ${incompleteAfterRepair.join(", ")}. This indicates a gap in _repairToolTranscriptParts.`
      );
      this._emit("chat:transcript:repaired", {
        removedToolCalls: incompleteAfterRepair.length,
        normalizedInputs: 0,
        toolCallIds: incompleteAfterRepair
      });
    }
    return convertToModelMessages(truncated, {
      tools,
      ignoreIncompleteToolCalls: true
    });
  }

  /**
   * Proactive context guard (Layer 1). Runs before each step from the
   * `prepareStep` wrapper. If `contextOverflow.proactive` is set and the *previous*
   * step's model-reported input tokens cross the budget, compact the session in
   * place and return recompacted messages for the upcoming step — heading off a
   * provider context-overflow 400 before it happens.
   *
   * Keys off `usage.inputTokens` (provider-agnostic; every provider reports it)
   * rather than any provider error string, and reuses `_assembleModelMessages`
   * so the recompacted head goes through the same repair/convert pipeline. The
   * current turn's in-flight steps (everything after `_turnModelMessageBaseline`)
   * are spliced back on so no completed work is lost.
   *
   * Best-effort: any failure (no-op compaction, reconciliation that would leave
   * an incomplete tool pair) returns `undefined` so the step proceeds unchanged
   * and the reactive backstop (`contextOverflow.reactive`) can still
   * catch a genuine overflow.
   */
  private async _maybeProactiveContextCompact(
    event: PrepareStepContext
  ): Promise<Awaited<ReturnType<typeof convertToModelMessages>> | undefined> {
    const guard = this._overflowGuard;
    if (!guard || guard.maxInputTokens <= 0) return undefined;
    // Proactive cap is independent of the reactive budget — it has its own
    // `proactive.maxCompactions` (default 1). This lets an app use the proactive
    // guard without the reactive backstop (and vice versa) and tune each freely.
    if (
      this._proactiveCompactionsThisRun >= this._overflowProactiveMaxCompactions
    )
      return undefined;

    const prev = event.steps?.at(-1);
    const used = prev?.usage?.inputTokens ?? prev?.usage?.totalTokens;
    if (used == null || !Number.isFinite(used)) return undefined;

    const headroom = guard.headroom ?? 0.9;
    if (used < guard.maxInputTokens * headroom) return undefined;

    try {
      // Count the ATTEMPT (not just successful shortenings) before compacting.
      // This bounds the guard to `proactiveCap` tries per run regardless of
      // outcome: a no-op compaction (e.g. nothing left to summarize) would be a
      // no-op again on every subsequent step, so consuming the slot here is
      // what stops it from compacting — and emitting `chat:context:compacted` —
      // on every step. A genuine remaining overflow falls through to the
      // reactive backstop. (Locked by the "no-op" proactive test.)
      this._proactiveCompactionsThisRun++;
      const shortened = await this._compactForContextOverflow("proactive");
      if (!shortened) return undefined;

      // Rebuild the compacted head, then splice this turn's in-flight steps
      // (which are not yet persisted to the session) back onto the tail.
      const head = await this._assembleModelMessages(this._activeTurnTools);
      const tail = event.messages.slice(this._turnModelMessageBaseline);
      const merged = [...head, ...tail];
      // Re-baseline so a second guard fire this turn keeps the new tail. This
      // is correct only if the AI SDK carries our returned `messages` override
      // forward into the next step's `event.messages` (so the next slice sees
      // [recompacted head, ...in-flight steps], not the original uncompacted
      // array). Verified by the "fires twice in one turn" test in
      // assistant-agent-loop.test.ts — a clean multi-fire completion proves the
      // override propagates and the splice does not drop/duplicate tool pairs.
      this._turnModelMessageBaseline = head.length;
      return merged;
    } catch (err) {
      console.warn(
        `[Think] proactive context compaction failed; proceeding without it: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  /**
   * The single convergence point for all chat turn entry paths.
   * Merges tools, assembles context, fires lifecycle hooks, wraps tools
   * for interception, and calls streamText.
   */
  private async _runInferenceLoop(input: TurnInput): Promise<StreamableResult> {
    // Reset the per-turn watchdog override; `beforeTurn` may set it below. A
    // turn that doesn't override falls back to the instance-level value.
    this._activeStallTimeoutMs = undefined;
    this._activeTurnAuthorization = { allowed: true };
    this._activeTurnApprovedActionInputs =
      this._approvedActionInputsFromTranscript();
    // Reset the proactive-compaction cap for this streamText run.
    this._proactiveCompactionsThisRun = 0;
    if (this.waitForMcpConnections) {
      const timeout =
        typeof this.waitForMcpConnections === "object"
          ? this.waitForMcpConnections.timeout
          : 10_000;
      await this.mcp.waitForConnections({ timeout });
    }

    const workspaceTools = createWorkspaceTools(this.workspace, {
      bash: this.workspaceBash
    });
    const baseTools = this.getTools();
    const actionTools = await this._compileActionTools();
    const extensionTools = this.extensionManager?.getTools() ?? {};
    await this._refreshSkillsIfChanged();
    const contextTools = await this.session.tools();
    const skillTools = this._skillRegistry?.tools() ?? {};
    const clientToolSet = createToolsFromClientSchemas(
      input.clientTools,
      input.clientToolExecutor
        ? { execute: input.clientToolExecutor }
        : undefined
    );
    let tools: ToolSet = {
      ...workspaceTools,
      ...baseTools,
      ...actionTools,
      ...extensionTools,
      ...contextTools,
      ...skillTools,
      ...(this.mcp?.getAITools?.() ?? {}),
      ...clientToolSet
    };

    // Per-channel policy (overridable defaults applied BEFORE `beforeTurn`):
    // narrow the tool set (the `config.tools` seam can only ADD, never remove)
    // and prepend channel instructions to the base system prompt.
    const channelContext = this._activeChannelContext;
    const channelDefinition = channelContext
      ? this._channels?.get(channelContext.channelId)
      : undefined;
    if (channelDefinition?.tools) {
      tools = channelDefinition.tools(tools);
    }

    const channelInstructions =
      channelDefinition?.instructions && channelContext
        ? typeof channelDefinition.instructions === "function"
          ? await channelDefinition.instructions(channelContext)
          : channelDefinition.instructions
        : undefined;

    const frozenPrompt = await this.session.freezeSystemPrompt();
    const rawBaseSystem = frozenPrompt || this.getSystemPrompt();
    const baseSystem = channelInstructions
      ? `${channelInstructions}\n\n${rawBaseSystem}`
      : rawBaseSystem;
    const system = this._systemPromptForTurn(baseSystem, tools);

    const messages = await this._assembleModelMessages(tools);

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
    // Workflow `step.prompt` turns produce their structured result by calling
    // the synthetic `final_answer` tool (see THINK_FINAL_ANSWER_TOOL_NAME) —
    // NOT via the AI SDK `output`/`response_format` path, which some providers
    // reject when streaming. We pre-build the JSON Schema once here.
    const structuredOutputSchema = workflowPrompt?.output
      ? jsonSchema(workflowPrompt.output.schema as never)
      : undefined;
    const wantsStructuredOutput = structuredOutputSchema !== undefined;

    const finalModel = config.model ?? model;
    const finalSystem =
      config.system ??
      this._systemPromptForTurn(
        baseSystem,
        config.tools ? { ...tools, ...config.tools } : tools
      );
    const finalMessages = ensureValidContinueCheckpoint(
      config.messages ?? messages
    );
    const mergedTools: ToolSet = config.tools
      ? { ...tools, ...config.tools }
      : tools;
    const finalTurnContext: TurnContext = {
      ...ctx,
      system: finalSystem,
      messages: finalMessages,
      tools: mergedTools,
      model: finalModel
    };
    this._activeTurnAuthorization = this._normalizeActionAuthorization(
      await this.authorizeTurn(finalTurnContext)
    );
    // Wrap each tool's `execute` so `beforeToolCall` is consulted before
    // the tool actually runs. The wrapped `execute` honors the returned
    // `ToolCallDecision` — `block` short-circuits with `reason`,
    // `substitute` returns `output` directly, `allow` runs the original
    // (optionally with modified `input`).
    const finalTools: ToolSet = this._wrapToolsWithDecision(mergedTools);
    // For a structured workflow turn, expose a final-answer tool alongside the
    // agent's real tools. The agent loops with its tools and terminates by
    // calling this one; its arguments are captured as the structured result.
    // Guard against a clash with a user tool of the same name by suffixing.
    let finalAnswerToolName = THINK_FINAL_ANSWER_TOOL_NAME;
    if (structuredOutputSchema) {
      let suffix = 1;
      while (finalAnswerToolName in finalTools) {
        finalAnswerToolName = `${THINK_FINAL_ANSWER_TOOL_NAME}_${suffix++}`;
      }
      finalTools[finalAnswerToolName] = tool({
        description:
          "Provide your final answer. The arguments MUST match the required " +
          "schema. Calling this tool ends the task — call it exactly once when " +
          "you have everything you need.",
        inputSchema: structuredOutputSchema,
        execute: async () => "Final answer recorded."
      });
    }

    // Baseline for the proactive context guard: everything the AI SDK appends
    // to the model-message list after the assembled turn messages belongs to
    // this turn's steps, so a mid-turn recompaction can keep that tail and only
    // re-summarize the (now-compacted) head. Captured from the FINAL messages
    // and tools — after `beforeTurn` may have overridden them — so the tail
    // splice stays correct even when the override changes the message count.
    this._turnModelMessageBaseline = finalMessages.length;
    this._activeTurnTools = mergedTools;

    // `maxTurns` is an overridable per-channel default: a user `beforeTurn`
    // returning `maxSteps` still wins, then the channel cap, then the instance
    // default.
    const finalMaxSteps =
      config.maxSteps ?? channelDefinition?.maxTurns ?? this.maxSteps;
    const finalSendReasoning = config.sendReasoning ?? this.sendReasoning;
    // Resolve the per-turn stall-watchdog override (explicit `0` = off for this
    // turn). Read by `_streamResult` / `_streamResultToRpcCallback` when arming
    // the watchdog. `??` so a `0` override is honored, not treated as "unset".
    this._activeStallTimeoutMs =
      config.chatStreamStallTimeoutMs ?? this.chatStreamStallTimeoutMs;
    // `output` (AI SDK structured-output / `response_format`) is reserved for
    // the opt-in chat `TurnConfig.output` API. Workflow prompts use the
    // `final_answer` tool instead (see `wantsStructuredOutput`).
    const finalOutput = config.output;
    // On a structured workflow turn, append the instruction telling the model to
    // finish by calling `final_answer`. `filter(Boolean)` drops an absent system
    // prompt so we never stringify `undefined` into the prompt.
    const turnSystem = wantsStructuredOutput
      ? [finalSystem, thinkFinalAnswerInstruction(finalAnswerToolName)]
          .filter(Boolean)
          .join("\n\n")
      : finalSystem;
    // Structured turns must not end with a plain-text answer that skips
    // `final_answer` (some models, e.g. Workers AI llama, otherwise just reply
    // in text and stop). Force tool use: when the agent has real tools, require
    // *a* tool each step so it can do work and then call `final_answer`; with no
    // real tools, pin the choice directly to `final_answer`. A caller-provided
    // `toolChoice` still wins.
    const structuredHasRealTools =
      wantsStructuredOutput &&
      Object.keys(finalTools).some((name) => name !== finalAnswerToolName);
    const finalToolChoice = wantsStructuredOutput
      ? (config.toolChoice ??
        (structuredHasRealTools
          ? "required"
          : { type: "tool" as const, toolName: finalAnswerToolName }))
      : config.toolChoice;
    const finalStopWhen = [
      stepCountIs(finalMaxSteps),
      // Stop as soon as the model calls `final_answer` so the structured turn
      // terminates at the answer instead of continuing to stream more steps.
      ...(wantsStructuredOutput ? [hasToolCall(finalAnswerToolName)] : []),
      ...(Array.isArray(config.stopWhen)
        ? config.stopWhen
        : config.stopWhen
          ? [config.stopWhen]
          : [])
    ];

    const result = streamText({
      model: finalModel,
      system: turnSystem,
      messages: finalMessages,
      tools: finalTools,
      // Keep the synthetic final-answer tool callable even when a caller
      // restricts `activeTools` — otherwise a structured turn could never call
      // it and would fail to produce output.
      activeTools:
        wantsStructuredOutput && config.activeTools
          ? [...config.activeTools, finalAnswerToolName]
          : config.activeTools,
      toolChoice: finalToolChoice,
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
      // Forward the per-turn stream transform(s) from TurnConfig so callers
      // can inspect/rewrite the stream (e.g. emit `source` parts derived from
      // tool results) without owning the stream pipeline themselves.
      experimental_transform: config.experimental_transform,
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
        // Proactive context guard (Layer 1) runs first so `beforeStep` sees the
        // recompacted messages and can still override them if it wants to.
        const guarded = await this._maybeProactiveContextCompact(event);
        const result = await this.beforeStep(event);
        const base = result == null ? {} : result;
        // Only apply the guard's recompacted messages when the subclass didn't
        // set its own `messages` override for this step.
        const baseMessages = (base as { messages?: unknown }).messages;
        const withMessages =
          guarded && baseMessages === undefined
            ? { ...base, messages: guarded }
            : base;
        // Safety net for structured workflow turns: on the final permitted step,
        // force the model to call `final_answer` so the turn always terminates
        // with a schema-shaped result instead of running out of steps. Respect a
        // `toolChoice` the subclass already set for this step.
        if (
          wantsStructuredOutput &&
          event.stepNumber >= finalMaxSteps - 1 &&
          (withMessages as { toolChoice?: unknown }).toolChoice === undefined
        ) {
          return {
            ...withMessages,
            toolChoice: {
              type: "tool" as const,
              toolName: finalAnswerToolName
            },
            activeTools: [finalAnswerToolName]
          };
        }
        return withMessages;
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
        // The synthetic final-answer tool is internal plumbing for structured
        // workflow turns — do not surface it to user `afterToolCall` hooks or
        // extensions.
        if (event.toolCall.toolName === finalAnswerToolName) return;
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

    const outputPromise = wantsStructuredOutput
      ? // Structured workflow result = the `final_answer` tool call's INPUT
        // (its arguments), captured after the stream finishes. Take the last
        // call in case the model emitted more than one. `result.toolCalls` is a
        // `PromiseLike`, so wrap it to get a real `Promise` (for `.catch` below).
        Promise.resolve(result.toolCalls).then((calls) => {
          const finalCalls = calls.filter(
            (call) => call.toolName === finalAnswerToolName
          );
          const last = finalCalls[finalCalls.length - 1];
          if (!last) {
            throw new Error(
              `Model ended the turn without calling the ${finalAnswerToolName} tool`
            );
          }
          return last.input;
        })
      : finalOutput && result.output
        ? Promise.resolve(result.output)
        : undefined;
    if (outputPromise) {
      // Attach a rejection observer immediately. `_streamResult()` will still
      // await this promise when captureOutput is enabled, but aborted streams can
      // reject before the stream consumer reaches that point.
      void outputPromise.catch(() => {});
    }

    const streamResult = {
      toUIMessageStream: (options) =>
        result.toUIMessageStream({
          sendReasoning: options?.sendReasoning ?? finalSendReasoning,
          onError: options?.onError ?? streamErrorToString
        }),
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

  private _normalizeActionAuthorization(
    decision: ActionAuthorizationDecision
  ): NormalizedActionAuthorization {
    if (typeof decision === "boolean") {
      return { allowed: decision };
    }
    return {
      allowed: decision.allowed,
      ...(decision.reason !== undefined && { reason: decision.reason }),
      ...(decision.grantedPermissions !== undefined && {
        grantedPermissions: [...decision.grantedPermissions]
      })
    };
  }

  private _emitActionLedgerEvent(event: ActionLedgerEvent): void {
    const emit = this._emit as unknown as (
      type: string,
      payload: Record<string, unknown>
    ) => void;
    emit.call(this, event.type, event.payload);
  }

  private _emitChannelEvent(event: ChannelEvent): void {
    const emit = this._emit as unknown as (
      type: string,
      payload: Record<string, unknown>
    ) => void;
    emit.call(this, event.type, event.payload);
  }

  private _approvedActionInputsFromTranscript(): Map<string, unknown> {
    const approved = new Map<string, unknown>();
    for (const message of this.messages) {
      for (const part of message.parts ?? []) {
        if (typeof part !== "object" || part === null) continue;
        const record = part as Record<string, unknown>;
        const toolCallId =
          typeof record.toolCallId === "string" ? record.toolCallId : undefined;
        if (!toolCallId) continue;
        const approval = record.approval as
          | { approved?: unknown; descriptor?: unknown }
          | undefined;
        if (approval?.approved !== true) continue;
        const descriptor = approval.descriptor as
          | { input?: unknown; action?: unknown }
          | undefined;
        if (typeof descriptor?.action !== "string") continue;
        approved.set(
          toolCallId,
          "input" in descriptor ? descriptor.input : record.input
        );
      }
    }
    return approved;
  }

  private async _resolveActionPermissions(
    spec: ActionPermissionSpec<unknown> | undefined,
    input: unknown,
    ctx: ActionContext
  ): Promise<string[]> {
    if (spec === undefined) return [];
    const policyCtx = this._actionContextWithoutReply(ctx);
    const permissions =
      typeof spec === "function" ? await spec({ input, ctx: policyCtx }) : spec;
    return [...permissions];
  }

  private _actionContextWithoutReply(ctx: ActionContext): ActionContext {
    return {
      ...ctx,
      attachReply: () => {}
    };
  }

  private async _authorizeActionCall(options: {
    actionName: string;
    kind: ActionKind;
    input: unknown;
    ctx: ActionContext;
    permissions?: ActionPermissionSpec<unknown>;
  }): Promise<NormalizedActionAuthorization & { permissions: string[] }> {
    const permissions = await this._resolveActionPermissions(
      options.permissions,
      options.input,
      options.ctx
    );
    const decision = await this.authorizeAction({
      requestId: options.ctx.requestId,
      toolCallId: options.ctx.toolCallId,
      action: options.actionName,
      kind: options.kind,
      input: options.input,
      requiredPermissions: permissions,
      grantedPermissions: this._activeTurnAuthorization.grantedPermissions,
      messages: options.ctx.messages,
      agent: this,
      env: this.env as Cloudflare.Env
    });
    return {
      ...this._normalizeActionAuthorization(decision),
      permissions
    };
  }

  private async _compileActionTools(): Promise<ToolSet> {
    const actions = await this.getActions();
    const tools: ToolSet = {};
    this._activeTurnActionMetadata = new Map();
    this._activeTurnActionApprovalDescriptors = new Map();
    for (const [registrationName, descriptor] of Object.entries(actions)) {
      if (!isAction(descriptor)) {
        throw new Error(
          `getActions() entry "${registrationName}" must be created with action().`
        );
      }
      const toolName = descriptor.config.name ?? registrationName;
      const kind =
        descriptor.config.kind ??
        (descriptor.config.approval ? "approval-gated" : "server");
      if (kind === "approval-gated" || kind === "durable-pause") {
        const staticPermissions = Array.isArray(descriptor.config.permissions)
          ? [...descriptor.config.permissions]
          : undefined;
        this._activeTurnActionMetadata.set(toolName, {
          actionName: toolName,
          summary:
            descriptor.config.approvalSummary ?? descriptor.config.description,
          ...(staticPermissions !== undefined && {
            permissions: staticPermissions
          }),
          ...(descriptor.config.approvalRisk !== undefined && {
            risk: descriptor.config.approvalRisk
          }),
          kind
        });
      }
      tools[toolName] = this._actionToTool(descriptor, toolName, kind);
    }
    return tools;
  }

  private _actionToTool(
    descriptor: Action,
    toolName: string,
    kind: ActionKind
  ): ToolSet[string] {
    const config = descriptor.config;
    const executeAction = config.execute as (
      input: unknown,
      ctx: ActionContext
    ) => Promise<unknown> | unknown;
    const approval = config.approval as
      | ActionApprovalPolicy<unknown>
      | undefined;
    const permissions = config.permissions as
      | ActionPermissionSpec<unknown>
      | undefined;
    const idempotencyKey = config.idempotencyKey as
      | ActionIdempotencyKey<unknown>
      | undefined;

    return tool({
      description: config.description,
      metadata: {
        cfThinkAction: true,
        cfThinkActionApprovalConfigured:
          approval !== undefined && kind !== "durable-pause"
      },
      inputSchema: config.inputSchema as never,
      ...(approval !== undefined && kind !== "durable-pause"
        ? {
            needsApproval: async (
              input: unknown,
              options: {
                toolCallId: string;
                messages: ModelMessage[];
              }
            ) => {
              const ctx: ActionContext = {
                agent: this,
                env: this.env as Cloudflare.Env,
                requestId: admittedTurnContext.getStore()?.requestId ?? "",
                toolCallId: options.toolCallId,
                messages: options.messages,
                signal: new AbortController().signal,
                // No-op: approval/permission predicates must be pure and may
                // run twice (prompt + resume). Attachments belong to execute.
                attachReply: () => {}
              };
              if (
                this._activeTurnApprovedActionInputs.has(options.toolCallId)
              ) {
                return true;
              }
              const authorization = await this._authorizeActionCall({
                actionName: toolName,
                kind,
                input,
                ctx,
                permissions
              });
              if (!authorization.allowed) return false;
              const needsApproval =
                typeof approval === "function"
                  ? await approval({ input, ctx })
                  : approval;
              if (needsApproval) {
                this._activeTurnActionApprovalDescriptors.set(
                  options.toolCallId,
                  {
                    requestId: ctx.requestId,
                    toolCallId: options.toolCallId,
                    action: toolName,
                    summary: config.approvalSummary ?? config.description,
                    input,
                    permissions: authorization.permissions,
                    ...(config.approvalRisk !== undefined && {
                      risk: config.approvalRisk
                    }),
                    kind: "approval-gated"
                  }
                );
              }
              return needsApproval;
            }
          }
        : {}),
      execute: async (
        input: unknown,
        options: {
          toolCallId?: string;
          messages?: ModelMessage[];
          abortSignal?: AbortSignal;
        }
      ): Promise<unknown> => {
        const { signal, cleanup } = createActionAbortSignal(
          options.abortSignal,
          config.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
        );
        const requestId = admittedTurnContext.getStore()?.requestId ?? "";
        const actionContext: ActionContext = {
          agent: this,
          env: this.env as Cloudflare.Env,
          requestId,
          toolCallId: options.toolCallId ?? "",
          messages: options.messages ?? [],
          signal,
          attachReply: (attachment) =>
            this._recordReplyAttachment(requestId, attachment, toolName)
        };
        const abortError = () =>
          signal.reason instanceof Error
            ? signal.reason
            : new Error(
                signal.reason ? String(signal.reason) : "Action aborted"
              );
        let onAbort: (() => void) | undefined;

        try {
          const authorization = await this._authorizeActionCall({
            actionName: toolName,
            kind,
            input,
            ctx: actionContext,
            permissions
          });
          if (!authorization.allowed) {
            return actionAuthorizationErrorEnvelope(
              authorization.reason,
              authorization.permissions
            );
          }
          if (signal.aborted) throw abortError();
          const abortPromise = new Promise<never>((_, reject) => {
            onAbort = () => reject(abortError());
            signal.addEventListener("abort", onAbort, { once: true });
          });
          const runAction = async () => {
            const output = await Promise.race([
              Promise.resolve(executeAction(input, actionContext)),
              abortPromise
            ]);
            return prepareActionOutputForModel(output);
          };

          if (kind === "durable-pause") {
            // The approval predicate gates whether to PARK (not whether an AI
            // SDK approval is needed). Absent → always park; a function may opt
            // a given input out of the human gate and run inline instead.
            const shouldPark =
              approval === undefined
                ? true
                : typeof approval === "function"
                  ? await approval({
                      input,
                      ctx: this._actionContextWithoutReply(actionContext)
                    })
                  : approval;
            if (!shouldPark) {
              return await this._runLedgeredAction({
                toolName,
                idempotencyKey,
                input,
                ctx: actionContext,
                runAction
              });
            }
            return this._parkDurablePauseAction({
              toolName,
              input,
              ctx: actionContext,
              summary: config.approvalSummary ?? config.description,
              permissions: authorization.permissions,
              risk: config.approvalRisk
            });
          }

          return await this._runLedgeredAction({
            toolName,
            idempotencyKey,
            input,
            ctx: actionContext,
            runAction
          });
        } catch (error) {
          return actionErrorEnvelope(error);
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
          cleanup();
        }
      }
    });
  }

  /**
   * Run an action's `execute` through the action ledger: same-isolate
   * coalescing, durable claim/replay, settle-on-success, release-on-failure.
   * Shared by the inline server-action path and the durable-pause-on-approve
   * path so an action's side effect is replay-safe regardless of how it is
   * dispatched. `runAction` must already apply timeout/abort and
   * `prepareActionOutputForModel`.
   */
  private async _runLedgeredAction(args: {
    toolName: string;
    idempotencyKey: ActionIdempotencyKey<unknown> | undefined;
    input: unknown;
    ctx: ActionContext;
    runAction: () => Promise<unknown>;
  }): Promise<unknown> {
    const { toolName, idempotencyKey, input, ctx, runAction } = args;

    const ledgerKey = await this._resolveActionLedgerKey(
      toolName,
      idempotencyKey,
      input,
      this._actionContextWithoutReply(ctx)
    );
    if (!ledgerKey) {
      const attachmentCount = this._activeTurnReplyAttachments.length;
      try {
        return await runAction();
      } catch (error) {
        this._activeTurnReplyAttachments.length = attachmentCount;
        throw error;
      }
    }

    const active = this._activeActionLedgerExecutions.get(ledgerKey);
    if (active) {
      return await active;
    }

    const inputHash = this._actionInputHash(input);
    // An explicit `idempotencyKey` is the developer's assertion that retrying
    // the keyed side effect is safe; only those rows are reclaimable when stale.
    // Fallback `tool:${toolCallId}` keys stay conservative.
    const hasExplicitIdempotencyKey = idempotencyKey !== undefined;
    const claim = this._claimActionLedgerRow({
      key: ledgerKey,
      actionName: toolName,
      requestId: ctx.requestId,
      toolCallId: ctx.toolCallId,
      inputHash,
      retryablePending: hasExplicitIdempotencyKey,
      leaseMs: this.actionLedgerPendingRetryLeaseMs
    });
    if (claim.outcome === "replay") {
      this._emitActionLedgerEvent({
        type: "action:ledger:replayed",
        payload: { action: toolName, key: ledgerKey, inputHash }
      });
      return decodeActionLedgerOutput(claim.row.result_json);
    }
    if (claim.outcome === "pending") {
      this._emitActionLedgerEvent({
        type: "action:ledger:pending",
        payload: { action: toolName, key: ledgerKey, inputHash }
      });
      return actionPendingErrorEnvelope();
    }
    if (claim.outcome === "conflict") {
      this._emitActionLedgerEvent({
        type: "action:ledger:conflict",
        payload: { action: toolName, key: ledgerKey, inputHash }
      });
      return actionKeyConflictEnvelope(toolName, ledgerKey);
    }
    // `claimed` (fresh row) and `reclaimed` (stale row re-leased) both fall
    // through to execution below; reclaim just re-runs the keyed side effect.
    if (claim.outcome === "reclaimed") {
      this._emitActionLedgerEvent({
        type: "action:ledger:reclaimed",
        payload: {
          action: toolName,
          key: ledgerKey,
          inputHash,
          ageMs: Date.now() - claim.row.updated_at
        }
      });
    }

    const attachmentCount = this._activeTurnReplyAttachments.length;
    const execution = Promise.resolve().then(async () => {
      try {
        const prepared = await runAction();
        const encoded = encodeActionLedgerOutput(prepared);
        if (!encoded.ok) {
          this._releaseActionLedgerRow(ledgerKey);
          this._emitActionLedgerEvent({
            type: "action:ledger:serialize_failed",
            payload: { action: toolName, key: ledgerKey }
          });
          return prepared;
        }
        this._settleActionLedgerRow(ledgerKey, encoded.json);
        this._emitActionLedgerEvent({
          type: "action:ledger:settled",
          payload: { action: toolName, key: ledgerKey, inputHash }
        });
        return encoded.value;
      } catch (error) {
        this._activeTurnReplyAttachments.length = attachmentCount;
        throw error;
      }
    });
    this._activeActionLedgerExecutions.set(ledgerKey, execution);
    try {
      return await execution;
    } catch (error) {
      this._releaseActionLedgerRow(ledgerKey);
      return actionErrorEnvelope(error);
    } finally {
      this._activeActionLedgerExecutions.delete(ledgerKey);
    }
  }

  /**
   * Park a `kind: "durable-pause"` action for human approval. Persists a
   * compaction-safe pending row (action name + model input + approval
   * descriptor) so the approval survives history compaction, deploys, and
   * isolate eviction, then returns the minimal model-visible paused output.
   *
   * The action's `execute` does NOT run here — it runs later in
   * `approveExecution` via `_runLedgeredAction`, so the side effect is gated on
   * human approval AND remains replay-safe. The rich descriptor lives on the
   * row and on the transcript part, never embedded in the model-visible output.
   */
  private _parkDurablePauseAction(args: {
    toolName: string;
    input: unknown;
    ctx: ActionContext;
    summary: string;
    permissions: string[];
    risk?: "low" | "medium" | "high";
  }): {
    status: "paused";
    executionId: string;
    action: string;
    message: string;
  } {
    const { toolName, input, ctx, summary, permissions, risk } = args;
    const executionId = `${ACTION_PAUSE_ID_PREFIX}${crypto.randomUUID()}`;
    const descriptor: ActionApprovalDescriptor = {
      requestId: ctx.requestId,
      toolCallId: ctx.toolCallId,
      action: toolName,
      summary,
      input,
      permissions,
      ...(risk !== undefined && { risk }),
      kind: "durable-pause"
    };
    this._insertActionPendingRow({
      execution_id: executionId,
      action_name: toolName,
      tool_call_id: ctx.toolCallId,
      request_id: ctx.requestId || null,
      input_json: JSON.stringify(input),
      descriptor_json: JSON.stringify(descriptor),
      created_at: Date.now()
    });
    this._emitActionPauseEvent({
      type: "action:pause:created",
      payload: { action: toolName, executionId, toolCallId: ctx.toolCallId }
    });
    return {
      status: "paused",
      executionId,
      action: toolName,
      message:
        "This action is awaiting human approval. Stop and wait for the " +
        "approval result before proceeding."
    };
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
      const metadata = t.metadata as Record<string, unknown> | undefined;
      const isApprovalConfiguredAction =
        metadata?.cfThinkAction === true &&
        metadata.cfThinkActionApprovalConfigured === true;

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
          const approvedInput = isApprovalConfiguredAction
            ? this._activeTurnApprovedActionInputs.get(options.toolCallId)
            : undefined;
          if (
            approvedInput !== undefined &&
            !stableJsonEqual(finalInput, approvedInput)
          ) {
            return actionApprovalInputErrorEnvelope();
          }
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

  private async _admitTurn<T>(
    spec: QueueTurnSpec<T>
  ): Promise<AdmittedQueueResult<T>>;
  private async _admitTurn<T>(spec: NonQueueTurnSpec<T>): Promise<T>;
  private async _admitTurn<T>(
    spec: TurnSpec<T>
  ): Promise<AdmittedQueueResult<T> | T> {
    if (spec.admission !== "queue") {
      // The non-queue (submit/execute-submission) path runs `execute()` here
      // directly — it does NOT pass through `_runInsideAdmittedTurnBody`, so the
      // channel context must be set here too.
      return this._withChannelContext(spec.channel, () => spec.execute());
    }

    if (!spec.allowNested) {
      this._assertNotInsideAdmittedTurn(spec.trigger);
    }

    return this.keepAliveWhile(async () => {
      const turnPromise = this._turnQueue.enqueue(
        spec.requestId,
        () => this._runInsideAdmittedTurnBody(spec),
        spec.generation === undefined
          ? undefined
          : { generation: spec.generation }
      );
      spec.onQueued?.();
      return turnPromise;
    });
  }

  private _assertNotInsideAdmittedTurn(trigger: TurnTrigger): void {
    if (admittedTurnContext.getStore()?.agent !== this) return;
    throw new Error(
      `Think turn admission (${trigger}) cannot be called from inside an active turn; use runTurn({ mode: "submit" }) or addMessages() instead`
    );
  }

  private async _runInsideAdmittedTurnBody<T>(
    spec: QueueTurnSpec<T>
  ): Promise<T> {
    return admittedTurnContext.run(
      { agent: this, requestId: spec.requestId },
      async () => {
        const startedAt = Date.now();
        this._emit("chat:turn:start", {
          requestId: spec.requestId,
          trigger: spec.trigger,
          admission: spec.admission,
          ...(spec.continuation !== undefined && {
            continuation: spec.continuation
          }),
          ...(spec.generation !== undefined && { generation: spec.generation })
        });

        this._activeTurnReplyAttachments = [];
        this._activeTurnReplyAttachmentsRequestId = spec.requestId;

        try {
          const value = await this._withChannelContext(spec.channel, () =>
            spec.execute()
          );
          this._emit("chat:turn:finish", {
            requestId: spec.requestId,
            trigger: spec.trigger,
            admission: spec.admission,
            ...(spec.continuation !== undefined && {
              continuation: spec.continuation
            }),
            ...(spec.generation !== undefined && {
              generation: spec.generation
            }),
            status: spec.getStatus?.() ?? "completed",
            durationMs: Date.now() - startedAt
          });
          return value;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this._emit("chat:turn:finish", {
            requestId: spec.requestId,
            trigger: spec.trigger,
            admission: spec.admission,
            ...(spec.continuation !== undefined && {
              continuation: spec.continuation
            }),
            ...(spec.generation !== undefined && {
              generation: spec.generation
            }),
            status: "error",
            durationMs: Date.now() - startedAt,
            error: message
          });
          throw error;
        }
      }
    );
  }

  // ── Sub-agent RPC entry point ───────────────────────────────────

  /**
   * Run a chat turn: persist the user message, run the agentic loop,
   * stream UIMessageChunk events via callback, and persist the
   * assistant's response.
   *
   * @param userMessage The user's message(s), or a callback that derives them
   * from the in-queue transcript.
   * @param callback Streaming callback (typically an RpcTarget from the parent)
   * @param options Optional chat options (e.g. AbortSignal)
   */
  async chat(
    userMessage: TurnInputMessages,
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

    // Client tools supplied by the caller (e.g. a parent agent delegating to
    // this sub-agent). Both the schemas and the `onClientToolCall` executor are
    // forwarded per-turn only — deliberately NOT persisted into
    // `_lastClientTools`. The executor is a live RPC ref that dies with the
    // isolate, so unlike the WebSocket path there is no SPA that could ever
    // replay a `tool-result` after an eviction. Persisting the names would put
    // them in `_clientResolvableToolNames()`, causing recovery to misclassify a
    // dangling `input-available` orphan as a pending human interaction and park
    // forever. Keeping them per-turn lets such an orphan recover like a server
    // tool: `continueLastTurn`'s transcript repair errors it and the model
    // proceeds. `_runInferenceLoop` sources client tools from `input.clientTools`
    // (not `_lastClientTools`), so the live turn is unaffected.
    const clientTools = options?.clientTools?.length
      ? options.clientTools
      : undefined;
    const clientToolExecutor = options?.onClientToolCall;

    try {
      await callback.onStart({ requestId });
      await this._admitTurn({
        admission: "queue",
        trigger: "rpc",
        requestId,
        continuation: false,
        channel: options?.channel,
        execute: async () => {
          const resolved =
            typeof userMessage === "function"
              ? await userMessage(this.messages)
              : this._normalizeChatMessages(userMessage);

          for (const msg of this._stampChannel(resolved, options?.channel)) {
            await this._appendMessageToHistory(msg);
          }
          this._broadcastMessages();

          const chatBody = async () => {
            // Bounded compact-and-retry loop (opt-in via
            // `contextOverflow.reactive`). A turn that overflows the context
            // window mid-flight is compacted and re-run from the persisted
            // partial instead of dying terminally. Every attempt re-runs the
            // SAME user turn from the now-compacted history, so it stays
            // `continuation: false` — an overflow retry is not an
            // auto-continuation, and `beforeTurn` should not treat it as one.
            for (let attempt = 0; ; attempt++) {
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
                      clientTools,
                      clientToolExecutor,
                      continuation: false
                    })
                );
              } catch (error) {
                const wrapped = this.onChatError(error, {
                  stage: "turn",
                  messagesPersisted: true
                });
                const errorMessage =
                  wrapped instanceof Error ? wrapped.message : String(wrapped);
                this._emit("chat:request:failed", {
                  stage: "turn",
                  messagesPersisted: true,
                  error: errorMessage
                });
                await callback.onError(errorMessage);
                return;
              }

              // The consumer suppresses a classified overflow whenever recovery
              // is enabled; the driver (here) owns the retry-vs-terminal call so
              // every overflow terminal is reported identically.
              const { status, error } = await this._streamResultToRpcCallback(
                requestId,
                result,
                callback,
                abortSignal,
                { overflowRecovery: this._overflowReactiveEnabled }
              );

              if (status === "overflow_retry") {
                if (
                  attempt < this._overflowMaxRetries &&
                  !abortSignal?.aborted
                ) {
                  const shortened = await this._compactForContextOverflow(
                    "reactive",
                    { requestId, attempt: attempt + 1 }
                  );
                  // Compaction shortened history → retry. A no-op compaction
                  // can't fix the overflow, so fall through to terminal.
                  if (shortened) continue;
                }
                // Budget spent, aborted, or compaction no-op: deliver terminally
                // (through onChatError, classified) so the turn never loops or ends
                // silently with no answer.
                const message = this._finalizeContextOverflowError(
                  requestId,
                  error
                );
                await callback.onError(message);
              }
              return;
            }
          };

          if (this.chatRecovery) {
            await this._runChatRecoveryFiber(requestId, false, chatBody);
          } else {
            await chatBody();
          }
        }
      });
    } finally {
      detachExternal();
      this._aborts.remove(requestId);
    }
  }

  /**
   * Unified turn admission API (Turns RFC, step 2).
   *
   * Thin facade over {@link Think.saveMessages}, {@link Think.continueLastTurn},
   * {@link Think.submitMessages}, and {@link Think.chat}. Each `mode` delegates
   * to the matching backing method with a narrowed option surface; the full
   * unified superset lands with `_admitTurn` (step 3).
   *
   * - `mode: "wait"` (default) — blocking turn; returns {@link TurnResult}.
   * - `mode: "submit"` — durable queued turn; returns {@link SubmitMessagesResult}.
   * - `mode: "stream"` — RPC-style streaming; returns `Promise<void>`.
   *
   * **Re-entrancy.** Calling `mode: "wait"` or `continuation: true` from inside
   * an active turn (a tool `execute`, a lifecycle hook) deadlocks on the turn
   * queue — identical to calling {@link Think.saveMessages} or
   * {@link Think.continueLastTurn} from there. Prefer `mode: "submit"` or
   * {@link Think.addMessages} instead. Precise nested-call detection is deferred
   * to `_admitTurn` (step 3).
   *
   * **Empty input (`wait`).** String, single-message, and array inputs that
   * normalize to an empty list short-circuit to `{ status: "skipped" }` without
   * running inference. A function `input` that resolves to `[]` at run time is
   * not pre-checked (the function must see the in-queue transcript); step 3's
   * `_admitTurn` centralizes empty-skip inside the queue.
   *
   * @experimental
   */
  runTurn(options: RunTurnWait): Promise<TurnResult>;
  runTurn(options: RunTurnSubmit): Promise<SubmitMessagesResult>;
  runTurn(options: RunTurnStream): Promise<void>;
  async runTurn(
    options: RunTurnOptions
  ): Promise<TurnResult | SubmitMessagesResult | void> {
    const mode = this._resolveRunTurnMode(options);
    if (mode === "stream") {
      return this._runTurnStream(options as RunTurnStream);
    }
    if (mode === "submit") {
      return this._runTurnSubmit(options as RunTurnSubmit);
    }
    return this._runTurnWait(options as RunTurnWait);
  }

  private _resolveRunTurnMode(
    options: RunTurnOptions
  ): "wait" | "submit" | "stream" {
    if (options === null || typeof options !== "object") {
      throw new TypeError("runTurn: options must be an object");
    }

    const mode = (options as { mode?: unknown }).mode;
    if (mode === undefined || mode === "wait") return "wait";
    if (mode === "submit" || mode === "stream") return mode;
    throw new TypeError('runTurn: mode must be "wait", "submit", or "stream"');
  }

  private _validateRunTurnAdmission(
    options: RunTurnOptions,
    mode: "wait" | "submit" | "stream"
  ): void {
    const hasInput = options.input !== undefined;
    const continuation =
      mode === "wait" && (options as RunTurnWait).continuation === true;

    if (mode !== "wait" && (options as RunTurnWait).continuation === true) {
      throw new TypeError(
        'runTurn: continuation is only supported with mode: "wait"'
      );
    }

    if (mode === "stream" && !(options as RunTurnStream).callback) {
      throw new TypeError('runTurn: mode "stream" requires callback');
    }

    if (mode === "wait") {
      if (hasInput && continuation) {
        throw new TypeError(
          "runTurn: supply either input or continuation: true, not both"
        );
      }
      if (!hasInput && !continuation) {
        throw new TypeError(
          "runTurn: supply either input or continuation: true"
        );
      }
      return;
    }

    if (!hasInput) {
      throw new TypeError(`runTurn: mode "${mode}" requires input`);
    }
  }

  private _userMessageFromText(text: string): UIMessage {
    return {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text }]
    };
  }

  private _normalizeRunTurnMessages(
    input: Exclude<
      TurnInputMessages,
      (current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>
    >
  ): UIMessage[] {
    if (typeof input === "string") {
      if (input.length === 0) return [];
      return [this._userMessageFromText(input)];
    }
    if (Array.isArray(input)) {
      return input;
    }
    return [input];
  }

  private _normalizeChatMessages(
    input: Exclude<
      TurnInputMessages,
      (current: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>
    >
  ): UIMessage[] {
    if (typeof input === "string") {
      return [this._userMessageFromText(input)];
    }
    if (Array.isArray(input)) {
      return input;
    }
    return [input];
  }

  private _assertRunTurnSubmitInput(
    input: TurnInputMessages
  ): asserts input is string | UIMessage | UIMessage[] {
    if (typeof input === "function") {
      throw new Error(
        'runTurn({ mode: "submit" }) does not support function input until _admitTurn (step 3)'
      );
    }
  }

  private async _enrichTurnResult(
    result: SaveMessagesResult,
    continuation: boolean
  ): Promise<TurnResult> {
    let message: SessionMessage | undefined;
    if (result.status === "completed") {
      const leaf = await this.session.getLatestLeaf();
      if (leaf?.role === "assistant") {
        message = leaf;
      }
    }
    return { ...result, continuation, message };
  }

  private async _runTurnWait(options: RunTurnWait): Promise<TurnResult> {
    this._validateRunTurnAdmission(options, "wait");

    if (options.continuation === true) {
      const result = await this.continueLastTurn(options.body, {
        signal: options.signal,
        channel: options.channel
      });
      return this._enrichTurnResult(result, true);
    }

    const input = options.input;
    if (input === undefined) {
      throw new TypeError("runTurn: supply either input or continuation: true");
    }

    if (typeof input === "function") {
      const result = await this._runProgrammaticMessagesTurn(
        crypto.randomUUID(),
        input,
        { signal: options.signal, channel: options.channel }
      );
      return this._enrichTurnResult(result, false);
    }

    const messages = this._normalizeRunTurnMessages(input);
    if (messages.length === 0) {
      return { requestId: "", status: "skipped", continuation: false };
    }

    const result = await this._runProgrammaticMessagesTurn(
      crypto.randomUUID(),
      messages,
      { signal: options.signal, channel: options.channel }
    );
    return this._enrichTurnResult(result, false);
  }

  private async _runTurnSubmit(
    options: RunTurnSubmit
  ): Promise<SubmitMessagesResult> {
    this._validateRunTurnAdmission(options, "submit");

    const input = options.input;
    if (input === undefined) {
      throw new TypeError('runTurn: mode "submit" requires input');
    }

    this._assertRunTurnSubmitInput(input);
    const messages = this._normalizeRunTurnMessages(input);
    return this.submitMessages(messages, {
      submissionId: options.submissionId,
      idempotencyKey: options.idempotencyKey,
      metadata: options.metadata,
      channel: options.channel
    });
  }

  private async _runTurnStream(options: RunTurnStream): Promise<void> {
    this._validateRunTurnAdmission(options, "stream");

    const input = options.input;
    if (input === undefined) {
      throw new TypeError('runTurn: mode "stream" requires input');
    }

    if (typeof input !== "function") {
      const messages = this._normalizeRunTurnMessages(input);
      if (messages.length === 0) {
        await options.callback.onStart({ requestId: crypto.randomUUID() });
        await options.callback.onDone();
        return;
      }
    }

    return this.chat(input, options.callback, {
      signal: options.signal,
      clientTools: options.clientTools,
      onClientToolCall: options.onClientToolCall,
      channel: options.channel
    });
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
        // Bind the run to its turn's request id BEFORE the turn starts —
        // in memory for live frame attribution in `broadcast`, and on the
        // child-run row so attribution survives a DO restart mid-run
        // (#1575). `saveMessages` would generate the id internally, so call
        // the inner turn runner with a pre-generated one instead.
        const requestId = crypto.randomUUID();
        this._agentToolRunsByRequestId.set(requestId, options.runId);
        this.sql`
          UPDATE cf_agent_tool_child_runs
          SET request_id = ${requestId}
          WHERE run_id = ${options.runId}
        `;
        const result = await this._runProgrammaticMessagesTurn(
          requestId,
          [this.formatAgentToolInput(input)],
          {
            signal: controller.signal,
            trigger: "agent-tool"
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
        // Drop this run's request-id mappings. When no runs remain in flight
        // clear the whole map, so negatively-cached (null) entries for
        // unrelated turns can't accumulate for the DO's lifetime — the map is
        // only consulted while a run is active (#1575).
        if (this._agentToolAbortControllers.size === 0) {
          this._agentToolRunsByRequestId.clear();
        } else {
          for (const [reqId, runId] of this._agentToolRunsByRequestId) {
            if (runId === options.runId) {
              this._agentToolRunsByRequestId.delete(reqId);
            }
          }
        }
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
    // Stop the original in-isolate run if it's still live...
    this._agentToolAbortControllers.get(runId)?.abort(reason);
    // ...and any in-flight chat-recovery turn driving this child facet after an
    // eviction. A recovered turn re-runs via `_chatRecoveryContinue` outside
    // `startAgentToolRun`, so it has no entry in `_agentToolAbortControllers`; a
    // child facet is dedicated to a single agent-tool run, so aborting its
    // active submissions tears the recovery down instead of letting it keep
    // grinding (and holding a fiber / keep-alive) after the parent gave up on
    // it and sealed `interrupted` (#1630 follow-up).
    for (const controller of this._submissionAbortControllers.values()) {
      controller.abort(reason);
    }
    this.sql`
      UPDATE cf_agent_tool_child_runs
      SET status = 'aborted',
          error_message = ${reason instanceof Error ? reason.message : reason === undefined ? null : String(reason)},
          completed_at = ${Date.now()}
      WHERE run_id = ${runId}
        AND status NOT IN ('completed', 'error', 'aborted')
    `;
    // Release any parent live-tail so it stops waiting on this run immediately.
    this._finalizeAgentToolChildRunTailers(runId);
  }

  /**
   * Classify any in-flight chat-recovery on this child facet (#1630). A child
   * facet is dedicated to a single agent-tool run, so any recovery incident is
   * that run's. `detected`/`scheduled`/`attempting` mean recovery is still
   * resolving the interrupted turn; `exhausted`/`failed` mean it gave up; a
   * completed recovery deletes its incident.
   */
  private _classifyAgentToolChildRecovery(): Promise<
    "in-progress" | "failed" | "none"
  > {
    return classifyAgentToolChildRecovery(this.ctx.storage);
  }

  async inspectAgentToolRun(
    runId: string
  ): Promise<AgentToolRunInspection | null> {
    let row = this._readAgentToolChildRun(runId);
    if (!row) return null;
    // A `running`/`starting` row with no live abort controller means the
    // original in-isolate run is gone (e.g. the parent was evicted while this
    // child run was in flight, #1630) — lazily reconcile it from the child's
    // own durable recovery before reporting.
    if (this._isStaleAgentToolChildRun(row)) {
      await this._reconcileStaleAgentToolChildRun(runId);
      row = this._readAgentToolChildRun(runId) ?? row;
    }
    return this._inspectionFromChildRow(row, this.getAgentToolOutput(runId));
  }

  private _isStaleAgentToolChildRun(row: AgentToolChildRunRow): boolean {
    return (
      (row.status === "running" || row.status === "starting") &&
      row.completed_at === null &&
      !this._agentToolAbortControllers.has(row.run_id)
    );
  }

  /**
   * Reconcile a stale (post-eviction) child run row from the child's own
   * durable recovery (#1630). The child facet self-heals its interrupted turn
   * via `chatRecovery`, but that path never writes the run row, so without this
   * the row strands `running` and the parent can only collect `interrupted`.
   *
   * Persisting the terminal here (rather than only computing it) is intentional:
   * it's a lazy materialization of the run's true terminal that also lets a
   * tailing parent's stream close promptly and makes subsequent inspects cheap.
   * While recovery is still resolving (active stream or in-progress incident)
   * the row is left `running` so the parent's bounded re-attach keeps waiting.
   */
  private async _reconcileStaleAgentToolChildRun(runId: string): Promise<void> {
    const recovery = await this._classifyAgentToolChildRecovery();
    if (recovery === "in-progress" || this._resumableStream.hasActiveStream()) {
      return;
    }
    // A settled recovery that produced an assistant turn is `completed`, even if
    // that turn ended on a tool result with no final text — keying off text
    // alone would mis-seal a legitimately-finished (but text-less) run as
    // `error`. `getAgentToolSummary` already falls back to "" when there is no
    // final text.
    const recoveredTurn =
      recovery !== "failed" && this._hasRecoveredAgentToolAssistantTurn(runId);
    if (recoveredTurn) {
      const output = this.getAgentToolOutput(runId);
      const summary = this.getAgentToolSummary(runId, output);
      this.sql`
        UPDATE cf_agent_tool_child_runs
        SET status = 'completed',
            summary = ${summary},
            output_json = ${Think._stringifyAgentToolOutput(output)},
            error_message = null,
            completed_at = ${Date.now()}
        WHERE run_id = ${runId} AND completed_at IS NULL
      `;
    } else {
      const error =
        "Agent tool run was interrupted before the child could finish.";
      this.sql`
        UPDATE cf_agent_tool_child_runs
        SET status = 'error',
            error_message = ${error},
            completed_at = ${Date.now()}
        WHERE run_id = ${runId} AND completed_at IS NULL
      `;
    }
    this._finalizeAgentToolChildRunTailers(runId);
  }

  /** Release a re-attached run's live tail + per-run streaming bookkeeping. */
  private _finalizeAgentToolChildRunTailers(runId: string): void {
    for (const close of this._agentToolClosers.get(runId) ?? []) {
      close();
    }
    this._agentToolClosers.delete(runId);
    this._agentToolForwarders.delete(runId);
    this._agentToolLiveSequences.delete(runId);
    this._agentToolLastErrors.delete(runId);
    this._agentToolPreTurnAssistantIds.delete(runId);
  }

  /**
   * Eagerly terminalize this child facet's OWN agent-tool run row(s) once a
   * recovered turn has settled. A recovered turn re-runs via either
   * `_chatRecoveryContinue` → `continueLastTurn` or, for a pre-stream eviction,
   * `_chatRecoveryRetry` (a fresh user turn) — neither flows through
   * `startAgentToolRun`'s finalizer, so without this the run row strands
   * `running` and its tailers stay open until a parent inspect lazily
   * reconciles it — forcing a re-attached parent to wait out a full no-progress
   * window before collecting an already-finished result (#1630 follow-up).
   * Reconciling here closes the tail promptly so the parent collects the
   * terminal immediately. No-op on non-child facets (their
   * `cf_agent_tool_child_runs` table is empty) and on rows whose in-memory run
   * is still live (those are finalized by `startAgentToolRun`); the underlying
   * reconcile leaves a row `running` while its recovery is still in progress.
   */
  private async _reconcileOwnStaleAgentToolChildRuns(): Promise<void> {
    let rows: Array<{ run_id: string }>;
    try {
      rows = this.sql<{ run_id: string }>`
        SELECT run_id FROM cf_agent_tool_child_runs
        WHERE completed_at IS NULL
      `;
    } catch {
      // No child-run table on this facet (it never ran as a child) — nothing
      // to reconcile.
      return;
    }
    for (const { run_id } of rows) {
      if (this._agentToolAbortControllers.has(run_id)) continue;
      try {
        await this._reconcileStaleAgentToolChildRun(run_id);
      } catch {
        // Best-effort: a parent inspect still reconciles lazily.
      }
    }
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
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>> {
    const self = this;
    const signal = options?.signal;
    let closed = false;
    let forward: ((chunk: AgentToolStoredChunk) => void) | undefined;
    const detach = () => {
      if (forward) {
        self._agentToolForwarders.get(runId)?.delete(forward);
        forward = undefined;
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const close = () => {
          if (closed) return;
          closed = true;
          detach();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        };
        // Honor an external abort (e.g. a bounded re-attach budget) so a parent
        // tailing a still-running child can stop waiting without cancelling the
        // child itself — closing the stream unblocks the parent's forwarder.
        if (signal?.aborted) {
          close();
          return;
        }
        signal?.addEventListener("abort", close, { once: true });

        const replayed = await self.getAgentToolChunks(runId, options);
        for (const chunk of replayed) {
          if (closed) return;
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
          close();
          return;
        }
        forward = (chunk: AgentToolStoredChunk) => {
          if (closed || chunk.sequence <= (options?.afterSequence ?? -1)) {
            return;
          }
          try {
            controller.enqueue(
              agentToolChunkEncoder.encode(`${JSON.stringify(chunk)}\n`)
            );
          } catch {
            // The consumer detached (e.g. a parent's re-attach budget expired
            // and cancelled the reader) between the RPC cancel arriving and our
            // `cancel`/`close` running. Drop the chunk instead of surfacing a
            // "Stream was cancelled" rejection; the child run is unaffected.
            closed = true;
            detach();
          }
        };
        const forwarders = self._agentToolForwarders.get(runId) ?? new Set();
        forwarders.add(forward);
        self._agentToolForwarders.set(runId, forwarders);
        const closers = self._agentToolClosers.get(runId) ?? new Set();
        closers.add(close);
        self._agentToolClosers.set(runId, closers);
      },
      cancel() {
        // A consumer detaching from the tail (e.g. a parent's bounded re-attach
        // budget expiring, via reader.cancel()) is read-only — it must NOT
        // cancel the child run. Explicit cancellation flows through
        // cancelAgentToolRun. Mirrors @cloudflare/ai-chat's read-only tail.
        closed = true;
        detach();
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

  /**
   * Whether the run produced an assistant turn (text or tool-only). Used by the
   * post-eviction reconcile to mark a settled run `completed` even when it ended
   * without final text. A dedicated child facet starts with no assistant
   * messages, so a missing in-memory pre-turn snapshot is treated as empty.
   */
  private _hasRecoveredAgentToolAssistantTurn(runId: string): boolean {
    const before =
      this._agentToolPreTurnAssistantIds.get(runId) ?? new Set<string>();
    return this.messages.some(
      (msg) => msg.role === "assistant" && !before.has(msg.id)
    );
  }

  private _getAgentToolFinalText(runId: string): string | null {
    // A child facet is dedicated to a single agent-tool run, so any assistant
    // message it holds is that run's output. When the pre-turn snapshot is
    // missing — e.g. reconciling after a real eviction, where the in-memory
    // snapshot died with the original isolate (#1630) — treat it as empty so
    // the recovered transcript's assistant text is still surfaced as the
    // summary instead of being lost.
    const before =
      this._agentToolPreTurnAssistantIds.get(runId) ?? new Set<string>();
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

  // ── Action ledger ────────────────────────────────────────────────

  private _ensureActionLedgerTable(): void {
    if (this._actionLedgerTableEnsured) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_think_action_ledger (
        key TEXT PRIMARY KEY,
        action_name TEXT NOT NULL,
        request_id TEXT,
        tool_call_id TEXT,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS cf_think_action_ledger_sweep
      ON cf_think_action_ledger (status, updated_at)
    `;
    this._actionLedgerTableEnsured = true;
  }

  private _readActionLedgerRow(key: string): ActionLedgerRow | null {
    this._ensureActionLedgerTable();
    const rows = this.sql<ActionLedgerRow>`
      SELECT key, action_name, request_id, tool_call_id, input_hash, status,
             result_json, created_at, updated_at
      FROM cf_think_action_ledger
      WHERE key = ${key}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /**
   * Claim a ledger key for execution. Read-then-write with no `await` between
   * the read and any write, so within the single DO isolate two claims cannot
   * interleave — the same race-free idiom documented on
   * {@link _claimActionPendingRow}. The only way a durable `pending` row
   * outlives its writer is a crashed prior isolate, which has no live writer to
   * race; that is the row a stale reclaim safely re-runs.
   */
  private _claimActionLedgerRow(options: {
    key: string;
    actionName: string;
    requestId: string;
    toolCallId: string;
    inputHash: string;
    retryablePending: boolean;
    leaseMs: number | false;
    now?: number;
  }): ActionLedgerClaim {
    this._ensureActionLedgerTable();
    const now = options.now ?? Date.now();
    const existing = this._readActionLedgerRow(options.key);
    if (existing) {
      if (
        existing.action_name !== options.actionName ||
        existing.input_hash !== options.inputHash
      ) {
        return { outcome: "conflict", row: existing };
      }
      if (existing.status === "settled") {
        return { outcome: "replay", row: existing };
      }
      // `pending` from here. Reclaim only an explicit-key row whose lease has
      // expired; fresh rows, fallback keys, and a disabled lease still block.
      const stale =
        options.retryablePending &&
        options.leaseMs !== false &&
        now - existing.updated_at > options.leaseMs;
      if (!stale) {
        return { outcome: "pending", row: existing };
      }
      this.sql`
        UPDATE cf_think_action_ledger
        SET request_id = ${options.requestId || null},
            tool_call_id = ${options.toolCallId || null},
            updated_at = ${now}
        WHERE key = ${options.key} AND status = ${"pending"}
      `;
      return { outcome: "reclaimed", row: existing };
    }

    this.sql`
      INSERT INTO cf_think_action_ledger (
        key, action_name, request_id, tool_call_id, input_hash, status,
        result_json, created_at, updated_at
      )
      VALUES (
        ${options.key}, ${options.actionName}, ${options.requestId || null},
        ${options.toolCallId || null}, ${options.inputHash}, ${"pending"},
        ${null}, ${now}, ${now}
      )
    `;
    return { outcome: "claimed" };
  }

  private _settleActionLedgerRow(key: string, resultJson: string): void {
    this._ensureActionLedgerTable();
    this.sql`
      UPDATE cf_think_action_ledger
      SET status = ${"settled"},
          result_json = ${resultJson},
          updated_at = ${Date.now()}
      WHERE key = ${key}
    `;
  }

  private _releaseActionLedgerRow(key: string): void {
    this._ensureActionLedgerTable();
    this.sql`
      DELETE FROM cf_think_action_ledger
      WHERE key = ${key}
    `;
  }

  private async _resolveActionLedgerKey(
    actionName: string,
    spec: ActionIdempotencyKey<unknown> | undefined,
    input: unknown,
    ctx: ActionContext
  ): Promise<string | null> {
    if (spec !== undefined) {
      const key =
        typeof spec === "function" ? await spec({ input, ctx }) : spec;
      if (key.length === 0) {
        throw new Error(
          `Action "${actionName}" returned an empty idempotency key`
        );
      }
      return `action:${actionName}:${key}`;
    }
    return ctx.toolCallId ? `tool:${ctx.toolCallId}` : null;
  }

  private _actionInputHash(input: unknown): string {
    return stableHash(input);
  }

  private _actionLedgerRetentionForStatus(
    status: ActionLedgerSweepStatus
  ): number | false {
    return status === "settled"
      ? this.actionLedgerRetention.settledMs
      : this.actionLedgerRetention.pendingMs;
  }

  private _deleteActionLedgerRows(keys: string[]): number {
    let deleted = 0;
    for (let i = 0; i < keys.length; i += MAX_BOUND_PARAMS) {
      const batch = keys.slice(i, i + MAX_BOUND_PARAMS);
      const strings = buildInClauseStrings(
        "DELETE FROM cf_think_action_ledger WHERE key IN ",
        batch.length
      );
      this.sql(strings, ...batch);
      deleted += batch.length;
    }
    return deleted;
  }

  private _sweepActionLedgerStatus(
    status: ActionLedgerSweepStatus,
    now: number,
    limit: number
  ): number {
    const retentionMs = this._actionLedgerRetentionForStatus(status);
    if (retentionMs === false || limit <= 0) return 0;
    const cutoff = now - retentionMs;
    const rows = this.sql<{ key: string }>`
      SELECT key
      FROM cf_think_action_ledger
      WHERE status = ${status}
        AND updated_at < ${cutoff}
      ORDER BY updated_at ASC
      LIMIT ${limit}
    `;
    return this._deleteActionLedgerRows(rows.map((row) => row.key));
  }

  private async _sweepActionLedger(options?: {
    force?: boolean;
  }): Promise<{ settled: number; pending: number }> {
    this._ensureActionLedgerTable();
    const now = Date.now();
    if (!options?.force) {
      const lastSwept =
        (await this.ctx.storage.get<number>(ACTION_LEDGER_LAST_SWEPT_KEY)) ?? 0;
      if (now - lastSwept < ACTION_LEDGER_SWEEP_INTERVAL_MS) {
        return { settled: 0, pending: 0 };
      }
    }

    const maxSweepRows = Math.max(
      0,
      Math.floor(this.actionLedgerRetention.maxSweepRows)
    );
    const settled = this._sweepActionLedgerStatus("settled", now, maxSweepRows);
    const pending = this._sweepActionLedgerStatus(
      "pending",
      now,
      Math.max(0, maxSweepRows - settled)
    );
    await this.ctx.storage.put(ACTION_LEDGER_LAST_SWEPT_KEY, now);
    this._emitActionLedgerEvent({
      type: "action:ledger:swept",
      payload: { settled, pending }
    });
    return { settled, pending };
  }

  // ── Durable-pause action approvals ──────────────────────────────

  private _emitActionReplyEvent(event: ActionReplyEvent): void {
    const emit = this._emit as unknown as (
      type: string,
      payload: Record<string, unknown>
    ) => void;
    emit.call(this, event.type, event.payload);
  }

  /**
   * Record an advisory reply attachment for the active turn. Advisory: a
   * non-object, a missing/non-string `type`, or exceeding the per-turn cap is
   * silently ignored. The attachment is JSON-normalized to a safe copy so a
   * later mutation of the caller's object can't corrupt it and downstream
   * persistence/RPC can't choke on bigint/circular values.
   */
  private _recordReplyAttachment(
    requestId: string,
    attachment: unknown,
    actionName?: string
  ): void {
    if (!requestId || requestId !== this._activeTurnReplyAttachmentsRequestId) {
      return;
    }
    if (
      typeof attachment !== "object" ||
      attachment === null ||
      Array.isArray(attachment) ||
      typeof (attachment as { type?: unknown }).type !== "string"
    ) {
      return;
    }
    if (
      this._activeTurnReplyAttachments.length >= MAX_REPLY_ATTACHMENTS_PER_TURN
    ) {
      return;
    }
    const serialized = safeStringifyActionOutput(attachment);
    if (serialized.error || serialized.value === undefined) {
      return;
    }
    const normalized = JSON.parse(serialized.value) as unknown;
    if (
      typeof normalized !== "object" ||
      normalized === null ||
      Array.isArray(normalized) ||
      typeof (normalized as { type?: unknown }).type !== "string"
    ) {
      return;
    }
    this._activeTurnReplyAttachments.push(normalized as ReplyAttachment);
    this._emitActionReplyEvent({
      type: "action:reply-attached",
      payload: {
        ...(actionName !== undefined && { action: actionName }),
        attachmentType: (normalized as { type: string }).type
      }
    });
  }

  private _cloneReplyAttachment(attachment: ReplyAttachment): ReplyAttachment {
    return JSON.parse(JSON.stringify(attachment)) as ReplyAttachment;
  }

  /**
   * Advisory reply attachments recorded during a turn via `ctx.attachReply`.
   * Returns deep copies. With no `requestId`, returns the most recent turn's
   * attachments; with a `requestId`, returns them only if they belong to that
   * turn (else `[]`).
   */
  replyAttachments(requestId?: string): ReplyAttachment[] {
    if (
      requestId !== undefined &&
      requestId !== this._activeTurnReplyAttachmentsRequestId
    ) {
      return [];
    }
    return this._activeTurnReplyAttachments.map((attachment) =>
      this._cloneReplyAttachment(attachment)
    );
  }

  private _emitActionPauseEvent(event: ActionPauseEvent): void {
    const emit = this._emit as unknown as (
      type: string,
      payload: Record<string, unknown>
    ) => void;
    emit.call(this, event.type, event.payload);
  }

  private _ensureActionPendingTable(): void {
    if (this._actionPendingTableEnsured) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS cf_think_action_pending_approvals (
        execution_id TEXT PRIMARY KEY,
        action_name TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        request_id TEXT,
        input_json TEXT NOT NULL,
        descriptor_json TEXT,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS cf_think_action_pending_created
      ON cf_think_action_pending_approvals (created_at)
    `;
    this._actionPendingTableEnsured = true;
  }

  private _readActionPendingRow(executionId: string): ActionPendingRow | null {
    this._ensureActionPendingTable();
    const rows = this.sql<ActionPendingRow>`
      SELECT execution_id, action_name, tool_call_id, request_id, input_json,
             descriptor_json, created_at
      FROM cf_think_action_pending_approvals
      WHERE execution_id = ${executionId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private _insertActionPendingRow(row: ActionPendingRow): void {
    this._ensureActionPendingTable();
    this.sql`
      INSERT INTO cf_think_action_pending_approvals (
        execution_id, action_name, tool_call_id, request_id, input_json,
        descriptor_json, created_at
      )
      VALUES (
        ${row.execution_id}, ${row.action_name}, ${row.tool_call_id},
        ${row.request_id}, ${row.input_json}, ${row.descriptor_json},
        ${row.created_at}
      )
    `;
  }

  /**
   * Atomically claim a pending-approval row for resolution: read it, then
   * delete it. SQLite calls are synchronous and there is no `await` between the
   * read and the delete, so within the single DO isolate this is race-free — a
   * concurrent `approveExecution`/`rejectExecution` for the same id can only run
   * at an await boundary, by which point the row is already gone (it sees
   * `null` → "already resolved"). The returned row is the caller's to resolve.
   */
  private _claimActionPendingRow(executionId: string): ActionPendingRow | null {
    this._ensureActionPendingTable();
    const row = this._readActionPendingRow(executionId);
    if (!row) return null;
    this.sql`
      DELETE FROM cf_think_action_pending_approvals
      WHERE execution_id = ${executionId}
    `;
    return row;
  }

  private _listActionPendingRows(): ActionPendingRow[] {
    this._ensureActionPendingTable();
    return this.sql<ActionPendingRow>`
      SELECT execution_id, action_name, tool_call_id, request_id, input_json,
             descriptor_json, created_at
      FROM cf_think_action_pending_approvals
      ORDER BY created_at ASC
    `;
  }

  private _deleteActionPendingRows(executionIds: string[]): number {
    let deleted = 0;
    for (let i = 0; i < executionIds.length; i += MAX_BOUND_PARAMS) {
      const batch = executionIds.slice(i, i + MAX_BOUND_PARAMS);
      const strings = buildInClauseStrings(
        "DELETE FROM cf_think_action_pending_approvals WHERE execution_id IN ",
        batch.length
      );
      this.sql(strings, ...batch);
      deleted += batch.length;
    }
    return deleted;
  }

  private async _sweepActionPendingApprovals(options?: {
    force?: boolean;
  }): Promise<{ swept: number }> {
    this._ensureActionPendingTable();
    const ttl = this.actionPendingApprovalTtlMs;
    if (ttl === false) return { swept: 0 };
    const now = Date.now();
    if (!options?.force) {
      const lastSwept =
        (await this.ctx.storage.get<number>(ACTION_PENDING_LAST_SWEPT_KEY)) ??
        0;
      if (now - lastSwept < ACTION_PENDING_SWEEP_INTERVAL_MS) {
        return { swept: 0 };
      }
    }
    const cutoff = now - ttl;
    const rows = this.sql<{ execution_id: string }>`
      SELECT execution_id
      FROM cf_think_action_pending_approvals
      WHERE created_at < ${cutoff}
      ORDER BY created_at ASC
      LIMIT 500
    `;
    const swept = this._deleteActionPendingRows(
      rows.map((row) => row.execution_id)
    );
    await this.ctx.storage.put(ACTION_PENDING_LAST_SWEPT_KEY, now);
    if (swept > 0) {
      this._emitActionPauseEvent({
        type: "action:pause:swept",
        payload: { swept }
      });
    }
    return { swept };
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
    return JSON.stringify(messages.map((message) => this._rowSafe(message)));
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
    if (!this._hasPendingWorkflowNotifications()) return;
    void this.keepAliveWhile(() => this._drainWorkflowNotifications()).catch(
      (error) => {
        console.error("[Think] Failed to drain workflow notifications", error);
        void this._scheduleWorkflowNotificationAlarm();
      }
    );
  }

  private _hasPendingWorkflowNotifications(): boolean {
    this._ensureWorkflowNotificationTable();
    const pending = this.sql<{ notification_id: string }>`
      SELECT notification_id
      FROM cf_think_workflow_notifications
      WHERE delivered_at IS NULL
      LIMIT 1
    `;
    return pending.length > 0;
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

    const idsToDelete = rows
      .filter((row) => this._isTerminalSubmissionStatus(row.status))
      .map((row) => row.submission_id);

    // Batch deletes into `IN (...)` queries within the SQLite 100
    // bound-parameter limit to minimize round-trips during cleanup.
    let deleted = 0;
    for (let i = 0; i < idsToDelete.length; i += MAX_BOUND_PARAMS) {
      const batch = idsToDelete.slice(i, i + MAX_BOUND_PARAMS);
      const strings = buildInClauseStrings(
        "DELETE FROM cf_think_submissions WHERE status IN ('completed', 'aborted', 'skipped', 'error') AND submission_id IN ",
        batch.length
      );
      this.sql(strings, ...batch);
      deleted += batch.length;
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
    // Persist the channel on the user messages so the drained turn re-resolves
    // it from history (the model turn runs later in the submission drain).
    messages = this._stampChannel(messages, options?.channel);
    return this._admitTurn({
      admission: "submit",
      trigger: "submission",
      execute: async () => {
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
    });
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

  private _hasPendingSubmissions(): boolean {
    this._ensureSubmissionTable();
    const pending = this.sql<{ submission_id: string }>`
      SELECT submission_id
      FROM cf_think_submissions
      WHERE status = 'pending'
      LIMIT 1
    `;
    return pending.length > 0;
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
    await this._admitTurn({
      admission: "execute-submission",
      trigger: "submission",
      execute: () => this._executeSubmission(row)
    });
  }

  private async _executeSubmission(row: ThinkSubmissionRow): Promise<void> {
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
          trigger: "submission",
          captureProgrammaticStreamError: true,
          captureOutput: Boolean(workflowPrompt?.output),
          workflowPrompt: workflowPrompt ?? undefined,
          shouldApplyMessages: () =>
            this._readSubmission(row.submission_id)?.status === "running",
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
        const finalized = this._readSubmission(row.submission_id);
        if (finalized && this._isTerminalSubmissionStatus(finalized.status)) {
          this._insertWorkflowNotification(
            this._inspectionFromSubmissionRow(finalized),
            output
          );
        }
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
        const finalized = this._readSubmission(row.submission_id);
        if (finalized && this._isTerminalSubmissionStatus(finalized.status)) {
          this._insertWorkflowNotification(
            this._inspectionFromSubmissionRow(finalized)
          );
        }
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

  /**
   * Add messages to history WITHOUT starting a model turn.
   *
   * Distinct from {@link Think.saveMessages} (which runs a turn) and from
   * AIChatAgent's `persistMessages()` (which replaces/reconciles a flat array):
   * `addMessages` appends or upserts into the Session tree and never enqueues a
   * turn. Because it bypasses the turn queue, it never deadlocks — including
   * when called from inside a tool `execute` during an active turn.
   *
   * Array entries are appended **linearly**: the first attaches under the
   * resolved parent (the latest committed leaf by default, or `parentId`), and
   * each subsequent message attaches under the previous one, so imported history
   * stays a single path rather than a fan-out of siblings. Appends are
   * idempotent by message id; pass `{ mode: "upsert" }` to update an existing
   * message in place instead (upsert never re-parents). Any role may be written;
   * an `assistant` message added this way is inert transcript data (it does not
   * mark a completed turn or trigger auto-continuation).
   *
   * The live message cache stays coherent automatically (the Session keeps it
   * in sync on every write, branches included). Broadcast behaviour depends on
   * whether a turn is running:
   *
   * - **Out of a turn** (the supported pattern — "add context, then run a
   *   turn"): the new messages are broadcast to connected clients immediately
   *   (unless `broadcast: false`).
   * - **Inside a turn** (e.g. from a tool `execute`): no broadcast is sent, so a
   *   full snapshot can't clobber the in-progress streamed message; the injected
   *   messages ride along on the turn's next broadcast. The write is still
   *   durable and visible to the running turn's next sync.
   */
  async addMessages(
    messages:
      | UIMessage[]
      | ((currentMessages: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>),
    options?: AddMessagesOptions
  ): Promise<void> {
    const resolved =
      typeof messages === "function" ? await messages(this.messages) : messages;
    if (resolved.length === 0) return;

    const mode = options?.mode ?? "append";

    // Validate an explicit parentId up front. The Session provider silently
    // falls back to the root for an unknown parent; fail fast instead so a
    // typo'd id surfaces as an error rather than a misattached message.
    if (typeof options?.parentId === "string") {
      const parent = await this.session.getMessage(options.parentId);
      if (!parent) {
        throw new Error(
          `addMessages: parentId "${options.parentId}" does not exist in this session`
        );
      }
    }

    let parentId = options?.parentId;
    for (const message of resolved) {
      const existing = await this.session.getMessage(message.id);
      if (existing) {
        // Append mode is idempotent by id (existing id → no-op); upsert updates
        // the content in place. Neither path re-parents an existing message.
        if (mode === "upsert") await this._updateMessageInHistory(message);
        parentId = message.id;
      } else {
        const stored = await this._appendMessageToHistory(message, parentId);
        parentId = stored.id;
      }
    }

    // The live cache is kept coherent automatically by the Session change
    // listener wired in `onStart` (`internal_onMessagesChanged`), which handles
    // both linear appends and branches (an explicit `parentId` triggers a full
    // resync). So `addMessages` only owns the broadcast — and suppresses it
    // mid-turn: pushing a full `MSG_CHAT_MESSAGES` snapshot while a turn streams
    // would clobber the in-progress assistant message on connected clients (the
    // same reason the streaming path defers its snapshot). The injected messages
    // ride along on the turn's next broadcast.
    if (this._insideInferenceLoop) return;
    if (options?.broadcast !== false) {
      this._broadcastMessages();
    }
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
      shouldApplyMessages?: () => boolean | Promise<boolean>;
      trigger?: TurnTrigger;
      channel?: string;
    }
  ): Promise<ProgrammaticMessagesResult> {
    const clientTools = this._lastClientTools;
    const body = options?.body ?? this._lastBody;
    const epoch = this._turnQueue.generation;
    // Explicit channel wins; otherwise re-resolve from persisted user-message
    // metadata (covers the submission drain replaying stamped messages).
    const channel =
      options?.channel ??
      (Array.isArray(messages)
        ? this._channelFromMessages(messages)
        : undefined);
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;
    let output: unknown;
    let wasAborted = false;

    await this._admitTurn({
      admission: "queue",
      trigger: options?.trigger ?? "programmatic",
      requestId,
      continuation: false,
      channel,
      getStatus: () => status,
      execute: async () => {
        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        if (
          options?.shouldApplyMessages &&
          !(await options.shouldApplyMessages())
        ) {
          status = "aborted";
          return;
        }

        const resolved =
          typeof messages === "function"
            ? await messages(this.messages)
            : messages;

        if (this._turnQueue.generation !== epoch) {
          status = "skipped";
          return;
        }

        if (
          options?.shouldApplyMessages &&
          !(await options.shouldApplyMessages())
        ) {
          status = "aborted";
          return;
        }

        for (const msg of this._stampChannel(resolved, channel)) {
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
            // Bounded compact-and-retry loop (opt-in via
            // `contextOverflow.reactive`), mirroring the WebSocket and chat()
            // paths so programmatic turns (saveMessages / submitMessages /
            // scheduled prompts) recover from a mid-turn overflow too. Each
            // attempt re-runs the same turn (`continuation: false`).
            for (let attempt = 0; ; attempt++) {
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

              if (!result) return;

              let overflowError: string | undefined;
              let overflowRequested = false;
              const overflowRecovery = this._overflowReactiveEnabled
                ? {
                    onRetry: (err?: string) => {
                      overflowRequested = true;
                      overflowError = err;
                    }
                  }
                : undefined;

              const streamResult = await this._streamResult(
                requestId,
                result,
                abortSignal,
                {
                  captureProgrammaticStreamError:
                    options?.captureProgrammaticStreamError,
                  captureOutput: options?.captureOutput,
                  overflowRecovery
                }
              );

              if (overflowRequested) {
                if (
                  attempt < this._overflowMaxRetries &&
                  !abortSignal?.aborted
                ) {
                  const shortened = await this._compactForContextOverflow(
                    "reactive",
                    { requestId, attempt: attempt + 1 }
                  );
                  if (shortened) continue;
                }
                // Budget spent, aborted, or compaction no-op: surface terminally
                // through onChatError (classified). The caller reads status/error.
                error = this._finalizeContextOverflowError(
                  requestId,
                  overflowError
                );
                status = "error";
                return;
              }

              status = streamResult.status;
              error = streamResult.error;
              output = streamResult.output;
              return;
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
      }
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
    options?: SaveMessagesOptions & { trigger?: TurnTrigger; channel?: string }
  ): Promise<SaveMessagesResult> {
    const trigger = options?.trigger ?? "programmatic";
    this._assertNotInsideAdmittedTurn(trigger);
    const lastLeaf = await this.session.getLatestLeaf();
    if (!lastLeaf || lastLeaf.role !== "assistant") {
      return { requestId: "", status: "skipped" };
    }

    const requestId = crypto.randomUUID();
    // If this facet is itself an agent-tool child being recovered, re-bind its
    // run row to this turn's request id so the parent's re-attach tail keeps
    // attributing the continued turn's frames (no-op otherwise).
    this._rebindAgentToolChildRunRequestId(requestId);
    const clientTools = this._lastClientTools;
    const resolvedBody = body ?? this._lastBody;
    const epoch = this._turnQueue.generation;
    // Re-resolve the channel from durable history so a continued/recovered turn
    // re-applies per-channel policy.
    const channel = options?.channel ?? this._channelFromLatestUserMessage();
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;
    let wasAborted = false;

    await this._admitTurn({
      admission: "queue",
      trigger,
      requestId,
      continuation: true,
      channel,
      getStatus: () => status,
      execute: async () => {
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
      }
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
    options?: SaveMessagesOptions & { trigger?: TurnTrigger; channel?: string }
  ): Promise<SaveMessagesResult> {
    const trigger = options?.trigger ?? "recovery-retry";
    this._assertNotInsideAdmittedTurn(trigger);
    const lastLeaf = await this.session.getLatestLeaf();
    if (!lastLeaf || lastLeaf.role !== "user") {
      return { requestId: "", status: "skipped" };
    }

    const requestId = crypto.randomUUID();
    // If this facet is itself an agent-tool child being recovered, re-bind its
    // run row to this turn's request id so the parent's re-attach tail keeps
    // attributing the retried turn's frames (no-op otherwise).
    this._rebindAgentToolChildRunRequestId(requestId);
    const epoch = this._turnQueue.generation;
    // Re-resolve the channel from the persisted user message so a recovered
    // retry re-applies per-channel policy, exactly like `continueLastTurn`. The
    // `metadata.channel` stamp survives the interruption; without this the
    // retried turn would silently fall back to the default policy.
    const channel = options?.channel ?? this._channelFromLatestUserMessage();
    let status: SaveMessagesResult["status"] = "completed";
    let error: string | undefined;
    let wasAborted = false;

    await this._admitTurn({
      admission: "queue",
      trigger,
      requestId,
      continuation: false,
      channel,
      getStatus: () => status,
      execute: async () => {
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
      }
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
        // No active stream. If a turn is accepted but its stream hasn't started
        // yet (#1784), park this connection and tell it to keep waiting (`park`
        // sends the keep-waiting frame; no-op otherwise). Either way send the
        // idle-connect transcript so the client renders the user message it
        // just submitted while it waits for the stream to begin.
        this._preStream.park(connection);
        for (const message of await this._buildIdleConnectMessages()) {
          connection.send(JSON.stringify(message));
        }
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
      this._continuation.releaseConnection(connection.id);
      this._preStream.release(connection.id);
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
        await this._handleStreamResumeRequest(connection);
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
        this._enqueueInteractionApply(() =>
          this._applyToolResult(
            event.toolCallId,
            event.output,
            event.state as "output-error" | undefined,
            event.errorText
          )
        );
        if (event.autoContinue) {
          this._scheduleAutoContinuation(connection);
        } else {
          this._rearmPendingAutoContinuationForBatch();
        }
        break;
      }

      case "tool-approval": {
        this._enqueueInteractionApply(() =>
          this._applyToolApproval(event.toolCallId, event.approved)
        );
        if (event.autoContinue) {
          this._scheduleAutoContinuation(connection);
        } else {
          this._rearmPendingAutoContinuationForBatch();
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
        if (!this._loggedProtocolWarnings.has("client-pushed-messages")) {
          this._loggedProtocolWarnings.add("client-pushed-messages");
          console.warn(
            "[think] Ignoring client-pushed chat messages; Think is " +
              "server-authoritative and does not persist flat transcript " +
              "overwrites. Use @cloudflare/think/react so setMessages stays " +
              "local-only, and use clearHistory() for persisted clears."
          );
        }
        break;
    }
  }

  private async _handleStreamResumeRequest(
    connection: Connection
  ): Promise<void> {
    await this._resumeHandshake().handleResumeRequest(connection);
  }

  private async _handleStreamResumeAck(
    connection: Connection,
    requestId: string
  ): Promise<void> {
    await this._resumeHandshake().handleResumeAck(connection, requestId);
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
    } catch (error) {
      const wrapped = this.onChatError(error, {
        requestId: event.id,
        stage: "parse",
        messagesPersisted: false
      });
      this._emit("chat:request:failed", {
        requestId: event.id,
        stage: "parse",
        messagesPersisted: false,
        error: wrapped instanceof Error ? wrapped.message : String(wrapped)
      });
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
    let messagesPersisted = false;
    let failureStage: ChatErrorContext["stage"] = "persist";

    // ── Concurrency decision (before persisting anything) ────────
    const concurrencyDecision =
      this._getSubmitConcurrencyDecision(isSubmitMessage);

    if (concurrencyDecision.action === "drop") {
      this._rollbackDroppedSubmit(connection);
      this._completeSkippedRequest(connection, requestId);
      return;
    }

    // A genuinely-new turn supersedes any pending terminal record (#1645) so a
    // stale exhaustion can't replay over the resume handshake to a client that
    // reconnects in the window between accepting this submit and the new turn
    // streaming. Mirrors `@cloudflare/ai-chat`; without it a reconnect in that
    // gap would surface the previous failed turn's error even though the user
    // has already moved on. Completion clears it too, but only once the turn
    // resolves — which leaves the gap open.
    await this._clearChatTerminal();

    // Mark this turn as accepted-but-not-yet-streamed (#1784) so a client that
    // reconnects/re-mounts before the stream starts is parked and told to keep
    // waiting (see _resumeHandshake / onConnect), then flushed into
    // STREAM_RESUMING on _startResumableStream or released on settle.
    this._preStream.begin(requestId);

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
      messagesPersisted = true;

      // ── Enter turn queue ────────────────────────────────────────
      failureStage = "turn";
      const abortSignal = this._aborts.getSignal(requestId);

      await this.keepAliveWhile(async () => {
        const turnPromise = this._admitTurn({
          admission: "queue",
          trigger: "ws-chat",
          requestId,
          generation: epoch,
          continuation: false,
          onQueued: releaseIfPending,
          execute: async () => {
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
              // Bounded compact-and-retry loop (opt-in via
              // `contextOverflow.reactive`). A turn that overflows the
              // context window mid-flight is compacted and re-run from the
              // persisted partial instead of dying terminally. Each attempt
              // re-runs the same turn (`continuation: false`) — not an
              // auto-continuation.
              for (let attempt = 0; ; attempt++) {
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

                if (!result) {
                  this._broadcastChat({
                    type: MSG_CHAT_RESPONSE,
                    id: requestId,
                    body: "No response was generated.",
                    done: true
                  });
                  return;
                }

                // The consumer suppresses a classified overflow whenever
                // recovery is enabled; the driver (here) owns the
                // retry-vs-terminal call so every overflow terminal is reported
                // identically.
                let overflowError: string | undefined;
                let overflowRequested = false;
                const overflowRecovery = this._overflowReactiveEnabled
                  ? {
                      onRetry: (error?: string) => {
                        overflowRequested = true;
                        overflowError = error;
                      }
                    }
                  : undefined;

                await this._streamResult(requestId, result, abortSignal, {
                  parentId: branchParentId,
                  overflowRecovery
                });

                if (overflowRequested) {
                  if (
                    attempt < this._overflowMaxRetries &&
                    !abortSignal?.aborted
                  ) {
                    const shortened = await this._compactForContextOverflow(
                      "reactive",
                      { requestId, attempt: attempt + 1 }
                    );
                    // Compaction shortened history → retry. A no-op compaction
                    // can't fix the overflow, so fall through to terminal.
                    if (shortened) continue;
                  }
                  // Budget spent, aborted, or compaction no-op: deliver
                  // terminally (through onChatError, classified) so the turn
                  // never loops or ends silently with no answer.
                  const message = this._finalizeContextOverflowError(
                    requestId,
                    overflowError
                  );
                  this._broadcastChat({
                    type: MSG_CHAT_RESPONSE,
                    id: requestId,
                    body: message,
                    done: true,
                    error: true
                  });
                }
                return;
              }
            };

            if (this.chatRecovery) {
              await this._runChatRecoveryFiber(requestId, false, chatTurnBody);
            } else {
              await chatTurnBody();
            }
          }
        });

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
      const wrapped = this.onChatError(error, {
        requestId,
        stage: failureStage,
        messagesPersisted
      });
      const errorMessage =
        wrapped instanceof Error ? wrapped.message : String(wrapped);
      this._emit("chat:request:failed", {
        requestId,
        stage: failureStage,
        messagesPersisted,
        error: errorMessage
      });
      // Persist the terminal error before broadcasting it: the broadcast is
      // transient, so a client disconnected at this moment (a pre-stream
      // failure like message reconciliation) would otherwise never learn the
      // turn failed and stay frozen on reconnect (see `_buildIdleConnectMessages`).
      await this._recordTerminalChatStatus("error", requestId, errorMessage);
      this._broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: errorMessage,
        done: true,
        error: true
      });
    } finally {
      releaseIfPending();
      this._aborts.remove(requestId);
      // Release any pre-stream parked connections (#1784). No-op when the turn
      // streamed (flushed on _startResumableStream); covers the no-response /
      // pre-stream-failure paths.
      this._settlePreStreamTurn(requestId);
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
    // Tear down the event-driven auto-continuation barrier (#1650): cancel the
    // coalesce timer and clear the double-fire guard so a reset mid-park can't
    // leave a stale flag pinning future continuations.
    this._autoContinuation.reset();
    this._submitConcurrency.reset();
    this._pendingInteractionPromise = null;
    // Drop the apply chain so new interactions don't serialize behind a stale
    // (possibly hung) apply from the turn we just reset (#1649).
    this._interactionApplyTail = Promise.resolve();
    // The streaming turn (if any) is being torn down; stop exposing its
    // accumulator so a late tool result doesn't apply to an abandoned message.
    this._streamingAssistant = null;
    this._continuation.sendResumeNone();
    this._continuation.clearAll();
    this._preStream.releaseAwaiting();
    this._preStream.reset();
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

  /**
   * Stamp the allocated assistant id onto a new turn's `start` chunk so a chat
   * client builds the live-streamed message under the SAME id this agent
   * persists under. Providers that emit no `start.messageId` (e.g. Workers AI)
   * otherwise leave the client to generate its own id; the live stream and the
   * persisted message broadcast then can't reconcile by id, and the originating
   * tab briefly renders the turn twice before collapsing. Mirrors the fix in
   * `@cloudflare/ai-chat`. Continuations are skipped — they reuse the existing
   * assistant message via the `continuation` frame flag, so the id must not
   * change mid-message. The orphan-recovery path inherits the id from the
   * stored chunk, so it needs no separate stamping.
   */
  private _alignStreamStartId(
    chunk: StreamChunkData,
    action: { type: string; messageId?: string } | undefined,
    accumulator: StreamAccumulator,
    continuation: boolean
  ): void {
    if (action?.type === "start" && action.messageId == null && !continuation) {
      (chunk as { messageId?: string }).messageId = accumulator.messageId;
    }
  }

  private _annotateActionApprovalChunk(
    requestId: string,
    chunk: StreamChunkData,
    pendingActionCalls: Map<
      string,
      { toolName: string; input: unknown | undefined }
    >,
    parts?: UIMessage["parts"]
  ): StreamChunkData {
    const toolCallId =
      typeof chunk.toolCallId === "string"
        ? chunk.toolCallId
        : typeof chunk.id === "string"
          ? chunk.id
          : undefined;

    if (toolCallId) {
      if (
        (chunk.type === "tool-input-start" ||
          chunk.type === "tool-input-available" ||
          chunk.type === "tool-call") &&
        typeof chunk.toolName === "string"
      ) {
        const previous = pendingActionCalls.get(toolCallId);
        pendingActionCalls.set(toolCallId, {
          toolName: chunk.toolName,
          input:
            "input" in chunk
              ? normalizeToolInput(chunk.input).input
              : previous?.input
        });
      } else if ("input" in chunk) {
        const previous = pendingActionCalls.get(toolCallId);
        if (previous) {
          pendingActionCalls.set(toolCallId, {
            ...previous,
            input: normalizeToolInput(chunk.input).input
          });
        }
      }
    }

    // A durable pause (durable-pause action OR codemode execution) surfaces as
    // a `tool-output-available` chunk whose output is `status: "paused"`, NOT a
    // `tool-approval-request`. Attach the approval descriptor here so the paused
    // transcript part renders consistently in every approval UI.
    if (chunk.type === "tool-output-available" && toolCallId) {
      const descriptor = this._descriptorForPausedOutput(
        requestId,
        toolCallId,
        (chunk as { output?: unknown }).output
      );
      return descriptor ? { ...chunk, approvalDescriptor: descriptor } : chunk;
    }

    if (chunk.type !== "tool-approval-request" || !toolCallId) return chunk;

    const storedDescriptor =
      this._activeTurnActionApprovalDescriptors.get(toolCallId);
    if (storedDescriptor) {
      return {
        ...chunk,
        approvalDescriptor: storedDescriptor
      };
    }

    let pending = pendingActionCalls.get(toolCallId);
    if (!pending && parts) {
      const part = parts.find(
        (candidate) =>
          "toolCallId" in candidate && candidate.toolCallId === toolCallId
      ) as Record<string, unknown> | undefined;
      if (typeof part?.toolName === "string") {
        pending = {
          toolName: part.toolName,
          input: "input" in part ? normalizeToolInput(part.input).input : {}
        };
      }
    }
    if (!pending) return chunk;

    const metadata = this._activeTurnActionMetadata.get(pending.toolName);
    if (!metadata) return chunk;

    const descriptor: ActionApprovalDescriptor = {
      requestId,
      toolCallId,
      action: metadata.actionName,
      summary: metadata.summary,
      input: pending.input ?? {},
      permissions: metadata.permissions ?? [],
      ...(metadata.risk !== undefined && { risk: metadata.risk }),
      kind: metadata.kind
    };

    return {
      ...chunk,
      approvalDescriptor: descriptor
    };
  }

  /**
   * Build the approval descriptor for a paused tool output, the single source
   * of truth for rendering a pending approval. Durable-pause actions read the
   * descriptor persisted on their pending row (resolved permissions, survives
   * compaction); codemode pauses derive `connector.method` from the first
   * pending action and let {@link describePausedExecution} enrich it. Returns
   * `undefined` for non-paused outputs or when no descriptor can be built.
   */
  private _descriptorForPausedOutput(
    requestId: string,
    toolCallId: string,
    output: unknown
  ): ActionApprovalDescriptor | undefined {
    if (typeof output !== "object" || output === null) return undefined;
    const o = output as {
      status?: unknown;
      executionId?: unknown;
      pending?: unknown;
    };
    if (o.status !== "paused") return undefined;
    const executionId =
      typeof o.executionId === "string" ? o.executionId : undefined;

    if (executionId?.startsWith(ACTION_PAUSE_ID_PREFIX)) {
      const row = this._readActionPendingRow(executionId);
      if (!row?.descriptor_json) return undefined;
      try {
        return JSON.parse(row.descriptor_json) as ActionApprovalDescriptor;
      } catch {
        return undefined;
      }
    }

    const pending = Array.isArray(o.pending)
      ? (o.pending as import("@cloudflare/codemode").PendingAction[])
      : [];
    const first = pending[0];
    if (!first) return undefined;
    const label = `${first.connector}.${first.method}`;
    const base: ActionApprovalDescriptor = {
      requestId,
      toolCallId,
      action: label,
      summary: label,
      input: first.args,
      permissions: [],
      kind: "durable-pause"
    };
    const override = this.describePausedExecution(pending, {
      requestId,
      toolCallId
    });
    if (!override) return base;
    return {
      ...base,
      ...override,
      // Identity fields are ours to set — an override can't retarget the part.
      requestId,
      toolCallId
    };
  }

  private _applyActionApprovalDescriptorToParts(
    chunk: StreamChunkData,
    parts: UIMessage["parts"]
  ): void {
    if (
      (chunk.type !== "tool-approval-request" &&
        chunk.type !== "tool-output-available") ||
      typeof chunk.toolCallId !== "string" ||
      chunk.approvalDescriptor === undefined
    ) {
      return;
    }
    const part = parts.find(
      (candidate) =>
        "toolCallId" in candidate && candidate.toolCallId === chunk.toolCallId
    ) as Record<string, unknown> | undefined;
    if (!part) return;
    if (chunk.type === "tool-approval-request") {
      // A genuine AI SDK approval request: the descriptor rides on the
      // approval object (which also carries the eventual decision).
      part.approval = {
        ...(part.approval as Record<string, unknown> | undefined),
        descriptor: chunk.approvalDescriptor
      };
      return;
    }
    // A durable pause (durable-pause action / codemode) is a SETTLED
    // `output-available` part, not an AI SDK approval. Putting the descriptor
    // on `part.approval` would make `convertToModelMessages` emit a
    // `tool-approval-request` for an already-resolved output on the next turn
    // (an invalid prompt). Use a sibling field conversion ignores instead.
    part.approvalDescriptor = chunk.approvalDescriptor;
  }

  private async _streamResultToRpcCallback(
    requestId: string,
    result: StreamableResult,
    callback: StreamCallback,
    abortSignal?: AbortSignal,
    options?: {
      /**
       * When set, an in-stream error the app classifies as `context_overflow`
       * is treated as recoverable: the partial is persisted, the stream is
       * finalized cleanly (no terminal error to the caller), and
       * `{ status: "overflow_retry" }` is returned so the driver can compact
       * and re-run. Pass only while the retry budget allows.
       */
      overflowRecovery?: boolean;
    }
  ): Promise<{
    status: "completed" | "error" | "aborted" | "overflow_retry";
    error?: string;
  }> {
    const streamId = this._startResumableStream(requestId);
    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID()
    });
    // Expose the in-flight message so a client tool result arriving before the
    // end-of-stream persist lands on the accumulator instead of being dropped
    // (#1649). Cleared in the `finally` below.
    this._streamingAssistant = accumulator;

    let streamFinalized = false;
    let assistantMsg: UIMessage | null = null;
    let aborted = false;
    let doneSent = false;
    let streamError: string | undefined;
    let pendingRpcError: string | undefined;
    // When a stall-recovery early-return schedules a continuation, the
    // continuation re-runs the turn and its own stream finalize re-triggers the
    // held barrier. Re-arming here too would let the 50ms coalesce timer fire a
    // SECOND continuation alongside the scheduled recovery one — a spurious
    // double model invocation. Mirror the WebSocket `_streamResult` recovery
    // paths and clear `_streamingAssistant` WITHOUT re-arming in that case.
    let skipFinalizeRearm = false;
    // Set when an in-stream overflow error is recoverable (opt-in): suppresses
    // terminal delivery so the driver can compact and re-run the turn.
    let overflowRetry = false;

    const stallTimeoutMs =
      this._activeStallTimeoutMs ?? this.chatStreamStallTimeoutMs;
    try {
      this._insideInferenceLoop = true;
      const flushState = { chunksSinceFlush: 0, hasFlushedContent: false };
      const pendingActionCalls = new Map<
        string,
        { toolName: string; input: unknown | undefined }
      >();
      try {
        const guardedStream = iterateWithStallWatchdog(
          result.toUIMessageStream({ onError: streamErrorToString }),
          stallTimeoutMs,
          () => {
            this._emit("chat:stream:stalled", {
              requestId,
              timeoutMs: stallTimeoutMs
            });
            this.abortRequest(
              requestId,
              new Error("chat stream stalled: inactivity watchdog fired")
            );
          }
        );
        for await (const chunk of guardedStream) {
          if (abortSignal?.aborted) {
            aborted = true;
            break;
          }

          // RPC callbacks receive serialized UIMessage chunks directly; unlike
          // the WebSocket protocol, there is no wrapper frame to rewrite for
          // accumulator actions such as `error`.
          const streamChunk = this._annotateActionApprovalChunk(
            requestId,
            chunk as unknown as StreamChunkData,
            pendingActionCalls,
            accumulator.parts
          );
          const { action } = accumulator.applyChunk(streamChunk);
          this._applyActionApprovalDescriptorToParts(
            streamChunk,
            accumulator.parts
          );

          if (action?.type === "error") {
            streamError = action.error;
            // Recoverable context overflow (opt-in): don't terminalize. Persist
            // the partial after the loop, then signal the driver to compact and
            // re-run. No `message:error`/`chat:request:failed`/error frame here
            // — the turn isn't over.
            if (
              options?.overflowRecovery &&
              this._isRecoverableContextOverflow(streamError, requestId)
            ) {
              overflowRetry = true;
              break;
            }
            this._emit("message:error", { error: streamError });
            // An AI-SDK error surfaces as a stream error part (not a thrown
            // exception), so it lands here rather than in the `catch` below.
            // Bridge it to `chat:request:failed` too — observers shouldn't have
            // to know whether the failure threw or arrived as a chunk (the
            // post-`beforeTurn`, in-stream provider 400 class), and turn-count
            // telemetry needs the failed signal to balance `turn.started`.
            this._emit("chat:request:failed", {
              requestId,
              stage: "stream",
              messagesPersisted: true,
              error: streamError
            });
            this._broadcastChat({
              type: MSG_CHAT_RESPONSE,
              id: requestId,
              body: action.error,
              done: false,
              error: true
            });
            break;
          }

          this._alignStreamStartId(streamChunk, action, accumulator, false);

          const chunkBody = JSON.stringify(streamChunk);
          await this._storeChunkDurably(
            streamId,
            streamChunk,
            chunkBody,
            flushState
          );
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

      // Recoverable context overflow: discard the partial, close the stream
      // cleanly without a terminal error, and hand control back to the driver.
      // No `onDone`/`onError` and no response hook — the turn is not finished;
      // the retry owns the terminal outcome.
      //
      // The partial is intentionally NOT persisted: the driver re-runs the turn
      // from scratch (`continuation: false`) against the compacted history, so
      // the retry produces a fresh assistant message. Persisting the truncated
      // partial would leave an orphan beside the recovered answer — and any tool
      // work it captured would be re-issued by the retry, duplicating records.
      // The live-streamed chunks already reached clients; the driver's
      // post-retry `_broadcastMessages()` reconciles them to the real answer.
      if (overflowRetry) {
        this._completeResumableStream(streamId);
        streamFinalized = true;
        return { status: "overflow_retry", error: streamError };
      }

      if (streamError) {
        this._errorResumableStream(streamId);
      } else {
        this._completeResumableStream(streamId);
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
      // #1626: a stream-stall watchdog abort is a recoverable interruption, not
      // a terminal error. Persist the settled partial (re-anchor), route into
      // bounded recovery, and suppress the terminal error when a continuation is
      // scheduled; fall through to terminal only once the budget is exhausted.
      if (error instanceof ChatStreamStalledError) {
        if (!assistantMsg && accumulator.parts.length > 0) {
          assistantMsg = accumulator.toMessage();
          await this._persistAssistantMessage(assistantMsg);
          this._broadcastMessages();
        }
        const outcome = await this._routeStallToBoundedRecovery({
          requestId,
          streamId,
          partialParts: (assistantMsg ?? accumulator.toMessage()).parts,
          targetAssistantId: assistantMsg?.id
        });
        if (outcome === "scheduled") {
          if (!streamFinalized) {
            this._completeResumableStream(streamId);
            streamFinalized = true;
          }
          if (!doneSent) {
            this._broadcastChat({
              type: MSG_CHAT_RESPONSE,
              id: requestId,
              body: "",
              done: true
            });
            doneSent = true;
          }
          // The scheduled continuation (a later isolate invocation, without this
          // callback) owns the real terminal outcome. Signal the interruption so
          // the caller doesn't read this clean resolve as success and finalize a
          // truncated partial (#1644); NOT onDone/onError — see `onInterrupted`.
          skipFinalizeRearm = true;
          await callback.onInterrupted?.();
          return { status: "aborted" };
        }
        if (outcome === "exhausted") {
          // `_routeStallToBoundedRecovery` already delivered the terminal UX
          // (configured `terminalMessage` + done/error frame + `onExhausted` +
          // submission interrupted), identical to deploy-recovery exhaustion.
          // Finalize the stream and return WITHOUT the generic terminal path,
          // which would otherwise re-broadcast the raw stall error.
          if (!streamFinalized) {
            this._errorResumableStream(streamId);
            streamFinalized = true;
          }
          doneSent = true;
          // Exhaustion is terminal for the turn, but it was delivered out-of-band
          // by `_exhaustChatRecovery` (banner/`onExhausted`), NOT through this
          // callback's `onError`. Signal the interruption so a `chat()` consumer
          // doesn't mis-read the clean resolve as a successful completion (#1644).
          skipFinalizeRearm = true;
          await callback.onInterrupted?.();
          return { status: "aborted" };
        }
        // outcome === "disabled" (chat recovery off): fall through to the
        // generic terminal path below (unchanged watchdog behavior).
      }
      if (!streamFinalized) {
        this._errorResumableStream(streamId);
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

      const wrapped = this.onChatError(error, {
        requestId,
        stage: "stream",
        messagesPersisted: true
      });
      const errorMessage =
        wrapped instanceof Error ? wrapped.message : String(wrapped);
      this._emit("chat:request:failed", {
        requestId,
        stage: "stream",
        messagesPersisted: true,
        error: errorMessage
      });

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
    } finally {
      // The message is now durably persisted (success, error, or recovery
      // path), so subsequent tool results resolve against storage; stop
      // exposing the sealed accumulator (#1649) and re-check any continuation
      // the stream-active barrier held (#1650). A stall-recovery early-return
      // does a plain clear instead (no re-arm): its scheduled continuation
      // re-runs the turn and that finalize re-triggers the held barrier, so
      // re-arming here would double-fire alongside the recovery continuation.
      if (skipFinalizeRearm) {
        this._streamingAssistant = null;
      } else {
        this._onStreamingTurnFinalized();
      }
    }

    if (pendingRpcError) {
      await callback.onError(pendingRpcError);
    }

    return {
      status:
        streamError || pendingRpcError
          ? "error"
          : aborted
            ? "aborted"
            : "completed"
    };
  }

  /**
   * Whether storing this chunk should immediately flush the resumable-stream
   * buffer to SQLite.
   *
   * A settled tool result (`tool-output-available` / `tool-output-error` /
   * `tool-output-denied`) captures a completed, often non-idempotent side
   * effect — or, for a denial, a user decision — so it is flushed
   * **immediately**. An isolate eviction (deploy) before the next batch flush
   * would otherwise lose it, and recovery would re-anchor without it and re-run
   * the already-completed tool call (or drop the denial). Frequent recoverable
   * content (text / reasoning / tool-input streaming) is throttled to avoid
   * write amplification.
   */
  private _shouldFlushRecoverableChunk(
    chunk: StreamChunkData,
    chunksSinceFlush: number,
    hasFlushedContent: boolean
  ): boolean {
    if (
      chunk.type === "tool-output-available" ||
      chunk.type === "tool-output-error" ||
      chunk.type === "tool-output-denied"
    ) {
      return true;
    }
    const isThrottledRecoverable =
      chunk.type === "text-delta" ||
      chunk.type === "reasoning-delta" ||
      chunk.type === "tool-input-available";
    return (
      isThrottledRecoverable && (!hasFlushedContent || chunksSinceFlush >= 10)
    );
  }

  /**
   * Store a stream chunk, flushing settled tool results durably and promptly.
   * Shared by the WebSocket and sub-agent RPC streaming paths so both get
   * tool-call-level recovery durability (recovery loses at most the in-flight
   * step, never an already-completed tool call).
   */
  private async _storeChunkDurably(
    streamId: string,
    chunk: StreamChunkData,
    chunkBody: string,
    state: { chunksSinceFlush: number; hasFlushedContent: boolean }
  ): Promise<void> {
    this._resumableStream.storeChunk(streamId, chunkBody);
    state.chunksSinceFlush++;
    if (
      this._shouldFlushRecoverableChunk(
        chunk,
        state.chunksSinceFlush,
        state.hasFlushedContent
      )
    ) {
      this._resumableStream.flushBuffer();
      state.chunksSinceFlush = 0;
      state.hasFlushedContent = true;
    }
    // Forward progress: advance the monotonic, compaction-immune progress
    // counter HERE (production time) rather than in `_persistOrphanedStream` —
    // so it bumps only on genuinely new content and is immune to client
    // reconnects / recovery re-persists (which don't flow through this path).
    // Decoupled from the flush decision and routed through the shared
    // host-agnostic rule ({@link shouldCreditStreamProgress}) so the bump TIMING
    // matches `AIChatAgent`: a milestone (started segment / settled tool) always
    // credits, and a long single segment's streaming deltas credit through a
    // time throttle. This is what the recovery no-progress window keys off
    // (#1637), and stays compaction-proof (#1628).
    if (
      shouldCreditStreamProgress({
        codec: aiSdkRecoveryCodec,
        type: chunk.type,
        throttle: this._streamProgressCredit,
        now: Date.now()
      })
    ) {
      await this._bumpChatRecoveryProgress();
    }
  }

  /** Per-isolate throttle for crediting recovery progress from mid-segment
   *  streaming-content deltas (the shared `agents/chat` rule); reset per isolate
   *  so the first delta after a restart always credits. */
  private _streamProgressCredit = new StreamProgressCreditThrottle();

  private async _streamResult(
    requestId: string,
    result: StreamableResult,
    abortSignal?: AbortSignal,
    options?: {
      continuation?: boolean;
      parentId?: string;
      captureProgrammaticStreamError?: boolean;
      captureOutput?: boolean;
      /**
       * When set, an in-stream error the app classifies as `context_overflow`
       * is treated as recoverable: the partial is persisted, the stream is
       * finalized cleanly (no terminal error frame), `onRetry(error)` is invoked
       * so the driver can compact and re-run, and `{ status: "aborted" }` is
       * returned. Pass only while the retry budget allows.
       */
      overflowRecovery?: { onRetry: (error?: string) => void };
    }
  ): Promise<StreamResultStatus> {
    const clearGen = this._turnQueue.generation;
    const streamId = this._startResumableStream(requestId);
    const continuation = options?.continuation ?? false;
    const parentId = options?.parentId;

    if (this._continuation.pending?.requestId === requestId) {
      this._continuation.activatePending();
      this._continuation.flushAwaitingConnections((c) =>
        this._notifyStreamResuming(c)
      );
    }

    const accumulator = new StreamAccumulator({
      messageId: crypto.randomUUID()
    });
    // Expose the in-flight message so a client tool result arriving before the
    // end-of-stream persist lands on the accumulator instead of being dropped
    // (#1649). Cleared before every return path below.
    this._streamingAssistant = accumulator;

    let doneSent = false;
    let streamAborted = false;
    let streamError: string | undefined;
    let output: unknown;
    // Set when an in-stream overflow error is recoverable (opt-in): suppresses
    // terminal delivery so the driver can compact and re-run the turn.
    let overflowRetry = false;
    const flushState = { chunksSinceFlush: 0, hasFlushedContent: false };
    const pendingActionCalls = new Map<
      string,
      { toolName: string; input: unknown | undefined }
    >();

    const stallTimeoutMs =
      this._activeStallTimeoutMs ?? this.chatStreamStallTimeoutMs;
    try {
      this._insideInferenceLoop = true;
      try {
        const guardedStream = iterateWithStallWatchdog(
          result.toUIMessageStream({ onError: streamErrorToString }),
          stallTimeoutMs,
          () => {
            this._emit("chat:stream:stalled", {
              requestId,
              timeoutMs: stallTimeoutMs
            });
            // Tear down the upstream model stream so a hung provider/transport
            // is released; the watchdog's throw drives the terminal error below.
            this.abortRequest(
              requestId,
              new Error("chat stream stalled: inactivity watchdog fired")
            );
          }
        );
        for await (const chunk of guardedStream) {
          if (abortSignal?.aborted) {
            streamAborted = true;
            break;
          }

          const streamChunk = this._annotateActionApprovalChunk(
            requestId,
            chunk as unknown as StreamChunkData,
            pendingActionCalls,
            accumulator.parts
          );
          const { action } = accumulator.applyChunk(streamChunk);
          this._applyActionApprovalDescriptorToParts(
            streamChunk,
            accumulator.parts
          );

          // Approved server tools execute during a continuation stream, but
          // their original tool part lives in an earlier assistant message.
          // The accumulator can only own this turn's new content, so it
          // surfaces a terminal result for a prior message as a
          // `cross-message-tool-update`. Persist + broadcast it directly so
          // the approved result reaches clients and durable storage. The
          // update builder is first-write-wins (replay-safe) and preserves a
          // streamed `preliminary` flag; `_applyToolUpdateToMessages` skips
          // the write/broadcast when the matched part is already settled.
          if (action?.type === "cross-message-tool-update") {
            await this._applyToolUpdateToMessages(
              crossMessageToolResultUpdate(
                action.toolCallId,
                action.updateType,
                action.output,
                action.errorText,
                action.preliminary
              )
            );
          }

          if (action?.type === "error") {
            streamError = action.error;
            // Recoverable context overflow (opt-in): don't terminalize. Persist
            // the partial after the loop, then signal the driver to compact and
            // re-run. No `message:error`/`chat:request:failed`/error frame here.
            if (
              options?.overflowRecovery &&
              this._isRecoverableContextOverflow(streamError, requestId)
            ) {
              overflowRetry = true;
              break;
            }
            if (options?.captureProgrammaticStreamError) {
              this._programmaticStreamErrors.set(requestId, streamError);
            }
            this._emit("message:error", { error: streamError });
            // An AI-SDK error surfaces as a stream error part (not a thrown
            // exception), so it lands here rather than in the `catch` below.
            // Bridge it to `chat:request:failed` too — observers shouldn't have
            // to know whether the failure threw or arrived as a chunk (the
            // post-`beforeTurn`, in-stream provider 400 class), and turn-count
            // telemetry needs the failed signal to balance `turn.started`.
            this._emit("chat:request:failed", {
              requestId,
              stage: "stream",
              messagesPersisted: true,
              error: streamError
            });
            this._broadcastChat({
              type: MSG_CHAT_RESPONSE,
              id: requestId,
              body: action.error,
              done: false,
              error: true,
              ...(continuation && { continuation: true })
            });
            break;
          }

          this._alignStreamStartId(
            streamChunk,
            action,
            accumulator,
            continuation
          );

          const chunkBody = JSON.stringify(streamChunk);
          await this._storeChunkDurably(
            streamId,
            streamChunk,
            chunkBody,
            flushState
          );
          this._broadcastChat({
            type: MSG_CHAT_RESPONSE,
            id: requestId,
            body: chunkBody,
            done: false,
            ...(continuation && { continuation: true })
          });
        }
      } finally {
        this._insideInferenceLoop = false;
      }

      // Recoverable context overflow: discard the partial, close this stream
      // segment WITHOUT a terminal frame, and hand control back to the driver
      // via `onRetry`. The inline retry runs in this same invocation and owns
      // the terminal outcome, so we must NOT emit a `done` frame here — and
      // `doneSent = true` keeps the outer `finally` from emitting one (it would
      // otherwise prematurely terminate the client's stream mid-recovery and
      // mark the segment errored).
      //
      // The partial is intentionally NOT persisted: the driver re-runs the turn
      // from scratch (`continuation: false`) against the compacted history, so
      // the retry produces a fresh assistant message. Persisting the truncated
      // partial would leave an orphan beside the recovered answer — and any tool
      // work it captured would be re-issued by the retry, duplicating records.
      // The live-streamed chunks already reached clients; the retry's
      // `_broadcastMessages()` reconciles them to the real answer.
      if (overflowRetry && options?.overflowRecovery) {
        this._completeResumableStream(streamId);
        this._pendingResumeConnections.clear();
        doneSent = true;
        options.overflowRecovery.onRetry(streamError);
        this._streamingAssistant = null;
        return { status: "aborted" };
      }

      if (streamError) {
        this._errorResumableStream(streamId);
      } else {
        this._completeResumableStream(streamId);
      }
      this._pendingResumeConnections.clear();
      this._broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: "",
        done: true,
        ...(continuation && { continuation: true })
      });
      doneSent = true;
    } catch (error) {
      // #1626: a stream-stall watchdog abort is a recoverable interruption, not
      // a terminal error. Persist the settled partial (so the continuation
      // re-anchors without re-running completed tool calls), then route into
      // bounded recovery; only fall through to the terminal path below once the
      // budget is exhausted.
      if (error instanceof ChatStreamStalledError) {
        let targetAssistantId: string | undefined;
        const partialMsg = accumulator.toMessage();
        if (
          this._turnQueue.generation === clearGen &&
          accumulator.parts.length > 0
        ) {
          await this._persistAssistantMessage(partialMsg, parentId);
          this._broadcastMessages();
          targetAssistantId = partialMsg.id;
        }
        const outcome = await this._routeStallToBoundedRecovery({
          requestId,
          streamId,
          partialParts: partialMsg.parts,
          targetAssistantId
        });
        if (outcome === "scheduled") {
          // Recovering: close the stream cleanly (no terminal error frame); the
          // scheduled continuation drives the turn to completion. Report
          // `aborted` so the caller does not terminalize the turn.
          this._completeResumableStream(streamId);
          this._pendingResumeConnections.clear();
          if (!doneSent) {
            this._broadcastChat({
              type: MSG_CHAT_RESPONSE,
              id: requestId,
              body: "",
              done: true,
              ...(continuation && { continuation: true })
            });
            doneSent = true;
          }
          // `aborted` (not `error`): this attempt was aborted by the watchdog;
          // the scheduled continuation owns the real terminal outcome. No
          // response hook fires here (the continuation fires it), mirroring how
          // a deploy-interrupted attempt is superseded by its continuation.
          // Plain clear (no auto-continuation re-check): recovery re-runs the
          // turn and its own stream finalize re-triggers the held barrier.
          this._streamingAssistant = null;
          return { status: "aborted" };
        }
        if (outcome === "exhausted") {
          // `_routeStallToBoundedRecovery` already delivered the terminal UX
          // (configured `terminalMessage` + done/error frame + `onExhausted` +
          // submission interrupted), identical to deploy-recovery exhaustion.
          // Finalize the stream and report `aborted` (not `error`) so the caller
          // does not re-run the generic terminal path on top of it.
          this._errorResumableStream(streamId);
          this._pendingResumeConnections.clear();
          doneSent = true;
          this._streamingAssistant = null;
          return { status: "aborted" };
        }
        // outcome === "disabled" (chat recovery off): fall through to the
        // generic terminal path (the watchdog's original "kill the spinner"
        // guarantee, unchanged).
      }
      streamError = error instanceof Error ? error.message : "Stream error";
      if (options?.captureProgrammaticStreamError) {
        this._programmaticStreamErrors.set(requestId, streamError);
      }
      this._errorResumableStream(streamId);
      this._pendingResumeConnections.clear();
      if (!doneSent) {
        this._broadcastChat({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: streamError,
          done: true,
          error: true,
          ...(continuation && { continuation: true })
        });
        doneSent = true;
      }
    } finally {
      if (!doneSent) {
        this._errorResumableStream(streamId);
        this._pendingResumeConnections.clear();
        this._broadcastChat({
          type: MSG_CHAT_RESPONSE,
          id: requestId,
          body: "",
          done: true,
          ...(continuation && { continuation: true })
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

    // The message is now persisted (or the turn was cleared), so subsequent
    // tool results resolve against storage; stop exposing the accumulator and
    // re-check any continuation the stream-active barrier held (#1650).
    this._onStreamingTurnFinalized();

    return streamError
      ? { status: "error", error: streamError }
      : {
          status: streamAborted ? "aborted" : "completed",
          ...(output !== undefined && { output })
        };
  }

  // ── Session-backed persistence ──────────────────────────────────

  /**
   * Single source of Think's strip + empty-skip persistence rule. Strips the
   * internal final-answer parts and returns the message to persist (the stripped
   * copy, or the original when nothing was stripped), or `null` when stripping
   * leaves nothing user-facing (only structural `step-start` markers, or
   * nothing) — in which case the caller skips persistence so a structured
   * workflow turn does not leave an empty assistant message in the conversation.
   * Shared by `_persistAssistantMessage` and the orphan-persist path so the rule
   * cannot drift between the live and recovery writes.
   */
  private _strippedForPersist(msg: UIMessage): UIMessage | null {
    const stripped = this._stripInternalFinalAnswerParts(msg);
    if (stripped === msg) return msg;
    const hasMeaningfulParts = stripped.parts.some(
      (part) => (part as { type?: string }).type !== "step-start"
    );
    return hasMeaningfulParts ? stripped : null;
  }

  private async _persistAssistantMessage(
    msg: UIMessage,
    parentId?: string
  ): Promise<void> {
    const toPersist = this._strippedForPersist(msg);
    if (toPersist === null) return;
    await this._upsertMessageInHistory(toPersist, parentId);
  }

  /**
   * Remove parts belonging to Think's internal structured-output final-answer
   * tool (`think_final_answer`, or a collision-suffixed variant) from a UI
   * message so the internal call/result never enters the persisted conversation
   * (and is never re-fed to the model on later turns). Stateless and matched by
   * the reserved name so it also covers recovery re-persist paths. Handles both
   * the static (`tool-<name>`) and dynamic (`dynamic-tool`) part shapes the AI
   * SDK can emit.
   */
  private _stripInternalFinalAnswerParts(msg: UIMessage): UIMessage {
    const parts = msg.parts.filter((part) => {
      const candidate = part as { type?: string; toolName?: string };
      if (
        typeof candidate.type === "string" &&
        candidate.type.startsWith("tool-") &&
        isThinkFinalAnswerToolName(candidate.type.slice("tool-".length))
      ) {
        return false;
      }
      if (
        candidate.type === "dynamic-tool" &&
        typeof candidate.toolName === "string" &&
        isThinkFinalAnswerToolName(candidate.toolName)
      ) {
        return false;
      }
      return true;
    });
    return parts.length === msg.parts.length ? msg : { ...msg, parts };
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

  /**
   * Serialize a client-tool result/approval apply behind any in-flight apply
   * (#1649). Parallel tool results arrive as independent WebSocket messages,
   * and each apply is a read-modify-write of the full message in durable
   * storage. Running them concurrently means every apply reads the same
   * snapshot (all siblings still `input-available`), patches only its own part,
   * and writes the whole message back — so the last write clobbers the others
   * back to `input-available`, and the auto-continuation barrier later times
   * out and the transcript-repair backstop errors the lost siblings.
   *
   * Chaining each apply off `_interactionApplyTail` makes the read-modify-write
   * atomic per result and in arrival order. `_pendingInteractionPromise` is set
   * to the newest link so the barrier's single-slot wake-up still observes the
   * latest apply; because the chain is serial, awaiting it transitively waits
   * for every predecessor.
   *
   * @internal
   */
  protected _enqueueInteractionApply(
    apply: () => Promise<void>
  ): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      await apply();
      return true;
    };
    // `.then(run, run)` runs regardless of a predecessor's outcome so one
    // rejected apply can't poison the rest of the batch.
    const resultPromise = this._interactionApplyTail.then(run, run);
    this._interactionApplyTail = resultPromise.then(
      () => undefined,
      () => undefined
    );
    this._pendingInteractionPromise = resultPromise;
    resultPromise
      .finally(() => {
        if (this._pendingInteractionPromise === resultPromise) {
          this._pendingInteractionPromise = null;
        }
      })
      .catch(() => {});
    return resultPromise;
  }

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

  // ── Durable execution approvals (codemode HITL) ──────────────────
  //
  // A `requiresApproval` connector call inside the execute tool pauses the
  // run *durably*: the tool returns `{ status: "paused", executionId,
  // pending }` as a normal output, the model narrates what it needs, and the
  // turn ends. These callables are the resume path: approve/reject the
  // pending action on the codemode runtime, replace the paused output in the
  // transcript with the new outcome, and auto-continue so the model sees it.

  /**
   * The codemode runtime handle behind the execute tool. `this.codemode` is
   * assigned when `createExecuteRuntime(this)` / `createExecuteTool(this)`
   * runs (normally at turn start, via `getTools()`); after a DO restart no
   * turn may have run yet, so fall back to building the tools once.
   */
  private _codemodeRuntime():
    | import("@cloudflare/codemode").CodemodeRuntimeHandle
    | undefined {
    if (!this.codemode) {
      try {
        this.getTools();
      } catch {
        // getTools may require turn-time context; without it there is
        // simply no runtime to resolve.
      }
    }
    return this.codemode;
  }

  /**
   * Pending (awaiting-approval) actions across paused executions of the
   * execute tool's codemode runtime — `{ executionId, seq, connector,
   * method, args }` each, with FULL args (the transcript copy is truncated).
   * Clients reconcile approval cards against this on load.
   *
   * Client-callable (registered below — see the `callable()` calls after the
   * class body).
   */
  async pendingExecutions(
    executionId?: string
  ): Promise<import("@cloudflare/codemode").PendingAction[]> {
    const runtime = this._codemodeRuntime();
    if (!runtime) return [];
    return runtime.pending(executionId);
  }

  /**
   * List everything awaiting human approval — parked `kind: "durable-pause"`
   * actions and paused codemode executions — each carrying its
   * {@link ActionApprovalDescriptor}. The unified, descriptor-first view a
   * dashboard, voice backend, or messenger reconciles against; resolve any of
   * them via {@link approveExecution} / {@link rejectExecution}. Pass an
   * `executionId` to scope to one.
   *
   * Client-callable.
   */
  async pendingApprovals(executionId?: string): Promise<PendingApproval[]> {
    const out: PendingApproval[] = [];

    for (const row of this._listActionPendingRows()) {
      if (executionId && row.execution_id !== executionId) continue;
      if (!row.descriptor_json) continue;
      let descriptor: ActionApprovalDescriptor;
      try {
        descriptor = JSON.parse(
          row.descriptor_json
        ) as ActionApprovalDescriptor;
      } catch {
        continue;
      }
      out.push({
        executionId: row.execution_id,
        source: "action",
        descriptor
      });
    }

    const runtime = this._codemodeRuntime();
    if (runtime) {
      const pending = await runtime.pending(executionId);
      const seen = new Set<string>();
      for (const action of pending) {
        if (seen.has(action.executionId)) continue;
        seen.add(action.executionId);
        const group = pending.filter(
          (candidate) => candidate.executionId === action.executionId
        );
        const toolCallId =
          this._findExecutionToolCall(action.executionId) ?? "";
        const descriptor = this._descriptorForPausedOutput("", toolCallId, {
          status: "paused",
          executionId: action.executionId,
          pending: group
        });
        if (descriptor) {
          out.push({
            executionId: action.executionId,
            source: "codemode",
            descriptor
          });
        }
      }
    }

    return out;
  }

  /**
   * Approve a paused execution and resume it. The run continues from where
   * it stopped (replaying logged work, executing the approved call); the
   * outcome — completed, errored, or paused again on the NEXT gated call —
   * replaces the paused tool output in the transcript and the chat
   * auto-continues so the model can act on it.
   *
   * Approving an execution that is no longer pending (already settled,
   * expired, or unknown) returns `{ status: "error" }` with an explanatory
   * message — it never throws.
   *
   * Client-callable.
   */
  async approveExecution(executionId: string): Promise<unknown> {
    // Durable-pause action approvals own the `actpause_` id space and resolve
    // against the pending-approval store, not the codemode runtime.
    if (executionId.startsWith(ACTION_PAUSE_ID_PREFIX)) {
      return await this._approveActionPause(executionId);
    }
    const runtime = this._codemodeRuntime();
    if (!runtime) {
      return {
        status: "error",
        executionId,
        error:
          "No codemode runtime is configured — the execute tool was never " +
          "created on this agent."
      };
    }
    const output = truncatePausedExecutionOutput(
      await runtime.approve({ executionId })
    );
    await this._applyExecutionOutcome(executionId, output);
    return output;
  }

  /**
   * Approve a parked `kind: "durable-pause"` action and run its `execute`.
   *
   * Claim-by-delete makes this idempotent across tabs/recovery: only the caller
   * that removes the row runs the action; a racing approve/reject sees no row
   * and reports "already resolved". Authorization happened at PAUSE time — the
   * human approval is the authority now, so we do not re-authorize (the turn
   * context that `authorizeAction` needs is gone). The action runs through the
   * ledger so its side effect stays replay-safe, the outcome replaces the
   * paused transcript part, and the chat continues even with no socket open.
   */
  private async _approveActionPause(executionId: string): Promise<unknown> {
    const row = this._claimActionPendingRow(executionId);
    if (!row) {
      return {
        status: "error",
        executionId,
        error: `Execution "${executionId}" is no longer pending — it was approved or rejected elsewhere.`
      };
    }

    const action = await this._findRegisteredAction(row.action_name);
    if (!action) {
      const output = {
        status: "error",
        executionId,
        action: row.action_name,
        error:
          `Action "${row.action_name}" is no longer registered, so the ` +
          `approved call cannot run. The approval was consumed.`
      };
      await this._applyExecutionOutcome(executionId, output);
      return output;
    }

    let input: unknown;
    try {
      input = JSON.parse(row.input_json);
    } catch {
      input = {};
    }

    const output = await this._runApprovedActionPause(action, row, input);
    this._emitActionPauseEvent({
      type: "action:pause:approved",
      payload: { action: row.action_name, executionId }
    });
    await this._applyExecutionOutcome(executionId, output);
    return output;
  }

  /** Resolve a registered action by its resolved name (config.name ?? key). */
  private async _findRegisteredAction(name: string): Promise<Action | null> {
    const actions = await this.getActions();
    for (const [registrationName, candidate] of Object.entries(actions)) {
      if (!isAction(candidate)) continue;
      const resolved = candidate.config.name ?? registrationName;
      if (resolved === name) return candidate;
    }
    return null;
  }

  /**
   * Run a just-approved durable-pause action's `execute` through the ledger.
   * Mirrors the inline `_actionToTool` execute wrapper (timeout, abort race,
   * model-output prep) MINUS authorization — that was settled at pause time.
   */
  private async _runApprovedActionPause(
    action: Action,
    row: ActionPendingRow,
    input: unknown
  ): Promise<unknown> {
    const config = action.config;
    const executeAction = config.execute as (
      input: unknown,
      ctx: ActionContext
    ) => Promise<unknown> | unknown;
    const idempotencyKey = config.idempotencyKey as
      | ActionIdempotencyKey<unknown>
      | undefined;
    const { signal, cleanup } = createActionAbortSignal(
      undefined,
      config.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS
    );
    const ctx: ActionContext = {
      agent: this,
      env: this.env as Cloudflare.Env,
      requestId: row.request_id ?? "",
      toolCallId: row.tool_call_id,
      messages: [],
      signal,
      // No-op: a durable-pause approved action is delivered by a later
      // continuation turn (different requestId), so a same-turn attachment
      // can't be delivered in v1.
      attachReply: () => {}
    };
    const abortError = () =>
      signal.reason instanceof Error
        ? signal.reason
        : new Error(signal.reason ? String(signal.reason) : "Action aborted");
    let onAbort: (() => void) | undefined;
    try {
      if (signal.aborted) throw abortError();
      const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const runAction = async () => {
        const out = await Promise.race([
          Promise.resolve(executeAction(input, ctx)),
          abortPromise
        ]);
        return prepareActionOutputForModel(out);
      };
      return await this._runLedgeredAction({
        toolName: row.action_name,
        idempotencyKey,
        input,
        ctx,
        runAction
      });
    } catch (error) {
      return actionErrorEnvelope(error);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
      cleanup();
    }
  }

  /**
   * Reject a paused execution's pending action, ending the run. The
   * transcript's paused output is replaced with
   * `{ status: "rejected", executionId, reason }` and the chat
   * auto-continues so the model can adapt (or explain) instead of erroring.
   *
   * Client-callable.
   */
  async rejectExecution(
    executionId: string,
    reason?: string
  ): Promise<unknown> {
    if (executionId.startsWith(ACTION_PAUSE_ID_PREFIX)) {
      return await this._rejectActionPause(executionId, reason);
    }
    const runtime = this._codemodeRuntime();
    if (!runtime) {
      return {
        status: "error",
        executionId,
        error:
          "No codemode runtime is configured — the execute tool was never " +
          "created on this agent."
      };
    }
    const pending = await runtime.pending(executionId);
    if (pending.length === 0) {
      return {
        status: "error",
        executionId,
        error: `Execution "${executionId}" is no longer pending.`
      };
    }
    // `reject` reports whether it actually terminated the run. A `false`
    // means the action was resolved between our `pending()` check and the
    // reject (approve/reject interleave across facet RPC awaits — input
    // gates only cover storage). Writing "rejected" then would clobber a
    // paused part whose real outcome (e.g. an in-flight approval) is still
    // coming, so surface an error instead.
    const terminated = await runtime.reject({
      executionId,
      seq: pending[0].seq
    });
    if (!terminated) {
      return {
        status: "error",
        executionId,
        error: `Execution "${executionId}" is no longer pending — it was approved or rejected elsewhere.`
      };
    }
    const output = {
      status: "rejected",
      executionId,
      reason: reason ?? "Rejected by user"
    };
    await this._applyExecutionOutcome(executionId, output);
    return output;
  }

  /**
   * Reject a parked `kind: "durable-pause"` action. Claim-by-delete consumes
   * the pending row (idempotent across tabs/recovery), the action's `execute`
   * never runs, and the paused transcript part is replaced with a `rejected`
   * outcome so the model can adapt or explain.
   */
  private async _rejectActionPause(
    executionId: string,
    reason?: string
  ): Promise<unknown> {
    const row = this._claimActionPendingRow(executionId);
    if (!row) {
      return {
        status: "error",
        executionId,
        error: `Execution "${executionId}" is no longer pending — it was approved or rejected elsewhere.`
      };
    }
    const output = {
      status: "rejected",
      executionId,
      action: row.action_name,
      reason: reason ?? "Rejected by user"
    };
    this._emitActionPauseEvent({
      type: "action:pause:rejected",
      payload: { action: row.action_name, executionId }
    });
    await this._applyExecutionOutcome(executionId, output);
    return output;
  }

  /**
   * Replace a paused execute-tool output in the transcript with the
   * execution's new outcome and kick the auto-continuation so the model sees
   * it.
   *
   * When no paused part carries `executionId` — the output was already
   * replaced from another tab, or compaction summarized the part away — the
   * runtime has still durably applied the approval/rejection, so the outcome
   * must not be dropped: it is appended as a system note instead, and the
   * continuation still fires so the model can act on it.
   */
  private async _applyExecutionOutcome(
    executionId: string,
    output: unknown
  ): Promise<boolean> {
    const toolCallId = this._findPausedExecutionToolCall(executionId);
    if (!toolCallId) {
      // Already resolved in place (e.g. approved from another tab)? Then the
      // transcript has the outcome and nothing more is needed.
      if (this._findExecutionToolCall(executionId) != null) return false;
      let summary: string;
      try {
        summary = JSON.stringify(output)?.slice(0, 4_000) ?? String(output);
      } catch {
        summary = String(output);
      }
      await this._appendMessageToHistory({
        id: `exec-outcome-${executionId}-${crypto.randomUUID()}`,
        role: "system",
        parts: [
          {
            type: "text",
            text:
              `[execute tool] The paused execution "${executionId}" was ` +
              `resolved, but its tool call is no longer in the transcript ` +
              `(it may have been compacted). Outcome: ${summary}`
          }
        ]
      } as UIMessage);
    } else {
      await this._enqueueInteractionApply(() =>
        this._applyToolUpdateToMessages(
          pausedExecutionUpdate(toolCallId, executionId, output)
        )
      );
    }
    // Continue on the approving connection when there is one (WS callable),
    // else any open connection (DO-stub approval with clients attached). When
    // NO connection is open — an approval arriving via RPC from a dashboard,
    // webhook, or voice backend — fall back to a connection-independent
    // continuation so the model still advances and the result isn't stranded.
    const { connection } = getCurrentAgent();
    let target = connection;
    if (!target) {
      for (const open of this.getConnections()) {
        target = open;
        break;
      }
    }
    if (target) {
      this._scheduleAutoContinuation(target);
    } else {
      this._runConnectionlessContinuation();
    }
    return true;
  }

  /**
   * Find the tool part holding the paused output of `executionId` — in the
   * in-flight streaming accumulator first (an approval can land while a new
   * turn streams), then the persisted transcript, newest message first.
   */
  private _findPausedExecutionToolCall(executionId: string): string | null {
    return this._findExecutionToolCall(executionId, true);
  }

  /**
   * Find the tool part carrying `executionId` in its output. With
   * `pausedOnly`, only a still-paused output matches — used to locate the
   * part an approval outcome should replace. Without it, any settled output
   * matches — used to distinguish "already resolved elsewhere" from "the
   * part is gone from the transcript" (e.g. compacted away).
   */
  private _findExecutionToolCall(
    executionId: string,
    pausedOnly = false
  ): string | null {
    const matches = (part: Record<string, unknown>): boolean => {
      if (part.state !== "output-available") return false;
      if (typeof part.toolCallId !== "string") return false;
      const output = part.output as
        | { status?: unknown; executionId?: unknown }
        | null
        | undefined;
      return (
        output != null &&
        typeof output === "object" &&
        (!pausedOnly || output.status === "paused") &&
        output.executionId === executionId
      );
    };

    const streaming = this._streamingAssistant;
    if (streaming) {
      for (const part of streaming.parts as unknown as Array<
        Record<string, unknown>
      >) {
        if (matches(part)) return part.toolCallId as string;
      }
    }

    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message.role !== "assistant") continue;
      for (const part of message.parts as unknown as Array<
        Record<string, unknown>
      >) {
        if (matches(part)) return part.toolCallId as string;
      }
    }
    return null;
  }

  private async _applyToolUpdateToMessages(update: {
    toolCallId: string;
    matchStates: string[];
    apply: (part: Record<string, unknown>) => Record<string, unknown>;
  }): Promise<void> {
    // The message to update can live in two places. During a streaming turn
    // the assistant message exists ONLY in the in-flight accumulator until
    // `_persistAssistantMessage` writes it at a turn boundary; a parallel-
    // batch sibling can also have been persisted already by stall recovery.
    // Apply to BOTH so the result is correct regardless of where the message
    // currently is and survives the eventual `accumulator.toMessage()` persist
    // (which would otherwise downgrade an applied result back to
    // `input-available` — #1649). Mirrors `@cloudflare/ai-chat`'s streaming-
    // message handling, generalized to also cover the post-persist case.
    let broadcastMessage: UIMessage | undefined;

    // (1) In-flight accumulator. A client tool result that arrives over the
    // WebSocket before the end-of-stream persist would be missed by a
    // storage-only lookup and later repaired as "interrupted". Writing it in
    // place lets it ride into the persist.
    const streaming = this._streamingAssistant;
    if (streaming) {
      const accParts = streaming.parts as unknown as Array<
        Record<string, unknown>
      >;
      const result = applyToolUpdate(accParts, update);
      if (result && result.parts[result.index] !== accParts[result.index]) {
        // `accParts` is a typed alias of the accumulator's live array, so this
        // in-place write is reflected by `streaming.toMessage()` and the
        // eventual end-of-stream persist.
        accParts[result.index] = result.parts[result.index];
        broadcastMessage = streaming.toMessage();
      }
    }

    // (2) Durable storage. Handles messages already persisted — including
    // partials written mid-stream by stall recovery and cross-message tool
    // results that target an earlier message than this turn's.
    const history = await this._readMessagesFromStorage();
    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      const msgParts = msg.parts as Array<Record<string, unknown>>;
      const result = applyToolUpdate(msgParts, update);
      if (result) {
        // First-write-wins / idempotent re-apply: when `apply` leaves the
        // matched part untouched (same reference) — e.g. a provider replay of
        // an already-settled cross-message tool result (#1404) — there is
        // nothing to persist. Skip the durable write and the redundant
        // `MESSAGE_UPDATED` broadcast so clients don't churn on a no-op.
        if (result.parts[result.index] === msgParts[result.index]) {
          break;
        }
        const updatedMsg = {
          ...msg,
          parts: result.parts as UIMessage["parts"]
        };
        const safe = await this._updateMessageInHistory(updatedMsg);
        // Session change callbacks may run after an immediately scheduled
        // continuation begins. Keep its input cache coherent synchronously.
        this._patchCachedMessage(safe);
        // Patch the live cache in place instead of doing a full
        // `_syncMessages()` round-trip.
        // A full re-read during a streaming turn drops in-flight messages
        // whose parent chain hasn't been persisted yet (see commits
        // 3f615a24 "revert _syncMessages in _applyToolUpdateToMessages"
        // and 6e76bd49 "update cached messages in-place"). The cache is
        // the source of truth during a turn; we only reconcile it here to
        // reflect the tool update that was just written to storage.
        broadcastMessage = safe;
        break;
      }
    }

    if (broadcastMessage) {
      this._broadcast({
        type: MSG_MESSAGE_UPDATED,
        message: broadcastMessage
      });
    }
  }

  // ── Stability + pending interactions ─────────────────────────────

  protected hasPendingInteraction(): boolean {
    const clientResolvable = this._clientResolvableToolNames();
    // Scan the in-flight accumulator first, mirroring `@cloudflare/ai-chat`'s
    // `_streamingMessage` check. A parallel-batch client tool can stream a
    // pending `input-available`/`approval-requested` part into
    // `_streamingAssistant` before the end-of-stream persist writes it to
    // `this.messages`. The hot `waitUntilStable` loop only consults this after
    // `waitForIdle()` (when the streaming turn has drained and the accumulator
    // is null), so the scan is a no-op there. It matters on the same-isolate
    // stall route, where the incident-eval callback runs mid-stream: without
    // it Think would budget a stall that ai-chat treats as "awaiting client"
    // (budget-free) — a self-correcting drift once the continuation re-reads
    // persisted state, but a real asymmetry the stall watchdog would expose.
    const streaming = this._streamingAssistant;
    if (
      streaming &&
      this._messageHasPendingInteraction(
        streaming.toMessage(),
        clientResolvable
      )
    ) {
      return true;
    }
    return this.messages.some(
      (message) =>
        message.role === "assistant" &&
        this._messageHasPendingInteraction(message, clientResolvable)
    );
  }

  /**
   * `true` when an auto-continuation is armed but has not yet fired (#1650): a
   * pending continuation that has not entered its turn (`!pastCoalesce`) whose
   * coalesce timer is still pending or whose completeness drain is in progress.
   * Mirrors `@cloudflare/ai-chat`'s `_hasArmedContinuation`, consuming the shared
   * controller's `isArmed()`.
   */
  private _hasArmedContinuation(): boolean {
    const pending = this._continuation.pending;
    return (
      pending !== null &&
      !pending.pastCoalesce &&
      this._autoContinuation.isArmed()
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
        // An auto-continuation may be armed (#1650): the coalesce timer is
        // still pending or its drain is in flight. Report not-stable and wait
        // it out, mirroring `@cloudflare/ai-chat` — otherwise idle eviction /
        // recovery could act in the ~50ms window before the held continuation
        // fires (and the turn it enqueues then drains via the loop top).
        if (!this._hasArmedContinuation()) {
          return true;
        }
        if (
          (await this._awaitWithDeadline(
            new Promise<void>((resolve) =>
              setTimeout(resolve, AutoContinuationController.COALESCE_MS)
            ),
            deadline
          )) === TIMED_OUT
        ) {
          return false;
        }
        continue;
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

  private _awaitWithDeadline<T>(
    promise: Promise<T>,
    deadline: number | null
  ): Promise<T | typeof TIMED_OUT> {
    return awaitWithDeadline(promise, deadline);
  }

  private _messageHasPendingInteraction(
    message: UIMessage,
    clientResolvable: Set<string>
  ): boolean {
    return message.parts.some((part) =>
      this._partAwaitsClientInteraction(part, clientResolvable)
    );
  }

  /**
   * Names of the tools whose interrupted `input-available` part can still be
   * resolved by the CLIENT after a restart — i.e. the client tools (no server
   * `execute`) from the last request, which the SPA answers by replaying a
   * `tool-result` over the WebSocket. A server tool is intentionally absent:
   * its `execute()` promise died with the evicted isolate, so nothing will
   * ever post its result.
   */
  private _clientResolvableToolNames(): Set<string> {
    return clientResolvableToolNames(this._lastClientTools);
  }

  /**
   * Whether a part is still awaiting a CLIENT interaction that can genuinely
   * arrive after a restart, so `waitUntilStable` must keep waiting for it:
   *  - `approval-requested`: a reconnecting client can replay the approval.
   *  - `input-available` for a CLIENT tool: the SPA can replay the
   *    `tool-result` (this is why client-tool recovery works — see the
   *    `tool-result` handler, which sets `_pendingInteractionPromise`).
   *
   * A SERVER tool's `input-available` is deliberately NOT pending. After an
   * eviction its `execute()` promise is gone and no interaction will ever
   * resolve it, so treating it as pending wedges `waitUntilStable` forever:
   * the recovery continuation times out every attempt, burns the attempt
   * budget on a wait that can never converge, and — if any transient
   * storage/schedule error throws on the way — the one-shot recovery alarm row
   * is swallowed and deleted with no terminal `onExhausted` (the half-finished
   * message wedges silently). Excluding it lets `waitUntilStable` converge so
   * `continueLastTurn` runs, where the existing transcript-repair pass
   * (`_repairTranscriptForProvider`) flips the orphan to an errored result and
   * the model proceeds.
   */
  private _partAwaitsClientInteraction(
    part: UIMessage["parts"][number],
    clientResolvable: Set<string>
  ): boolean {
    return partAwaitsClientInteraction(part, clientResolvable);
  }

  // ── Chat recovery via fibers ───────────────────────────────────

  private _resolveChatRecoveryConfig(): ResolvedChatRecoveryConfig {
    // Delegates to the shared incident engine (agents/chat) so Think and
    // AIChatAgent resolve recovery config identically. See
    // design/rfc-chat-recovery-foundation.md.
    return resolveChatRecoveryConfig(this.chatRecovery);
  }

  /**
   * Monotonic forward-progress signal for recovery budget resets.
   *
   * This used to count assistant messages in `this.messages`, but that is
   * recomputed from the live, mutable transcript. Compaction collapses older
   * assistant messages into a summary, lowering the count — so a turn that had
   * genuinely advanced could read as "no progress" between attempts and exhaust
   * its budget prematurely (#1628). Instead we read a durably-persisted counter
   * that only ever increments — bumped at production time when new content is
   * durably flushed (see `_storeChunkDurably`), which is genuine forward
   * progress and is immune to client reconnects / recovery re-persists — so
   * compaction can never lower it and a reconnect can't fake it (#1637).
   */
  private async _chatRecoveryProgressMarker(): Promise<number> {
    // Storage read lives in the shared engine (agents/chat); this is the
    // package binding, symmetric with `AIChatAgent`.
    return readChatRecoveryProgress(this.ctx.storage);
  }

  /** Advance the durable recovery-progress counter. Called from
   *  `_storeChunkDurably` when a stored chunk credits forward progress under the
   *  shared rule (real, reconnect-immune forward progress). The increment lives
   *  in the shared engine (agents/chat); this is the package binding. */
  private async _bumpChatRecoveryProgress(): Promise<void> {
    return bumpChatRecoveryProgress(this.ctx.storage);
  }

  /** Per-isolate N9 throttle gate (shared `agents/chat` helper); reset per
   *  isolate so the first forwarded chunk after a restart always credits. */
  private _agentToolStreamProgress = new AgentToolStreamProgressThrottle();

  /**
   * N9: forwarding a sub-agent's chunks IS forward progress for this parent
   * turn, so credit the parent's recovery progress marker — otherwise a parent
   * whose turn merely `await`s a child banks no progress of its own and its
   * no-progress window exhausts while the child is healthily streaming. Only
   * invoked after a child actually produced output (see
   * `_forwardAgentToolStream`), so a silent child still lets the parent exhaust.
   * Throttled (and reset per isolate) so we never write storage per token.
   */
  protected override async _onAgentToolStreamProgress(): Promise<void> {
    if (this._agentToolStreamProgress.shouldCredit(Date.now())) {
      await this._bumpChatRecoveryProgress();
    }
  }

  private async _beginChatRecoveryIncident(input: {
    requestId: string;
    recoveryRootRequestId?: string | null;
    latestUserMessageId?: string | null;
    recoveryKind: ChatRecoveryKind;
    /** Test-only clock injection for deterministic debounce/window timing. */
    nowMs?: number;
  }): Promise<{
    incident: ChatRecoveryIncident;
    config: ResolvedChatRecoveryConfig;
    exhausted: boolean;
  }> {
    // Incident orchestration (sweep -> read -> rehydrate interaction state ->
    // budget eval -> persist -> emit, with its ordering invariants) lives in the
    // shared ChatRecoveryEngine; this method is the package's adapter binding.
    // See design/rfc-chat-recovery-foundation.md.
    return this._chatRecoveryEngine().beginIncident(input);
  }

  /**
   * Lazily-built shared recovery engine. The adapter arrows capture `this`, so a
   * single cached instance is correct across calls (and across future engine
   * methods).
   */
  private _chatRecoveryEngineInstance?: ChatRecoveryEngine;
  private _chatRecoveryEngine(): ChatRecoveryEngine {
    return (this._chatRecoveryEngineInstance ??= new ChatRecoveryEngine({
      resolveConfig: () => this._resolveChatRecoveryConfig(),
      now: () => Date.now(),
      sweepStaleIncidents: (now) =>
        sweepStaleChatRecoveryIncidents(this.ctx.storage, now),
      getIncident: async (key) =>
        (await this.ctx.storage.get<ChatRecoveryIncident>(key)) ?? null,
      // Hibernation ordering guard. The budget decision consults
      // `hasPendingInteraction()` -> `_clientResolvableToolNames()` ->
      // `_lastClientTools` to keep a HITL turn (parked on a client-tool
      // `input-available` orphan) budget-free. On a fresh wake the base Agent
      // runs the boot-recovery path (`_handleInternalFiberRecovery`) BEFORE
      // onStart's `_restoreClientTools()`, so without this the in-memory cache
      // is empty and such a turn is misread as "stuck" and wrongly sealed (the
      // slow-human + deploy-churn case). Re-hydrate from the durable
      // `think_config` store — its own table, no Session init required, so the
      // read is safe this early; the guard keeps it idempotent with the later
      // onStart restore and a no-op on the live-isolate stall path where the
      // tools are already loaded. The engine invokes this BEFORE it reads
      // `isAwaitingClientInteraction()`.
      ensureInteractionStateLoaded: () => {
        if (this._lastClientTools === undefined) {
          this._restoreClientTools();
        }
      },
      // Messenger/workflow reply fibers (`think:messenger-reply`) are NOT chat
      // turns; the messenger runtime owns their recovery. The engine dispatches
      // this before the chat-fiber gate so such a fiber is never misread as an
      // orphaned chat turn. `Promise.resolve(false)` when no messenger runtime
      // is initialized (e.g. a child facet).
      tryHandleNonChatFiberRecovery: (ctx) =>
        this._messengerRuntime?.handleFiberRecovery(ctx) ??
        Promise.resolve(false),
      readProgress: () => this._chatRecoveryProgressMarker(),
      // A turn parked on a pending CLIENT interaction is waiting on the human,
      // not stuck, so the engine keeps it budget-free. SERVER-tool orphans are
      // excluded by `hasPendingInteraction` and still recover normally.
      isAwaitingClientInteraction: () => this.hasPendingInteraction(),
      putIncident: (key, incident) => this.ctx.storage.put(key, incident),
      deleteIncident: async (key) => {
        await this.ctx.storage.delete(key);
      },
      emitRecoveryEvent: (event) =>
        this._emit(event.type, {
          incidentId: event.incidentId,
          requestId: event.requestId,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          recoveryKind: event.recoveryKind,
          ...(event.reason ? { reason: event.reason } : {})
        }),
      scheduleRecovery: async (callback, data, reason, delaySeconds) => {
        await this.schedule(
          delaySeconds,
          callback,
          data,
          chatRecoverySchedulePolicy(reason)
        );
      },
      setRecovering: (active, requestId) =>
        this._setChatRecovering(active, requestId),
      onShouldKeepRecoveringError: (error) =>
        console.error(
          "[Think] chatRecovery shouldKeepRecovering hook threw",
          error
        ),
      exhaustChatRecovery: (incident, config, partial, streamId, createdAt) =>
        this._exhaustChatRecovery(
          incident,
          config,
          partial,
          streamId,
          createdAt
        ),
      resolveRecoveryStream: (requestId) =>
        this._resolveThinkRecoveryStream(requestId),
      getPartialStreamText: (streamId) => this._getPartialStreamText(streamId),
      activeChatRecoveryRootRequestId: () =>
        this._activeChatRecoveryRootRequestId,
      onGiveUpBookkeepingError: (phase, error) =>
        console.error(
          phase === "read"
            ? "[Think] failed to read recovery incident during give-up; synthesizing"
            : "[Think] failed to persist sealed recovery incident during give-up",
          error
        )
    } satisfies ChatRecoveryAdapter));
  }

  private async _updateChatRecoveryIncident(
    incidentId: string | undefined,
    status: ChatRecoveryIncident["status"],
    reason?: string
  ): Promise<void> {
    // Incident state-machine transitions (delete-on-completed vs persist, the
    // completed/skipped/failed event emit, and the #1620 recovering-flag) live
    // in the shared ChatRecoveryEngine; this method is the package's adapter
    // binding, symmetric with `AIChatAgent`. The recovering-flag clear here
    // covers the benign-skip / failed paths that never reach a turn-level
    // terminal (exhaustion + normal completion also clear via
    // `_recordTerminalChatStatus`). See design/rfc-chat-recovery-foundation.md.
    return this._chatRecoveryEngine().updateIncident(
      incidentId,
      status,
      reason
    );
  }

  private async _exhaustChatRecovery(
    incident: ChatRecoveryIncident,
    config: ResolvedChatRecoveryConfig,
    // `parts` is the engine's vocabulary-agnostic `unknown[]`; Think owns the AI
    // SDK `UIMessage` vocabulary, so it re-asserts `MessagePart[]` at the
    // user-facing exhausted-context edge below.
    partial: { text: string; parts: unknown[] },
    streamId: string,
    createdAt: number
  ): Promise<void> {
    // Build + notification (event + onExhausted-swallow) and the
    // notify-before-terminalize invariant live in the engine helper; the
    // broadcast/terminal ordering inside `terminalize` is Think's own
    // (broadcast-first; see the note below). See
    // design/rfc-chat-recovery-foundation.md.
    await runChatRecoveryExhaustion(
      {
        incident,
        config,
        partialText: partial.text,
        partialParts: partial.parts as MessagePart[],
        streamId,
        createdAt
      },
      {
        emit: (event) => this._emit("chat:recovery:exhausted", event),
        onExhausted: config.onExhausted,
        onError: (error) =>
          console.error("[Think] chatRecovery onExhausted hook threw", error),
        terminalize: async (ctx) => {
          // Deliver the user-visible terminal banner BEFORE the bookkeeping
          // storage writes below. A `ctx.storage` write can reject mid-deploy
          // (the exact window recovery exhausts in), and if it threw before this
          // broadcast the user would be left staring at a half-finished message
          // with no terminal resolution. The broadcast itself touches no
          // storage, so ordering it first makes the banner resilient to a
          // failing `_recordTerminalChatStatus` / `_markRecoveredSubmissionInterrupted`.
          // `@cloudflare/ai-chat` terminalizes broadcast-first for the same
          // reason; only the set of durable writes below differs (Think also
          // writes a submission row).
          this._broadcastChat({
            type: MSG_CHAT_RESPONSE,
            id: ctx.requestId,
            body: ctx.terminalMessage,
            done: true,
            error: true
          });
          // Write the durable terminal record (#1645) FIRST among the storage
          // writes: it's the record a disconnected client replays on reconnect,
          // so it must not be skipped if the (independent) submission-row write
          // below throws.
          await this._recordTerminalChatStatus(
            "interrupted",
            ctx.requestId,
            ctx.terminalMessage
          );
          // The submission is keyed by the recovery ROOT request id;
          // `ctx.requestId` is the latest per-continuation id and won't match a
          // chained submission.
          await this._markRecoveredSubmissionInterrupted(
            ctx.recoveryRootRequestId ?? ctx.requestId,
            ctx.terminalMessage
          );
        }
      }
    );
    // The exhausted record is retained for inspection and reclaimed later by
    // the TTL sweep; only successful (completed) incidents are deleted eagerly.
  }

  /**
   * Route a stream-stall watchdog abort into bounded recovery instead of a
   * terminal error (#1626). A stall happens inside a LIVE isolate (no DO
   * restart), so the normal restart-detected recovery path never runs — we
   * open/advance a recovery incident here and schedule a continuation, reusing
   * the SAME budget (`maxAttempts` + wall-clock window + progress-aware reset)
   * as deploy/eviction recovery. A transient hang recovers; a persistently
   * hanging provider exhausts the budget. Idempotency matches deploy recovery:
   * settled tool results are durable and won't re-run, but a tool that was
   * mid-execution when the stall fired re-runs on the continuation.
   *
   * Returns:
   * - `"scheduled"` — a continuation was scheduled; the caller suppresses the
   *   terminal error and closes the stream cleanly.
   * - `"exhausted"` — the budget is spent; this routes through the SAME
   *   `_exhaustChatRecovery` path as deploy recovery (fires `onExhausted`,
   *   emits `chat:recovery:exhausted`, marks the submission interrupted, and
   *   delivers the configured `terminalMessage`). The caller must NOT run the
   *   generic terminal path — the terminal UX is already delivered.
   * - `"disabled"` — chat recovery is off; the caller falls through to the
   *   generic terminal error (the watchdog's original "kill the spinner"
   *   behavior, unchanged).
   */
  private async _routeStallToBoundedRecovery(input: {
    requestId: string;
    streamId: string;
    partialParts: MessagePart[];
    targetAssistantId?: string;
  }): Promise<"scheduled" | "exhausted" | "disabled"> {
    // Stall-recovery is automatic only when chat recovery is enabled (the
    // default for Think). With recovery off, a stall stays terminal — there is
    // no budget/continuation machinery to route into.
    if (!this._resolveChatRecoveryConfig().enabled) return "disabled";
    const recoveryRootRequestId =
      this._activeChatRecoveryRootRequestId ?? input.requestId;
    const latestUserMessageId =
      [...this.messages].reverse().find((m) => m.role === "user")?.id ?? null;
    const { incident, config, exhausted } =
      await this._beginChatRecoveryIncident({
        requestId: input.requestId,
        recoveryRootRequestId,
        latestUserMessageId,
        recoveryKind: "continue"
      });
    if (exhausted) {
      // Budget spent: deliver the SAME terminal UX as deploy-recovery
      // exhaustion (terminalMessage + onExhausted + chat:recovery:exhausted +
      // submission interrupted) instead of letting the raw stall error leak
      // out. `firstSeenAt` is the closest available turn-start proxy here.
      const partialText = input.partialParts
        .filter(
          (p): p is { type: "text"; text: string } =>
            (p as { type?: string }).type === "text"
        )
        .map((p) => p.text)
        .join("");
      await this._exhaustChatRecovery(
        incident,
        config,
        { text: partialText, parts: input.partialParts },
        input.streamId,
        incident.firstSeenAt
      );
      return "exhausted";
    }
    // If a durable submission is running for this turn, the continuation must
    // complete it (otherwise the submission hangs) — same as deploy recovery.
    const recoveredRequestId = this._hasRunningSubmission(recoveryRootRequestId)
      ? recoveryRootRequestId
      : undefined;
    await this._chatRecoveryEngine().scheduleRecovery({
      incident,
      recoveryKind: "continue",
      callback: "_chatRecoveryContinue",
      data: {
        ...(input.targetAssistantId
          ? { targetAssistantId: input.targetAssistantId }
          : {}),
        originalRequestId: recoveryRootRequestId,
        incidentId: incident.incidentId,
        lastBody: this._lastBody ?? null,
        lastClientTools: this._lastClientTools ?? null,
        ...(recoveredRequestId ? { recoveredRequestId } : {})
      }
    });
    return "scheduled";
  }

  protected override async _handleInternalFiberRecovery(
    ctx: FiberRecoveryContext
  ): Promise<boolean> {
    // The wake-recovery lifecycle (non-chat dispatch → chat gate → unwrap →
    // stream/partial → classify → begin-incident → exhausted-branch →
    // onChatRecovery → persist → complete → dispatch → catch→failed) lives in the
    // shared ChatRecoveryEngine; this binds the divergent organs as wake hooks,
    // symmetric with `AIChatAgent`. `Think` tracks terminal stream status and a
    // durable submission layer + session leaf, so its dispatch owns the
    // terminal-skip / submission-completion / interrupted-broadcast branches the
    // engine frame stays out of. See design/rfc-chat-recovery-foundation.md.
    return this._chatRecoveryEngine().handleChatFiberRecovery(ctx, {
      chatFiberPrefix: () =>
        (this.constructor as typeof Think).CHAT_FIBER_NAME + ":",
      unwrapRecoverySnapshot: (fiber) => {
        const { snapshot, user } = unwrapChatFiberSnapshot<"think-chat-turn">(
          "__cfThinkChatFiberSnapshot",
          fiber.snapshot,
          "think-chat-turn"
        );
        return { snapshot, recoveryData: user };
      },
      classifyRecoveredTurn: (input) => this._classifyRecoveredThinkTurn(input),
      invokeOnChatRecovery: (input) =>
        this.onChatRecovery({
          incidentId: input.incident.incidentId,
          recoveryRootRequestId: input.recoveryRootRequestId,
          attempt: input.incident.attempt,
          maxAttempts: input.incident.maxAttempts,
          recoveryKind: input.recoveryKind,
          streamId: input.streamId,
          requestId: input.requestId,
          partialText: input.partial.text,
          // The engine seam is vocabulary-agnostic (`unknown[]`); Think owns the
          // AI SDK parts vocabulary, so re-assert it for the user-facing context.
          partialParts: input.partial.parts as MessagePart[],
          recoveryData: input.recoveryData,
          messages: [...this.messages],
          lastBody: input.snapshot?.lastBody ?? this._lastBody,
          lastClientTools:
            input.snapshot?.lastClientTools ?? this._lastClientTools,
          createdAt: input.createdAt
        }),
      shouldPersistOrphanedPartial: (input) =>
        this._shouldPersistOrphanedPartial(input.streamId, {
          streamStillActive: input.streamStillActive,
          streamIsTerminal:
            input.streamStatus === "completed" ||
            input.streamStatus === "error",
          snapshot: input.snapshot
        }),
      persistOrphanedStream: (streamId) =>
        this._persistOrphanedStream(streamId),
      completeRecoveredStream: (streamId) =>
        this._completeResumableStream(streamId),
      dispatchRecoveredTurn: (input) => this._dispatchRecoveredThinkTurn(input)
    } satisfies ChatFiberWakeHooks<ThinkRecoveryClassification>);
  }

  /**
   * Resolve the orphaned stream + its terminal status for a recovered chat turn.
   * Drives BOTH the wake path (full result) and the give-up terminalization
   * (which reads only `.streamId`; the terminal banner still fires when
   * `streamId` is `""` — `_exhaustChatRecovery` does not require a stream).
   * Prefers the newest durable stream row keyed by the recovery-root request id;
   * falls back to the live active stream.
   */
  private _resolveThinkRecoveryStream(
    requestId: string
  ): ResolvedRecoveryStream {
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
    const streamStillActive = Boolean(
      streamId &&
      this._resumableStream.hasActiveStream() &&
      this._resumableStream.activeStreamId === streamId
    );
    return { streamId, streamStillActive, streamStatus };
  }

  /**
   * Classify a recovered turn as `retry` or `continue`. A pre-stream turn with no
   * partial re-runs its user message (`retryTargetUserId`), unless the stream is
   * already terminal — a terminal stream is never retried (it completed), only
   * its submission is reconciled in dispatch.
   */
  private async _classifyRecoveredThinkTurn(
    input: ClassifyRecoveredTurnInput
  ): Promise<{
    recoveryKind: ChatRecoveryKind;
    detail: ThinkRecoveryClassification;
  }> {
    const streamIsTerminal =
      input.streamStatus === "completed" || input.streamStatus === "error";
    const retryTargetUserId = await this._recoverablePreStreamUserId(
      input.snapshot,
      input.streamId,
      input.partial
    );
    const shouldRetryBase = retryTargetUserId !== null && !streamIsTerminal;
    const recoveryKind: ChatRecoveryKind = shouldRetryBase
      ? "retry"
      : "continue";
    return { recoveryKind, detail: { retryTargetUserId } };
  }

  /**
   * The retry/continue/skip decision for a recovered chat turn, run after the
   * partial is persisted and the stream completed. Owns `Think`'s substrate
   * behavior the engine frame stays out of: a terminal stream reconciles the
   * durable submission (and is never retried/continued), and a `continue: false`
   * abandonment marks the submission interrupted + records a terminal status +
   * broadcasts so a reconnecting client is not frozen.
   */
  private async _dispatchRecoveredThinkTurn(
    input: DispatchRecoveredTurnInput<ThinkRecoveryClassification>
  ): Promise<void> {
    const {
      incident,
      options,
      snapshot,
      requestId,
      recoveryRootRequestId,
      streamStatus
    } = input;
    const { retryTargetUserId } = input.detail;
    const streamIsTerminal =
      streamStatus === "completed" || streamStatus === "error";

    const shouldRetry =
      retryTargetUserId !== null &&
      options.continue !== false &&
      !streamIsTerminal;
    const lastLeaf = shouldRetry ? null : await this.session.getLatestLeaf();
    const targetId =
      lastLeaf?.role === "assistant" && !streamIsTerminal
        ? lastLeaf.id
        : undefined;
    const canContinue =
      !shouldRetry && options.continue !== false && !streamIsTerminal;
    // The durable submission is keyed by the recovery ROOT request id (stable
    // across the whole continuation chain), not this turn's per-continuation
    // requestId. Keying off `requestId` loses the link on every chained
    // continuation, so the continuation that finally completes the turn can no
    // longer mark the submission done (see investigate/recovery-* findings).
    const hasRunningSubmission = this._hasRunningSubmission(
      recoveryRootRequestId
    );

    if (streamIsTerminal && hasRunningSubmission) {
      await this._completeRecoveredSubmission(
        recoveryRootRequestId,
        streamStatus === "completed" ? "completed" : "error",
        requestId,
        streamStatus === "completed"
          ? null
          : "Recovered chat stream had already errored."
      );
    }

    const recoveredRequestId =
      (canContinue || shouldRetry) && hasRunningSubmission
        ? recoveryRootRequestId
        : undefined;

    if (shouldRetry) {
      await this._chatRecoveryEngine().scheduleRecovery({
        incident,
        recoveryKind: input.recoveryKind,
        callback: "_chatRecoveryRetry",
        data: {
          targetUserId: retryTargetUserId,
          originalRequestId: recoveryRootRequestId,
          incidentId: incident.incidentId,
          lastBody: snapshot?.lastBody ?? null,
          lastClientTools: snapshot?.lastClientTools ?? null,
          ...(recoveredRequestId ? { recoveredRequestId } : {})
        }
      });
    } else if (canContinue) {
      await this._chatRecoveryEngine().scheduleRecovery({
        incident,
        recoveryKind: input.recoveryKind,
        callback: "_chatRecoveryContinue",
        data: {
          ...(targetId ? { targetAssistantId: targetId } : {}),
          originalRequestId: recoveryRootRequestId,
          incidentId: incident.incidentId,
          ...(snapshot
            ? {
                lastBody: snapshot.lastBody ?? null,
                lastClientTools: snapshot.lastClientTools ?? null
              }
            : {}),
          ...(recoveredRequestId ? { recoveredRequestId } : {})
        }
      });
    } else if (options.continue === false && !streamIsTerminal) {
      await this._updateChatRecoveryIncident(
        incident.incidentId,
        "skipped",
        "continue_disabled"
      );
      const disabledMessage =
        "Submission was interrupted and chat recovery was disabled.";
      // Key off the recovery ROOT, not this continuation's `requestId` — a
      // chained submission's row still carries the root id, so passing the
      // per-continuation id would miss it and leave it stuck `running`.
      await this._markRecoveredSubmissionInterrupted(
        recoveryRootRequestId,
        disabledMessage
      );
      // Unlike `conversation_changed` (a newer turn owns the UI, so silence is
      // correct), disabling recovery abandons the turn with no superseding turn.
      // Surface it like exhaustion so a reconnecting client isn't frozen.
      await this._recordTerminalChatStatus(
        "interrupted",
        requestId,
        disabledMessage
      );
      this._broadcastChat({
        type: MSG_CHAT_RESPONSE,
        id: requestId,
        body: disabledMessage,
        done: true,
        error: true
      });
    } else {
      await this._updateChatRecoveryIncident(
        incident.incidentId,
        "skipped",
        streamIsTerminal ? "stream_terminal" : "not_recoverable"
      );
    }
  }

  private async _recoverablePreStreamUserId(
    snapshot: ChatFiberSnapshot | null,
    streamId: string,
    partial: { text: string; parts: unknown[] }
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

  private async _hasPersistedRecoveredAssistant(
    snapshot: ChatFiberSnapshot | null
  ): Promise<boolean> {
    const lastLeaf = await this.session.getLatestLeaf();
    return (
      lastLeaf?.role === "assistant" &&
      lastLeaf.id !== snapshot?.latestMessageId
    );
  }

  /**
   * Whether the orphaned stream's partial should be materialized into an
   * assistant message: there is a stream, and it is either still active or
   * terminal-but-not-yet-persisted. Shared by the normal recovery path AND the
   * exhaustion path so neither discards settled work nor duplicates a partial
   * an earlier attempt already saved.
   */
  private async _shouldPersistOrphanedPartial(
    streamId: string,
    opts: {
      streamStillActive: boolean;
      streamIsTerminal: boolean;
      snapshot: ChatFiberSnapshot | null;
    }
  ): Promise<boolean> {
    if (!streamId) return false;
    const alreadyPersisted =
      opts.streamIsTerminal &&
      (await this._hasPersistedRecoveredAssistant(opts.snapshot));
    return (
      opts.streamStillActive || (opts.streamIsTerminal && !alreadyPersisted)
    );
  }

  /**
   * Reschedule a recovery callback that timed out waiting for stable state,
   * consuming one attempt. Returns `true` if rescheduled, `false` if the
   * attempt budget is exhausted (the caller then fails the turn terminally).
   *
   * Shared by `_chatRecoveryRetry` and `_chatRecoveryContinue` so the
   * non-idempotent scheduling invariant lives in exactly one place — a fix to
   * one path can't silently diverge from the other. Mirrors the same helper in
   * `@cloudflare/ai-chat`.
   */
  private async _rescheduleRecoveryAfterStableTimeout(
    callback: ChatRecoveryScheduleCallback,
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined,
    maxAttempts: number
  ): Promise<boolean> {
    // The attempt-bump + scheduled/stable_timeout_retry persist + delayed
    // non-idempotent reschedule live in the shared ChatRecoveryEngine; this
    // method is the package's adapter binding, symmetric with `AIChatAgent`.
    // See design/rfc-chat-recovery-foundation.md.
    return this._chatRecoveryEngine().rescheduleAfterStableTimeout({
      incidentId: data?.incidentId,
      callback,
      data,
      fallbackMaxAttempts: maxAttempts
    });
  }

  /**
   * Park a recovery continuation that timed out waiting for stable state
   * because the turn is holding a pending CLIENT interaction (an
   * `input-available` client-tool part or an `approval-requested` part — see
   * `hasPendingInteraction`). Such a turn is WAITING ON THE HUMAN, not stuck:
   * the SPA replays the interrupted tool-result / approval after reconnect,
   * which drives a fresh continuation via the auto-continuation barrier
   * independently of the recovery retry loop. Burning the attempt budget on
   * that wait (each `waitUntilStable` times out because the human hasn't
   * answered) would seal a perfectly healthy turn on `stable_timeout` — the
   * exact symptom behind HITL "session recovery errors" under deploy churn.
   *
   * So instead of rescheduling or exhausting, we stop the loop and mark the
   * incident `skipped` (reason `awaiting_client_interaction`). That retains the
   * incident record (a later genuine interruption re-evaluates it) while
   * resolving the live "recovering…" indicator via `_updateChatRecoveryIncident`
   * so the client sees the parked tool-call UI rather than an eternal spinner.
   * A client that never returns is reclaimed by the incident TTL sweep and DO
   * idle-eviction. SERVER-tool orphans are excluded by `hasPendingInteraction`
   * (their `execute` died with the isolate), so they still recover normally.
   *
   * For a SUBMISSION-backed turn (`recoveredRequestId` present) the recovery
   * loop is the submission row's SOLE completion driver after a restart, and the
   * client's replay resumes the conversation as an independent auto-continuation
   * that never touches the submission. Parking would therefore leave the row
   * `running` until `_recoverSubmissionsOnStart` swept it to `error` on the next
   * restart. We instead complete it `completed` here: the park condition is a
   * fully-materialized client tool call in the leaf, which is exactly the
   * terminal state a non-interrupted submission reaches when its step emits a
   * client tool call (the model does not block on client tools — see
   * `_runProgrammaticMessagesTurn`, which marks such a step `completed`). The
   * human round-trip then proceeds via the normal auto-continuation, identical
   * to the non-crash flow.
   *
   * Returns `true` when the recovery was parked (caller must return), `false`
   * when there is no pending client interaction (caller proceeds to the normal
   * reschedule / exhaustion path).
   */
  private async _parkRecoveryForPendingInteraction(
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined
  ): Promise<boolean> {
    if (!this.hasPendingInteraction()) return false;
    await this._updateChatRecoveryIncident(
      data?.incidentId,
      "skipped",
      "awaiting_client_interaction"
    );
    if (data?.recoveredRequestId) {
      await this._completeRecoveredSubmission(
        data.recoveredRequestId,
        "completed",
        null,
        null
      );
    }
    return true;
  }

  /**
   * Terminalize a recovery turn that is giving up — whether because the
   * stable-state-timeout retry budget drained, or because the recovery
   * continuation threw a non-recoverable error — by routing through the SAME
   * `_exhaustChatRecovery` path as deploy-recovery and stall exhaustion
   * (#1626/#1631). It fires `onExhausted`, emits `chat:recovery:exhausted`,
   * marks the durable submission interrupted, records the terminal chat status,
   * and delivers the configured `terminalMessage`. `reason` carries the cause
   * (`stable_timeout` for a budget give-up, `recovery_error` for a thrown
   * error) through to `onExhausted` / `chat:recovery:exhausted`.
   *
   * This replaces the older give-up that only set the incident to `failed` and
   * completed the recovered submission as `error`, which bypassed
   * `_exhaustChatRecovery` entirely — so an app relying on `onExhausted` for the
   * terminal banner regressed to an eternal spinner when recovery gave up under
   * extreme churn. The error path matters just as much: a non-transient throw
   * in a recovery callback is SWALLOWED by `Agent._executeScheduleCallback`
   * (only a platform transient is re-thrown to preserve the one-shot row), so
   * without routing it here the alarm row is deleted with no terminal UX at
   * all — the half-finished message wedges silently. Shared by
   * `_chatRecoveryRetry` and `_chatRecoveryContinue`.
   *
   * Exactly-once terminalization is defended by two independent guards:
   *  1. The `stored?.status === "exhausted"` re-entry guard below — once an
   *     incident is sealed, a duplicate stale alarm (or retried callback)
   *     returns before re-firing. The seal is persisted only AFTER the
   *     terminal writes in `_exhaustChatRecovery` succeed (see the ordering
   *     note at the call below), so a give-up interrupted by a platform
   *     transient re-runs in full instead of being half-sealed.
   *  2. The durable-submission paths additionally short-circuit earlier at the
   *     `submission_not_running` check (the submission is already `error` after
   *     the first give-up). This is the ONLY guard `@cloudflare/ai-chat` lacks
   *     (no submission layer), so guard #1 carries it there.
   *
   * Residual at-least-once edges, all deliberately accepted as "deliver a
   * second banner" ≫ "silently drop the turn":
   *  • No `incidentId` at all in the payload (only reachable via a direct/test
   *    invocation — every production scheduler carries one): the synthesized
   *    incident can't be persisted (no key), so guard #1 can't arm.
   *  • The record is swept AGAIN between two alarms (guard #1 re-persists on the
   *    first, so this needs a second independent sweep) — vanishingly unlikely.
   *  • A platform transient interrupts `_exhaustChatRecovery` after the banner
   *    broadcast — the deferred re-run re-fires `onExhausted` + the banner
   *    (the terminal writes themselves are idempotent).
   */
  private _exhaustRecoveryGiveUp(
    callback: ChatRecoveryScheduleCallback,
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined,
    reason: string
  ): Promise<void> {
    // The give-up spine (read → re-entry-guard → build-exhausted-incident →
    // terminalize-before-seal → best-effort seal) lives in the shared
    // ChatRecoveryEngine; this is the package binding, symmetric with
    // `AIChatAgent`. Think keeps the `reason` parameter (its callers pass
    // `stable_timeout` | `recovery_error`) and the `recoveredRequestId` link in
    // the engine's root-id chain (supplied via the schedule payload). The
    // terminalize + stream/partial hooks are wired on the adapter above. See
    // design/rfc-chat-recovery-foundation.md.
    return this._chatRecoveryEngine().exhaustRecoveryGiveUp({
      callback,
      data,
      reason
    });
  }

  /**
   * Give-up after the stable-state-timeout retry budget drained. Thin wrapper
   * over `_exhaustRecoveryGiveUp` so the give-up cause is recorded as
   * `stable_timeout`.
   */
  private _exhaustRecoveryAfterStableTimeout(
    callback: ChatRecoveryScheduleCallback,
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined
  ): Promise<void> {
    return this._exhaustRecoveryGiveUp(callback, data, "stable_timeout");
  }

  /**
   * Handle an error thrown by `_chatRecoveryContinue` / `_chatRecoveryRetry`
   * after the incident was opened.
   *
   * - A platform transient (`isPlatformTransientError` from `agents` — a
   *   deploy code-update reset / script supersede, a `retryable`-flagged
   *   platform error, or "Network connection lost.", looking through wrappers
   *   like `SqlError` via the `cause` chain) is re-thrown (after best-effort
   *   marking the incident `failed` for observability) so
   *   `Agent._executeScheduleCallback` preserves the one-shot alarm row and
   *   the platform re-runs recovery once it is healthy again — the turn can
   *   still recover, so it must NOT terminalize. Terminalizing here was the
   *   #1730 freeze: the give-up's own seal needs the very storage that is
   *   down, so it throws too, burns the in-process retry budget inside the
   *   same reset window, and the row is consumed milliseconds before storage
   *   recovers. The submission is deliberately left `running` — the deferred
   *   re-run reads it via `_readRunningSubmissionByRequestId`, so marking it
   *   terminal here would turn the preserved row into a guaranteed
   *   `submission_not_running` no-op skip (a self-defeating defer).
   * - Any OTHER (application) error is terminalized through the give-up path
   *   (`onExhausted` + the `terminalMessage` banner) and NOT re-thrown. This is
   *   the fix for the silent-seal failure mode: `_executeScheduleCallback`
   *   swallows a non-transient throw and then `alarm()` deletes the one-shot
   *   row, so without terminalizing here the half-finished turn is dropped
   *   with no terminal event and no banner (the user stares at a frozen
   *   message until they send something new).
   */
  private async _handleRecoveryCallbackError(
    callback: ChatRecoveryScheduleCallback,
    data: ChatRecoveryContinueData | ChatRecoveryRetryData | undefined,
    error: unknown
  ): Promise<void> {
    if (isPlatformTransientError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this._updateChatRecoveryIncident(
          data?.incidentId,
          "failed",
          message
        );
      } catch (bookkeepingError) {
        // Best-effort observability only — in the exact window this branch
        // fires (deploy reset / storage outage) the incident write itself can
        // reject; that must not replace the deferral with its own error.
        console.error(
          "[Think] failed to mark recovery incident failed before deferring",
          bookkeepingError
        );
      }
      throw error;
    }
    // Preserve the underlying error for operators — the give-up path records
    // only the `recovery_error` category on the incident / `onExhausted` ctx,
    // so without this log the actual cause would be lost. Mirrors
    // `Agent._executeScheduleCallback`'s own logging.
    console.error(
      `[Think] ${callback} threw during recovery; terminalizing instead of leaving the turn wedged`,
      error
    );
    // `_exhaustRecoveryGiveUp` marks the submission interrupted + records the
    // terminal chat status itself (via `_exhaustChatRecovery`), so it fully
    // replaces the old mark-failed + complete-as-error bookkeeping here.
    await this._exhaustRecoveryGiveUp(callback, data, "recovery_error");
  }

  async _chatRecoveryRetry(data?: ChatRecoveryRetryData): Promise<void> {
    const recoveredSubmission = data?.recoveredRequestId
      ? this._readRunningSubmissionByRequestId(data.recoveredRequestId)
      : null;
    if (data?.recoveredRequestId && !recoveredSubmission) {
      await this._updateChatRecoveryIncident(
        data.incidentId,
        "skipped",
        "submission_not_running"
      );
      return;
    }

    const previousRootRequestId = this._activeChatRecoveryRootRequestId;
    this._activeChatRecoveryRootRequestId =
      data?.originalRequestId ?? previousRootRequestId;
    const controller = recoveredSubmission ? new AbortController() : null;
    if (recoveredSubmission && controller) {
      this._submissionAbortControllers.set(
        recoveredSubmission.submission_id,
        controller
      );
    }

    try {
      const recoveryConfig = this._resolveChatRecoveryConfig();
      const ready = await this.waitUntilStable({
        timeout: recoveryConfig.stableTimeoutMs
      });
      if (!ready) {
        // PARK while a CLIENT interaction is pending — the turn is waiting for
        // the human, not churning; see `_chatRecoveryContinue` for the full
        // rationale.
        if (await this._parkRecoveryForPendingInteraction(data)) {
          return;
        }
        // Transient under churn — reschedule within the attempt budget rather
        // than terminally failing the turn (see _chatRecoveryContinue).
        if (
          await this._rescheduleRecoveryAfterStableTimeout(
            "_chatRecoveryRetry",
            data,
            recoveryConfig.maxAttempts
          )
        ) {
          return;
        }
        // Budget spent: terminalize through the SAME exhaustion path as deploy
        // recovery (fires `onExhausted`, delivers the `terminalMessage` banner,
        // marks the submission interrupted) instead of silently dropping the
        // turn — otherwise an app relying on `onExhausted` sees an eternal
        // spinner.
        await this._exhaustRecoveryAfterStableTimeout(
          "_chatRecoveryRetry",
          data
        );
        return;
      }

      const lastLeaf = await this.session.getLatestLeaf();
      if (!lastLeaf || lastLeaf.role !== "user") {
        // The user turn is no longer the leaf — it was already answered (an
        // assistant message now follows) or the conversation moved on. This is
        // a benign skip, not an error: a completing turn marks the submission
        // `completed`; otherwise it is terminally `skipped`, never `error`.
        await this._updateChatRecoveryIncident(
          data?.incidentId,
          "skipped",
          "no_unanswered_user_message"
        );
        if (data?.recoveredRequestId) {
          await this._completeRecoveredSubmission(
            data.recoveredRequestId,
            "skipped",
            null,
            null
          );
        }
        return;
      }

      if (data?.targetUserId && lastLeaf.id !== data.targetUserId) {
        // Superseded by a genuinely newer user turn — terminal `skipped`, not an
        // error (recovery being superseded is benign).
        await this._updateChatRecoveryIncident(
          data?.incidentId,
          "skipped",
          "conversation_changed"
        );
        if (data?.recoveredRequestId) {
          await this._completeRecoveredSubmission(
            data.recoveredRequestId,
            "skipped",
            null,
            null
          );
        }
        return;
      }

      this._applyRecoveredRequestContext(data);
      const result = await this._retryLastUserTurn(
        this._lastClientTools,
        this._lastBody,
        controller
          ? { signal: controller.signal, trigger: "recovery-retry" }
          : { trigger: "recovery-retry" }
      );
      await this._updateChatRecoveryIncident(
        data?.incidentId,
        result.status === "completed"
          ? "completed"
          : result.status === "skipped"
            ? "skipped"
            : "failed",
        result.error
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
      await this._handleRecoveryCallbackError(
        "_chatRecoveryRetry",
        data,
        error
      );
    } finally {
      this._activeChatRecoveryRootRequestId = previousRootRequestId;
      if (recoveredSubmission) {
        this._submissionAbortControllers.delete(
          recoveredSubmission.submission_id
        );
      }
      // If this facet is an agent-tool child, its recovered turn just settled
      // outside `startAgentToolRun`'s finalizer — eagerly close the run so a
      // re-attached parent collects the terminal immediately rather than
      // waiting out a no-progress window. The pre-stream retry path settles a
      // fresh user turn that (like `continueLastTurn`) never hits the
      // finalizer, so it needs the same reconcile as `_chatRecoveryContinue`.
      await this._reconcileOwnStaleAgentToolChildRuns();
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
      await this._updateChatRecoveryIncident(
        data.incidentId,
        "skipped",
        "submission_not_running"
      );
      return;
    }

    const previousRootRequestId = this._activeChatRecoveryRootRequestId;
    this._activeChatRecoveryRootRequestId =
      data?.originalRequestId ?? previousRootRequestId;
    const controller = recoveredSubmission ? new AbortController() : null;
    if (recoveredSubmission && controller) {
      this._submissionAbortControllers.set(
        recoveredSubmission.submission_id,
        controller
      );
    }

    try {
      const recoveryConfig = this._resolveChatRecoveryConfig();
      const ready = await this.waitUntilStable({
        timeout: recoveryConfig.stableTimeoutMs
      });
      if (!ready) {
        // PARK, don't burn the budget: a stable-state timeout while a CLIENT
        // interaction is pending is not churn — the turn is correctly waiting
        // for the SPA to replay an interrupted tool-result / approval after
        // reconnect, which drives a fresh continuation via the auto-continuation
        // barrier independently of this retry loop. Retrying here would just
        // time out again (the human hasn't answered) and eventually seal a
        // healthy turn on `stable_timeout`. So stop the loop, resolve the live
        // "recovering…" indicator, and let the client's replay resume the turn.
        if (await this._parkRecoveryForPendingInteraction(data)) {
          return;
        }
        console.warn(
          "[Think] _chatRecoveryContinue timed out waiting for stable state"
        );
        // A stable-state timeout under deploy churn is usually transient (the
        // isolate is still settling / another deploy is in flight). Reschedule
        // within the attempt budget instead of terminally failing the turn at
        // attempt 1; only give up once the budget is genuinely exhausted.
        if (
          await this._rescheduleRecoveryAfterStableTimeout(
            "_chatRecoveryContinue",
            data,
            recoveryConfig.maxAttempts
          )
        ) {
          return;
        }
        // Budget spent: terminalize through the SAME exhaustion path as deploy
        // recovery (fires `onExhausted`, delivers the `terminalMessage` banner,
        // marks the submission interrupted) instead of silently dropping the
        // turn — otherwise an app relying on `onExhausted` sees an eternal
        // spinner.
        await this._exhaustRecoveryAfterStableTimeout(
          "_chatRecoveryContinue",
          data
        );
        return;
      }

      const targetId = data?.targetAssistantId;
      const lastLeaf = await this.session.getLatestLeaf();
      if (targetId && lastLeaf?.id !== targetId) {
        // The target assistant message is no longer the leaf. This is NOT an
        // error and must never clobber the submission to `error`:
        //  - leaf is an ASSISTANT message → recovery's OWN later continuation
        //    advanced (or already completed) this turn. This continuation is
        //    stale/superseded; skip benignly and leave the submission alone so
        //    the active continuation marks the real outcome (`completed`).
        //  - leaf is a USER message → a genuinely newer turn superseded this
        //    one; mark the submission `skipped` (terminal, non-error) so it
        //    doesn't hang waiting on a turn nobody will finish.
        const supersededByNewerUserTurn = lastLeaf?.role === "user";
        await this._updateChatRecoveryIncident(
          data?.incidentId,
          "skipped",
          "conversation_changed"
        );
        if (data?.recoveredRequestId && supersededByNewerUserTurn) {
          await this._completeRecoveredSubmission(
            data.recoveredRequestId,
            "skipped",
            null,
            null
          );
        }
        return;
      }

      this._applyRecoveredRequestContext(data);
      const result = await this.continueLastTurn(
        undefined,
        controller
          ? { signal: controller.signal, trigger: "recovery-continue" }
          : { trigger: "recovery-continue" }
      );
      await this._updateChatRecoveryIncident(
        data?.incidentId,
        result.status === "completed"
          ? "completed"
          : result.status === "skipped"
            ? "skipped"
            : "failed",
        result.error
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
      await this._handleRecoveryCallbackError(
        "_chatRecoveryContinue",
        data,
        error
      );
    } finally {
      this._activeChatRecoveryRootRequestId = previousRootRequestId;
      if (recoveredSubmission) {
        this._submissionAbortControllers.delete(
          recoveredSubmission.submission_id
        );
      }
      // If this facet is an agent-tool child, its recovered turn just settled
      // outside `startAgentToolRun`'s finalizer — eagerly close the run so a
      // re-attached parent collects the terminal immediately rather than
      // waiting out a no-progress window.
      await this._reconcileOwnStaleAgentToolChildRuns();
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
    hasSettledToolResults: boolean;
  } {
    return aiSdkRecoveryCodec.toRecoveryPartial(
      this._resumableStream.getStreamChunks(streamId).map((chunk) => chunk.body)
    );
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
    // A skipped turn settles out of the pre-stream set, but must NOT release
    // parked connections (#1784): a skip happens because a NEWER turn was
    // admitted (latest/merge supersede) or the queue generation advanced. The
    // earliest "successor exists" signal (`SubmitConcurrencyController.decide`)
    // fires before the successor's `_preStream.begin()`, so releasing here would
    // race a `begin()` that hasn't run yet and cut a parked client loose right
    // before the successor streams. Leave it parked: the successor flushes it on
    // stream start, or the final surviving turn's settle releases it. (Chat
    // clear releases parked connections explicitly via `resetTurnState`.)
    this._settlePreStreamTurn(requestId, { releaseParked: false });
  }

  /**
   * Mark an accepted turn (#1784) as settled. When `releaseParked` (the default)
   * and no accepted turn remains in flight and no stream is active, release every
   * connection parked on the pre-stream window with STREAM_RESUME_NONE. No-op once
   * they were flushed into STREAM_RESUMING on stream start. Skip paths pass
   * `releaseParked: false` so a parked client survives onto the successor turn
   * (see `_completeSkippedRequest`).
   */
  private _settlePreStreamTurn(
    requestId: string,
    options: { releaseParked?: boolean } = {}
  ): void {
    const idle = this._preStream.settle(requestId);
    const releaseParked = options.releaseParked ?? true;
    if (releaseParked && idle && !this._resumableStream.hasActiveStream()) {
      this._preStream.releaseAwaiting();
    }
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
    this._autoContinuation.schedule({
      connection,
      clientTools: this._lastClientTools,
      body: undefined,
      errorPrefix: "[Think] Auto-continuation failed:"
    });
  }

  /**
   * Re-arm the barrier for a tool result/approval that arrived WITHOUT
   * `autoContinue` (#1650). The client sends `autoContinue: false` for an
   * errored tool result (it declines to auto-continue a standalone error), but
   * in a parallel batch a SIBLING may already have requested continuation — and
   * this result can be the one that completes the batch. In that case we must
   * re-run the barrier check so the continuation the sibling requested still
   * fires once the batch is whole.
   *
   * Unlike `_scheduleAutoContinuation` this never CREATES a pending
   * continuation: a standalone errored tool (no opted-in sibling, so no pending)
   * must not auto-continue. It also no-ops once the continuation is running
   * (`pastCoalesce`) — a late result then defers/applies through the normal
   * path rather than re-arming.
   */
  private _rearmPendingAutoContinuationForBatch(): void {
    this._autoContinuation.rearmForBatch();
  }

  /**
   * Called when a streaming assistant turn finalizes (its message, with ALL
   * tool parts, is now persisted). Clears the in-flight accumulator and re-runs
   * the auto-continuation barrier for a continuation the stream-active gate held
   * (#1650). This is essential for an all-fast parallel batch whose every result
   * landed mid-stream: once the stream ends there is no further tool-result
   * event to re-arm the barrier, so without this re-check the held continuation
   * would never fire. A slow batch is also re-checked here and simply continues
   * to hold (event-driven) until its remaining siblings answer.
   */
  private _onStreamingTurnFinalized(): void {
    this._streamingAssistant = null;
    this._autoContinuation.rearmForBatch();
  }

  /**
   * Drain every in-flight tool-result/approval apply, including any enqueued
   * while we wait, so the subsequent `_hasIncompleteToolBatch()` re-check sees
   * every result that has ALREADY arrived. Bounded by real apply activity (a
   * storage write each), never by a fixed timer: a batch with no further
   * results drains in the time its pending applies take and then returns. The
   * loop re-reads `_interactionApplyTail` after each await because a sibling can
   * extend the tail mid-drain; we stop once the tail stops advancing.
   */
  private _drainInteractionApplies(): Promise<void> {
    return drainInteractionApplies(
      () => this._continuation.pending !== null,
      () => this._interactionApplyTail
    );
  }

  /**
   * `true` when the latest assistant message is mid-batch: it carries at least
   * one settled tool result AND at least one tool call/approval still awaiting a
   * client result. That is the #1649 signature — the model fanned out parallel
   * tool calls and only some have been answered. Scoped to the leaf (the step
   * the continuation answers) so an unrelated dangling tool in an earlier
   * message doesn't block a legitimate follow-up continuation.
   */
  private _hasIncompleteToolBatch(): boolean {
    return hasIncompleteToolBatch(this.messages);
  }

  private _fireAutoContinuation(): void {
    const pending = this._continuation.pending;
    if (!pending) return;

    const { connection, requestId, clientTools } = pending;
    const abortSignal = this._aborts.getSignal(requestId);

    this._admitTurn({
      admission: "queue",
      trigger: "auto-continuation",
      requestId,
      continuation: true,
      allowNested: true,
      execute: async () => {
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
      }
    }).catch((error) => {
      console.error("[Think] Auto-continuation failed:", error);
      this._aborts.remove(requestId);
    });
  }

  private _activateDeferredContinuation(): void {
    this._autoContinuation.activateDeferredAndReschedule();
  }

  /**
   * Run a continuation turn that does NOT require a live client connection.
   *
   * Used when a durable approval (a paused action or codemode execution) is
   * resolved via RPC from a surface with no open chat socket — e.g. an ops
   * dashboard, a webhook, or a voice backend approving hours/days later. The
   * connection-bound auto-continuation barrier (`_fireAutoContinuation`) cannot
   * fire without a `Connection`, so this mirrors its turn body but streams via
   * `broadcast` (a no-op when nobody is attached) and always persists, so a
   * client that reconnects later resumes the continued turn from history.
   *
   * Wrapped in `keepAliveWhile` because the resolving RPC returns before the
   * continuation finishes (mirrors the submission-drain pattern).
   */
  private _runConnectionlessContinuation(): void {
    void this.keepAliveWhile(async () => {
      const requestId = crypto.randomUUID();
      const abortSignal = this._aborts.getSignal(requestId);
      try {
        await this._admitTurn({
          admission: "queue",
          trigger: "auto-continuation",
          requestId,
          continuation: true,
          allowNested: true,
          execute: async () => {
            const continuationBody = async () => {
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
                    clientTools: this._lastClientTools,
                    body: this._lastBody,
                    continuation: true
                  })
              );
              if (result) {
                await this._streamResult(requestId, result, abortSignal, {
                  continuation: true
                });
              }
            };

            if (this.chatRecovery) {
              await this._runChatRecoveryFiber(
                requestId,
                true,
                continuationBody
              );
            } else {
              await continuationBody();
            }
          }
        });
      } catch (error) {
        console.error("[Think] Connection-less continuation failed:", error);
      } finally {
        this._aborts.remove(requestId);
      }
    });
  }

  // ── Response hook ──────────────────────────────────────────────

  /**
   * Render a reply attachment ({@link ReplyAttachment}) for delivery to the
   * active channel. Returns the text/markdown to post, or `undefined` to skip —
   * unknown types, or types a channel handles out of band (e.g. `voice_note`
   * via the voice transport). Override to customize per app/channel.
   */
  renderAttachment(
    attachment: ReplyAttachment
  ): string | { markdown: string } | undefined {
    switch (attachment.type) {
      case "card":
        return {
          markdown: `\`\`\`json\n${JSON.stringify(
            (attachment as { payload: unknown }).payload,
            null,
            2
          )}\n\`\`\``
        };
      case "email_draft": {
        const draft = attachment as { subject?: string; to?: string[] };
        const lines = ["**Email draft**"];
        if (draft.to?.length) lines.push(`To: ${draft.to.join(", ")}`);
        if (draft.subject) lines.push(`Subject: ${draft.subject}`);
        return { markdown: lines.join("\n") };
      }
      case "voice_note":
        return undefined;
      default:
        return undefined;
    }
  }

  /**
   * Deliver known reply attachments to the active channel (best-effort, never
   * fails the turn). Unknown types are ignored.
   */
  private async _renderChannelAttachments(
    attachments: ReplyAttachment[] | undefined
  ): Promise<void> {
    if (!attachments?.length) {
      return;
    }
    for (const attachment of attachments) {
      let rendered: string | { markdown: string } | undefined;
      try {
        rendered = this.renderAttachment(attachment);
      } catch (error) {
        console.warn(
          `[Think] renderAttachment threw: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      if (rendered === undefined) {
        continue;
      }
      try {
        await this.deliverNotice(rendered, { kind: "interim" });
      } catch (error) {
        console.warn(
          `[Think] failed to deliver channel attachment: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private async _fireResponseHook(result: ChatResponseResult): Promise<void> {
    // Surface advisory reply attachments recorded during this turn.
    result.attachments = this.replyAttachments(result.requestId);
    // Record the channel-level delivery for this turn (the turn-scoped channel
    // context is still set here — the response hook runs inside the turn body).
    const deliveredChannel = this._activeChannelContext;
    if (deliveredChannel) {
      this._emitChannelEvent({
        type: "channel:delivered",
        payload: {
          channel: deliveredChannel.channelId,
          kind: "final",
          turnEnded: true
        }
      });
    }
    await this._renderChannelAttachments(result.attachments);
    // Record the terminal status durably so a client connecting after the turn
    // ended still learns its outcome (see `_buildIdleConnectMessages`).
    await this._recordTerminalChatStatus(
      result.status,
      result.requestId,
      result.error ?? "The assistant was interrupted."
    );
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

  /**
   * Persist (on `error`/`interrupted`) or clear (on `completed`/`aborted`) the
   * durable terminal record so it can be replayed to clients on reconnect, and
   * resolve any in-progress "recovering…" indicator. A `completed`/`aborted`
   * turn is conveyed by the persisted messages, so the record is cleared; an
   * `error`/`interrupted` turn has no durable trace otherwise, so it is kept
   * until a later turn supersedes it.
   *
   * The storage primitives are shared with `@cloudflare/ai-chat`
   * (`_recordChatTerminal` / `_clearChatTerminal` / `_pendingChatTerminal`).
   */
  private async _recordTerminalChatStatus(
    status: ChatResponseResult["status"] | "interrupted",
    requestId: string,
    body: string
  ): Promise<void> {
    if (status === "error" || status === "interrupted") {
      await this._recordChatTerminal(requestId, body);
    } else {
      await this._clearChatTerminal();
    }
    // Any terminal turn outcome resolves an in-progress recovery (#1620): a
    // recovered turn that completes, errors, or is exhausted must clear the
    // "recovering…" indicator so it never spins forever.
    await this._setChatRecovering(false);
  }

  /**
   * Persist a durable record of the last terminal turn so a client that
   * (re)connects after the turn ended still learns its outcome (#1645). Kept
   * until a later turn supersedes it (`_clearChatTerminal`); a single record is
   * sufficient because only the most recent terminal is relevant.
   */
  private async _recordChatTerminal(
    requestId: string,
    body: string
  ): Promise<void> {
    await recordChatTerminal(this.ctx.storage, requestId, body);
  }

  /** Clear the durable terminal record once a later turn supersedes it (#1645). */
  private async _clearChatTerminal(): Promise<void> {
    await clearChatTerminal(this.ctx.storage);
  }

  private async _pendingChatTerminal(): Promise<{
    requestId: string;
    body: string;
  } | null> {
    return pendingChatTerminal(this.ctx.storage);
  }

  /**
   * Set or clear the live "recovering…" status for a durable chat turn (#1620).
   * Persists a durable record (replayed on connect via `_buildIdleConnectMessages`)
   * and broadcasts a `MSG_CHAT_RECOVERING` frame — but only on a genuine
   * transition, so a deploy/reconnect storm (which re-detects recovery many
   * times) doesn't spam the wire. Cleared on every terminal outcome so the
   * indicator can't spin forever.
   */
  private async _setChatRecovering(
    active: boolean,
    requestId?: string
  ): Promise<void> {
    await setChatRecovering(active, requestId, {
      storage: this.ctx.storage,
      messageType: MSG_CHAT_RECOVERING,
      broadcast: (frame) => this._broadcastChat(frame),
      now: Date.now()
    });
  }

  /**
   * Messages sent to a client on connect when no stream is active: the current
   * transcript, plus a replay of an in-progress "recovering…" status (if any).
   *
   * A terminal error is deliberately NOT replayed here. A bare
   * `MSG_CHAT_RESPONSE` frame on connect is dropped by the `useAgentChat`
   * client because it never reaches a transport stream reader, so it cannot
   * become `useChat.error` — a failed turn would still look frozen (#1645).
   * The terminal outcome is instead surfaced over the resume handshake (the
   * shared {@link ResumeHandshake} drives `STREAM_RESUMING` → ACK → terminal
   * error frame), the only path that lands on the stream reader.
   */
  private async _buildIdleConnectMessages(): Promise<
    Array<Record<string, unknown>>
  > {
    const messages: Array<Record<string, unknown>> = [
      { type: MSG_CHAT_MESSAGES, messages: this.messages }
    ];
    // Replay an in-progress "recovering…" status so a client that connects
    // mid-recovery reads the turn as working rather than frozen (#1620). This
    // is a plain status frame the client handles on connect (unlike a terminal
    // error, which must go through the resume handshake). It's mutually
    // exclusive with a terminal record (any terminal outcome clears recovering).
    // Skip a stale record (older than the flag TTL) so a turn whose recovery
    // was abandoned without a terminal can't show "recovering…" forever on
    // reconnect.
    const recoveringFrame = await buildChatRecoveringFrame(
      this.ctx.storage,
      MSG_CHAT_RECOVERING,
      Date.now()
    );
    if (recoveringFrame) {
      messages.push(recoveringFrame);
    }
    return messages;
  }

  // ── Resume helpers ──────────────────────────────────────────────

  /**
   * The shared resume-handshake driver (Tier-2). Lazily built; the
   * `ResumableStream` / `ContinuationState` / pending set are stable after
   * `onStart`, so a single instance threads them for the agent's lifetime. The
   * idle-connect payload (transcript + recovering, `_buildIdleConnectMessages`)
   * stays host-owned and is NOT part of the driver.
   */
  private _resumeHandshake(): ResumeHandshake {
    return (this._resumeHandshakeInstance ??= new ResumeHandshake({
      responseMessageType: MSG_CHAT_RESPONSE,
      resumableStream: this._resumableStream,
      continuation: this._continuation,
      preStream: this._preStream,
      pendingResumeConnections: this._pendingResumeConnections,
      pendingChatTerminal: () => this._pendingChatTerminal(),
      persistOrphanedStream: (streamId) =>
        this._persistOrphanedStream(streamId),
      isConnectionPresent: (connectionId) =>
        this.getConnection(connectionId) !== undefined
    }));
  }

  /**
   * Notify a connection about an active stream that can be resumed — delegates
   * to the shared {@link ResumeHandshake}. Kept as a thin method because it is
   * also called proactively from onConnect and the broadcast loop. See the
   * driver for the #1733 double-send contract.
   */
  private _notifyStreamResuming(connection: Connection): void {
    this._resumeHandshake().notifyStreamResuming(connection);
  }

  /**
   * Start a resumable stream and arm buffer cleanup. Wrapper around
   * `ResumableStream.start`: arming on START as well as finish guarantees a
   * stream whose DO is evicted mid-flight and never reaches a finish still gets
   * a future sweep instead of leaking its buffer.
   *
   * When a turn runs inside `runFiber` (durable recovery), the DO already
   * self-heals: `runFiber` holds `keepAlive`, which leaves a durable alarm in
   * storage that survives eviction, fires within ~keepAliveIntervalMs, and runs
   * the fiber-recovery scan — finalizing the stream (which arms cleanup) without
   * any client reconnect. Arming here is the safety net for any non-fiber stream
   * path, where no such alarm exists. The last-activity sweep threshold prevents
   * an actively streaming run from being reclaimed before it goes quiet (#1706).
   */
  protected _startResumableStream(
    requestId: string,
    options?: { messageId?: string }
  ): string {
    const streamId = this._resumableStream.start(requestId, options);
    // Flush connections parked during this turn's pre-stream window (#1784)
    // into STREAM_RESUMING now that a stream exists. No-op unless a client
    // reconnected before the first chunk. (Continuation-turn parks live in
    // `_continuation` and are flushed by the caller.)
    this._preStream.flushOnStreamStart((c) => this._notifyStreamResuming(c));
    void this._ensureStreamCleanupScheduled();
    return streamId;
  }

  /**
   * Mark a resumable stream completed and arm buffer cleanup. Wrapper around
   * `ResumableStream.complete` so every stream-finish path also schedules the
   * cleanup alarm (#1706).
   */
  protected _completeResumableStream(streamId: string): void {
    this._resumableStream.complete(streamId);
    void this._ensureStreamCleanupScheduled();
  }

  /**
   * Mark a resumable stream errored and arm buffer cleanup. Wrapper around
   * `ResumableStream.markError` — see {@link _completeResumableStream}.
   */
  protected _errorResumableStream(streamId: string): void {
    this._resumableStream.markError(streamId);
    void this._ensureStreamCleanupScheduled();
  }

  /**
   * Ensure a single cleanup alarm is pending for this DO's resumable-stream
   * buffers. Armed whenever a stream finishes so that idle/one-off chat DOs
   * still reclaim their buffers — the lazy sweep in {@link ResumableStream}
   * only fires when a *subsequent* stream completes, which never happens for a
   * chat that receives a single turn (#1706).
   *
   * `idempotent` dedupes on (callback, payload, owner) so repeated finishes
   * collapse onto one pending alarm rather than stacking.
   */
  protected async _ensureStreamCleanupScheduled({
    idempotent = true
  }: { idempotent?: boolean } = {}): Promise<void> {
    await this.schedule(
      STREAM_CLEANUP_DELAY_SECONDS,
      "_cleanupStreamBuffers",
      undefined,
      { idempotent }
    );
  }

  /**
   * Alarm callback: sweep aged stream buffers, re-arming while rows remain (see
   * the shared {@link cleanupStreamBuffers}).
   */
  async _cleanupStreamBuffers(): Promise<void> {
    await cleanupStreamBuffers(this._resumableStream, () =>
      this._ensureStreamCleanupScheduled({ idempotent: false })
    );
  }

  private async _persistOrphanedStream(streamId: string): Promise<void> {
    this._resumableStream.flushBuffer();
    const chunks = this._resumableStream.getStreamChunks(streamId);
    if (chunks.length === 0) return;

    // The accumulate loop and the `getMessage → update(merge) XOR append` upsert
    // are the shared `persistReconstructedOrphan` core. Think supplies the two
    // host-specific hooks:
    //   - prepare: `_strippedForPersist` (same as `_persistAssistantMessage`) —
    //     drop the internal final-answer parts and skip (`null`) an empty
    //     structural-only assistant message.
    //   - merge: Think replaces the whole message (no partial merge).
    // NOTE: progress is bumped at production/flush time in `_storeChunkDurably`
    // (#1637), NOT here — persisting on recovery or a client reconnect must not
    // be miscounted as new forward progress.
    const wrote = await persistReconstructedOrphan(chunks, {
      store: this._orphanStore(),
      fallbackId: crypto.randomUUID(),
      prepare: (message) => this._strippedForPersist(message),
      merge: (_existing, incoming) => incoming
    });
    if (wrote) this._broadcastMessages();
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

// Register the HITL methods as client-callable. Imperative registration
// (rather than `@callable()` decorator syntax on the methods) because TC39
// decorators don't survive every consumer toolchain that compiles this file
// from source (e.g. esbuild targeting ES2021).
for (const method of [
  Think.prototype.pendingExecutions,
  Think.prototype.pendingApprovals,
  Think.prototype.approveExecution,
  Think.prototype.rejectExecution
]) {
  callable()(method, undefined as unknown as ClassMethodDecoratorContext);
}
