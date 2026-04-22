/**
 * Serializable snapshots for passing context to sandboxed extension
 * Workers during hook dispatch.
 *
 * Extension Workers can't receive AI SDK or Think objects directly (they
 * contain functions, AbortSignals, class instances, etc.). These snapshots
 * are plain JSON-safe data objects that survive Workers RPC serialization.
 */

import type { TurnContext, TurnConfig } from "../think";

/**
 * Best-effort JSON-safe normalization. Strips functions, AbortSignals,
 * symbols, and replaces `Error` instances with `{ name, message, stack }`.
 * Falls back to `String(value)` for anything that won't round-trip.
 */
function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 6) return undefined;
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") return String(value);
  if (t === "function" || t === "symbol") return undefined;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1));
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Skip non-cloneable hosts like AbortSignal which carry event listeners.
      if (v instanceof AbortSignal) continue;
      const safe = jsonSafe(v, depth + 1);
      if (safe !== undefined) out[k] = safe;
    }
    return out;
  }
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

/**
 * Serializable snapshot of TurnContext.
 * Passed to extension Workers during beforeTurn hook dispatch.
 * Plain data — no methods, no functions, no classes.
 */
export interface TurnContextSnapshot {
  system: string;
  toolNames: string[];
  messageCount: number;
  continuation: boolean;
  body?: Record<string, unknown>;
  modelId: string;
}

/**
 * Create a serializable snapshot from a TurnContext.
 */
export function createTurnContextSnapshot(
  ctx: TurnContext
): TurnContextSnapshot {
  return {
    system: ctx.system,
    toolNames: Object.keys(ctx.tools),
    messageCount: ctx.messages.length,
    continuation: ctx.continuation,
    body: ctx.body,
    modelId:
      ((ctx.model as Record<string, unknown>).modelId as string) ?? "unknown"
  };
}

/**
 * Parse a hook result from the extension Worker's JSON response.
 * Returns a TurnConfig or null if the extension skipped/errored.
 */
export function parseHookResult(
  json: string
): { config: TurnConfig } | { skipped: true } | { error: string } {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed.skipped) return { skipped: true };
    if (parsed.error) return { error: parsed.error as string };
    return { config: (parsed.result ?? {}) as TurnConfig };
  } catch {
    return { error: "Failed to parse hook result" };
  }
}

// ── Per-tool / per-step / per-chunk snapshots ─────────────────────────
// These are observation-only snapshots — extensions cannot return data
// that influences the turn (block/substitute/cancel etc.). Keep the
// payloads small; extensions that need richer state should subscribe
// to `beforeTurn` (which gives them the full TurnContextSnapshot) and
// stash references there.

/** Snapshot for the `beforeToolCall` hook. */
export interface ToolCallStartSnapshot {
  toolName: string;
  toolCallId: string;
  input: unknown;
  stepNumber: number | undefined;
  dynamic?: boolean;
}

/** Snapshot for the `afterToolCall` hook. */
export interface ToolCallFinishSnapshot {
  toolName: string;
  toolCallId: string;
  input: unknown;
  stepNumber: number | undefined;
  durationMs: number;
  success: boolean;
  output?: unknown;
  /** Normalized error: `{ name, message, stack }` for Error instances, otherwise `String(error)`. */
  error?: unknown;
  dynamic?: boolean;
}

/** Snapshot for the `onStepFinish` hook. */
export interface StepFinishSnapshot {
  stepNumber: number;
  finishReason: string;
  text: string;
  reasoningText: string | undefined;
  toolCallCount: number;
  toolResultCount: number;
  usage:
    | {
        inputTokens: number | undefined;
        outputTokens: number | undefined;
        totalTokens: number | undefined;
        reasoningTokens: number | undefined;
        cachedInputTokens: number | undefined;
      }
    | undefined;
  /** Provider-specific metadata (e.g. Anthropic cache accounting). */
  providerMetadata: Record<string, unknown> | undefined;
}

/** Snapshot for the `onChunk` hook. High-frequency — keep minimal. */
export interface ChunkSnapshot {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
}

export function createToolCallStartSnapshot(event: {
  toolCall: {
    toolName: string;
    toolCallId: string;
    input?: unknown;
    dynamic?: boolean;
  };
  stepNumber: number | undefined;
}): ToolCallStartSnapshot {
  return {
    toolName: event.toolCall.toolName,
    toolCallId: event.toolCall.toolCallId,
    input: jsonSafe(event.toolCall.input),
    stepNumber: event.stepNumber,
    ...(event.toolCall.dynamic !== undefined
      ? { dynamic: event.toolCall.dynamic }
      : {})
  };
}

export function createToolCallFinishSnapshot(event: {
  toolCall: {
    toolName: string;
    toolCallId: string;
    input?: unknown;
    dynamic?: boolean;
  };
  stepNumber: number | undefined;
  durationMs: number;
  success: boolean;
  output?: unknown;
  error?: unknown;
}): ToolCallFinishSnapshot {
  return {
    toolName: event.toolCall.toolName,
    toolCallId: event.toolCall.toolCallId,
    input: jsonSafe(event.toolCall.input),
    stepNumber: event.stepNumber,
    durationMs: event.durationMs,
    success: event.success,
    ...(event.success
      ? { output: jsonSafe(event.output) }
      : { error: jsonSafe(event.error) }),
    ...(event.toolCall.dynamic !== undefined
      ? { dynamic: event.toolCall.dynamic }
      : {})
  };
}

export function createStepFinishSnapshot(event: {
  stepNumber: number;
  finishReason: string;
  text: string;
  reasoningText: string | undefined;
  toolCalls: ReadonlyArray<unknown>;
  toolResults: ReadonlyArray<unknown>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  };
  providerMetadata?: Record<string, unknown>;
}): StepFinishSnapshot {
  return {
    stepNumber: event.stepNumber,
    finishReason: event.finishReason,
    text: event.text,
    reasoningText: event.reasoningText,
    toolCallCount: event.toolCalls.length,
    toolResultCount: event.toolResults.length,
    usage: event.usage
      ? {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          totalTokens: event.usage.totalTokens,
          reasoningTokens: event.usage.reasoningTokens,
          cachedInputTokens: event.usage.cachedInputTokens
        }
      : undefined,
    providerMetadata: event.providerMetadata as
      | Record<string, unknown>
      | undefined
  };
}

export function createChunkSnapshot(event: {
  chunk: { type: string; [key: string]: unknown };
}): ChunkSnapshot {
  const c = event.chunk;
  const snapshot: ChunkSnapshot = { type: c.type };
  // text-delta / reasoning-delta carry `text`
  if (typeof c.text === "string") snapshot.text = c.text;
  // tool-related chunks carry tool identifiers
  if (typeof c.toolName === "string") snapshot.toolName = c.toolName;
  if (typeof c.toolCallId === "string") snapshot.toolCallId = c.toolCallId;
  return snapshot;
}
