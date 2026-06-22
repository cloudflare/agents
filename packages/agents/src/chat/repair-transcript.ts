/**
 * Transcript repair — flip interrupted tool calls (a `tool-*` / `dynamic-tool`
 * part with no settled result, left behind when a stream was cut off mid-flight)
 * into a settled shape so the next provider call does not 400 with
 * `AI_MissingToolResultsError`, and normalize malformed tool `input`.
 *
 * This is the shared, host-agnostic core extracted from `@cloudflare/think`'s
 * `_repairToolTranscriptParts`. Both AI-SDK chat hosts (`@cloudflare/think` and
 * `@cloudflare/ai-chat`) run it before re-entering inference on a recovered turn
 * so an interrupted SERVER tool (whose `execute()` died with the evicted
 * isolate, leaving an `input-available` orphan that nothing will ever resolve)
 * is converted to an errored tool-result and the turn can continue, instead of
 * being abandoned.
 *
 * Pure: it returns a new messages array plus repair stats and never touches
 * storage, broadcast, or events — the host owns those side effects.
 *
 * @internal Shared chat-recovery internals; not a public API.
 */

import type { UIMessage } from "ai";
import { normalizeToolInput } from "./message-builder";

/**
 * Whether a tool part already has a settled result the provider accepts, so it
 * must NOT be re-repaired into an errored result.
 *
 * Single source of truth for the terminal tool states. Mirrors the AI SDK's
 * terminal states: `convertToModelMessages` emits a `tool-result` for
 * `output-available`, `output-error`, AND `output-denied` (a user-denied
 * approval — its denial reason becomes the tool-result). Omitting any of these
 * makes repair re-flip the part every turn — clobbering a real `errorText` /
 * denial with the generic "interrupted" message.
 */
export function toolPartHasSettledResult(
  record: Record<string, unknown>
): boolean {
  if ("output" in record || "result" in record) return true;
  const state = typeof record.state === "string" ? record.state : "";
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

export interface RepairInterruptedToolPartsOptions {
  /**
   * Decide the replacement for an interrupted tool part (no settled result, not
   * `approval-responded`). Its `input` has already been normalized to a valid
   * object. The default host behavior flips it to an errored tool-result; hosts
   * expose this as an overridable `repairInterruptedToolPart` hook so a subclass
   * can, e.g., convert an interrupted client-resolved tool into a text part.
   */
  repairPart: (part: UIMessage["parts"][number]) => UIMessage["parts"][number];
  /**
   * Whether a tool part already carries a settled result (defaults to
   * {@link toolPartHasSettledResult}).
   */
  isSettled?: (record: Record<string, unknown>) => boolean;
  /**
   * Normalize a tool part's `input` (defaults to the shared
   * {@link normalizeToolInput}).
   */
  normalizeInput?: (input: unknown) => { input: unknown; changed: boolean };
  /**
   * Whether an interrupted tool part (no settled result, not
   * `approval-responded`) should be repaired at all. Defaults to `true` (repair
   * everything, like Think — which converts even client tools via its
   * `repairPart` override). A host whose default `repairPart` errors the part
   * (ai-chat) passes this to SKIP a part still legitimately awaiting a CLIENT
   * interaction (an `input-available` client tool or an `approval-requested`
   * part the user may still answer) so it is left verbatim rather than clobbered
   * with an error. Skipped parts are not counted in `removedToolCalls`.
   */
  shouldRepair?: (part: UIMessage["parts"][number]) => boolean;
}

export interface RepairInterruptedToolPartsResult {
  /** A new messages array; unchanged messages keep their original reference. */
  messages: UIMessage[];
  /** Count of interrupted tool calls flipped to a repaired shape. */
  removedToolCalls: number;
  /** Count of tool parts whose malformed `input` was normalized. */
  normalizedInputs: number;
  /** The tool-call ids that were repaired. */
  toolCallIds: string[];
}

/**
 * Repair interrupted tool calls and normalize malformed tool inputs across a
 * transcript. Behavior mirrors `@cloudflare/think`'s original
 * `_repairToolTranscriptParts`:
 *
 *   - a tool part with NO settled result and state `approval-responded` is kept
 *     verbatim (an approved server tool waiting for its continuation to run
 *     `execute()` — not abandoned);
 *   - a tool part with NO settled result for which `shouldRepair` returns false
 *     is kept verbatim (a part still awaiting a CLIENT interaction; see option);
 *   - any other tool part with no settled result is normalized then handed to
 *     `repairPart` (default: flipped to an errored result);
 *   - a tool part WITH a settled result only has its `input` normalized.
 *
 * Messages with no changed part keep their original object reference so callers
 * can cheaply detect what to persist.
 */
export function repairInterruptedToolParts(
  messages: UIMessage[],
  options: RepairInterruptedToolPartsOptions
): RepairInterruptedToolPartsResult {
  const isSettled = options.isSettled ?? toolPartHasSettledResult;
  const normalizeInput = options.normalizeInput ?? normalizeToolInput;
  const { repairPart } = options;
  const shouldRepair = options.shouldRepair ?? (() => true);

  let removedToolCalls = 0;
  let normalizedInputs = 0;
  const toolCallIds: string[] = [];
  const repaired: UIMessage[] = [];

  for (const message of messages) {
    const parts: UIMessage["parts"] = [];
    let messageChanged = false;
    for (const part of message.parts) {
      const record = part as Record<string, unknown>;
      const toolCallId =
        typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      const isToolPart =
        typeof record.type === "string" &&
        (record.type.startsWith("tool-") || record.type === "dynamic-tool") &&
        toolCallId;
      if (!isToolPart) {
        parts.push(part);
        continue;
      }

      if (!isSettled(record)) {
        const state = typeof record.state === "string" ? record.state : "";
        // An approved server tool waits at `approval-responded` until its
        // scheduled continuation runs `execute()`. It is not abandoned, so
        // preserve it verbatim — flipping it to an error (or removing it) would
        // strand the approval and prevent the real result from ever being
        // produced by the continuation.
        if (state === "approval-responded") {
          parts.push(part);
          continue;
        }
        // A part still legitimately awaiting a CLIENT interaction (the host's
        // `shouldRepair` returns false) is left verbatim — erroring it would
        // clobber a tool-result / approval the client may still replay. Only
        // hosts whose default repair ERRORS the part opt into this; Think keeps
        // the default (repair everything, converting client tools via its hook).
        if (!shouldRepair(part)) {
          parts.push(part);
          continue;
        }
        // Preserve the interrupted/abandoned tool call instead of deleting it.
        // Deleting makes the call "disappear" from the (broadcast) transcript
        // and lets the model silently re-run it. `input` is normalized to a
        // valid object first, then `repairPart` decides the replacement shape
        // (default: an errored result, so conversion still gets a tool-result
        // and the provider doesn't 400 with AI_MissingToolResultsError).
        const normalized = normalizeInput(
          "input" in record ? record.input : undefined
        );
        parts.push(
          repairPart({
            ...part,
            input: normalized.input
          } as UIMessage["parts"][number])
        );
        if (normalized.changed) normalizedInputs++;
        removedToolCalls++;
        messageChanged = true;
        toolCallIds.push(toolCallId);
        continue;
      }

      const normalized = normalizeInput(
        "input" in record ? record.input : undefined
      );
      if (normalized.changed) {
        parts.push({
          ...part,
          input: normalized.input
        } as UIMessage["parts"][number]);
        normalizedInputs++;
        messageChanged = true;
        continue;
      }

      parts.push(part);
    }

    repaired.push(messageChanged ? { ...message, parts } : message);
  }

  return {
    messages: repaired,
    removedToolCalls,
    normalizedInputs,
    toolCallIds
  };
}
