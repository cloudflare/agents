/**
 * Serializable snapshots for passing context to sandboxed extension
 * Workers during hook dispatch.
 *
 * Extension Workers can't receive TurnContext directly (it contains
 * functions like ToolSet). These snapshots are plain data objects
 * that survive Workers RPC serialization (structured clone).
 */

import type { TurnContext, TurnConfig } from "../think";

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
