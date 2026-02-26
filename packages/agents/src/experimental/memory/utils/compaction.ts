/**
 * MicroCompaction Utilities
 *
 * Internal pure functions for lightweight compaction (no LLM).
 * Not exported to users — used by the Session wrapper.
 */

import type { UIMessage } from "ai";
import type { MicroCompactionRules } from "../session/types";

/** Default thresholds for microCompaction rules (in chars) */
export const DEFAULTS = {
  truncateToolOutputs: 30000,
  truncateText: 10000,
  keepRecent: 4
};

/** Resolved microCompaction rules with actual numeric thresholds */
export interface ResolvedMicroCompactionRules {
  truncateToolOutputs: number | false;
  truncateText: number | false;
  keepRecent: number;
}

/**
 * Parse microCompaction config into resolved rules.
 * Returns null if disabled.
 */
export function parseMicroCompactionRules(
  config: boolean | MicroCompactionRules
): ResolvedMicroCompactionRules | null {
  if (config === false) return null;

  if (config === true) {
    return {
      truncateToolOutputs: DEFAULTS.truncateToolOutputs,
      truncateText: DEFAULTS.truncateText,
      keepRecent: DEFAULTS.keepRecent
    };
  }

  // Custom rules object — validate numeric values
  const keepRecent = config.keepRecent ?? DEFAULTS.keepRecent;
  if (!Number.isInteger(keepRecent) || keepRecent < 0) {
    throw new Error("keepRecent must be a non-negative integer");
  }

  const truncateToolOutputs =
    config.truncateToolOutputs === false
      ? false
      : config.truncateToolOutputs === true ||
          config.truncateToolOutputs === undefined
        ? DEFAULTS.truncateToolOutputs
        : config.truncateToolOutputs;
  if (typeof truncateToolOutputs === "number" && truncateToolOutputs <= 0) {
    throw new Error("truncateToolOutputs must be a positive number");
  }

  const truncateText =
    config.truncateText === false
      ? false
      : config.truncateText === true || config.truncateText === undefined
        ? DEFAULTS.truncateText
        : config.truncateText;
  if (typeof truncateText === "number" && truncateText <= 0) {
    throw new Error("truncateText must be a positive number");
  }

  return { truncateToolOutputs, truncateText, keepRecent };
}

/**
 * Truncate oversized parts in a single message.
 * Returns the same reference if nothing changed (allows callers to skip no-op updates).
 */
function truncateMessageParts(
  msg: UIMessage,
  rules: ResolvedMicroCompactionRules
): UIMessage {
  let changed = false;

  const compactedParts = msg.parts.map((part) => {
    // Truncate tool outputs
    if (
      rules.truncateToolOutputs !== false &&
      (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
      "output" in part
    ) {
      const toolPart = part as { output?: unknown };
      if (toolPart.output !== undefined) {
        const outputJson = JSON.stringify(toolPart.output);
        if (outputJson.length > rules.truncateToolOutputs) {
          changed = true;
          return {
            ...part,
            output: `[Truncated ${outputJson.length} bytes] ${outputJson.slice(0, 500)}...`
          };
        }
      }
    }

    // Truncate long text parts
    if (
      rules.truncateText !== false &&
      part.type === "text" &&
      "text" in part
    ) {
      const textPart = part as { type: "text"; text: string };
      if (textPart.text.length > rules.truncateText) {
        changed = true;
        return {
          ...part,
          text: `${textPart.text.slice(0, rules.truncateText)}... [truncated ${textPart.text.length} chars]`
        };
      }
    }

    return part;
  });

  return changed ? ({ ...msg, parts: compactedParts } as UIMessage) : msg;
}

/**
 * Apply microCompaction to an array of messages.
 * Returns same reference for unchanged messages (enables skip-update optimization).
 *
 * No keepRecent logic — the caller decides which messages to pass.
 */
export function microCompact(
  messages: UIMessage[],
  rules: ResolvedMicroCompactionRules
): UIMessage[] {
  return messages.map((msg) => truncateMessageParts(msg, rules));
}
