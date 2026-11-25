/**
 * What a turn settles before the model is called: the unanswered tool calls
 * in the transcript. One rule for `@cloudflare/ai-chat` and
 * `@cloudflare/think`.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { UIMessage } from "ai";
import {
  repairInterruptedToolParts,
  replyIsEmpty,
  stripTrailingReasoning,
  type RepairInterruptedToolPartsOptions,
  type RepairInterruptedToolPartsResult
} from "./repair-transcript";
import { partAwaitsClientInteraction, toolPartName } from "./tool-state";

export interface BeforeTurnRepairOptions extends Pick<
  RepairInterruptedToolPartsOptions,
  "repairPart" | "isSettled" | "normalizeInput"
> {
  /**
   * `true` when the turn continues the last message (an auto-continuation
   * after a tool result or approval, `continueLastTurn`, a recovery
   * continue). `false` when it starts a new reply.
   */
  continuation: boolean;
  /** Names of the tools a client is known to run (the schemas it sent). */
  clientToolNames: ReadonlySet<string>;
}

export interface BeforeTurnRepairResult extends RepairInterruptedToolPartsResult {
  /**
   * The calls a continuation turn left unanswered on purpose, because a
   * client is known to still answer them. When this is not empty the turn
   * has nothing to continue yet and must not call the model: the request
   * would hold a call with no result. The client's answer starts the
   * continuation.
   */
  keptToolCallIds: string[];
}

/**
 * Settle the tool calls the transcript leaves unanswered, before a turn calls
 * the model. A provider rejects a request that holds a tool call with no
 * result (`AI_MissingToolResultsError`), so a call nothing will answer in
 * time has to become a result first.
 *
 * - In a reply the conversation has moved past (any message a later message
 *   follows), every unanswered call is settled, whoever owns it: a server
 *   tool whose `execute()` died, a client tool the user never answered, an
 *   approval the user never gave, an approved call that never ran. The turn
 *   cannot succeed otherwise, a late answer has no continuation to run
 *   (`ChatTurns.takeContinuation`), and the AI SDK runs an approved call
 *   only in the last message.
 * - A turn that starts a new reply treats the last message the same way,
 *   except for an approved call, which the AI SDK runs. Its reply follows
 *   that message, so it moves past it.
 * - A continuation turn continues the last message. There it keeps what a
 *   client is known to still answer: an `input-available` call for a tool
 *   the client sent a schema for, and an `approval-requested` call. They are
 *   reported as `keptToolCallIds`, and the turn does not call the model
 *   while there are any. Any other unanswered call there is dead and is
 *   settled. An approved call is kept: the turn is about to run it.
 *
 * - An assistant message that ends in reasoning has it removed
 *   (`stripTrailingReasoning`), in every message and for every turn.
 *   Anthropic rejects a request in which an assistant message's final block
 *   is a thinking block.
 *
 * A settled call goes through `repairPart`, the host's
 * `repairInterruptedToolPart` hook, which by default turns it into an errored
 * result ({@link interruptedToolPartAsError}).
 *
 * Pure. The host persists and broadcasts what changed.
 */
export function repairTranscriptBeforeTurn(
  messages: UIMessage[],
  options: BeforeTurnRepairOptions
): BeforeTurnRepairResult {
  const { continuation, clientToolNames } = options;
  const keptToolCallIds: string[] = [];
  const result = repairInterruptedToolParts(messages, {
    repairPart: options.repairPart,
    isSettled: options.isSettled,
    normalizeInput: options.normalizeInput,
    shouldRepair: (part, { isLastMessage }) => {
      const kept =
        continuation &&
        isLastMessage &&
        partAwaitsClientInteraction(part, clientToolNames);
      if (kept) {
        keptToolCallIds.push((part as { toolCallId: string }).toolCallId);
      }
      return !kept;
    },
    // The last message's approved calls are always kept.
    repairApprovalResponded: true,
    // A continuation turn writes into the last message.
    keepEmptyLastMessage: continuation
  });
  return { ...result, keptToolCallIds };
}

/**
 * Whether the message a continuation turn would continue still waits on a
 * client: the last message holds an `input-available` call for a tool the
 * client sent a schema for, or an `approval-requested` call. Then there is
 * nothing to continue yet. A host asks this first, before the turn stores
 * anything, and ends the turn without calling the model. It is the same test
 * {@link repairTranscriptBeforeTurn} uses for `keptToolCallIds`.
 */
export function continuationWaitsOnClient(
  messages: ReadonlyArray<{ role: string; parts: ReadonlyArray<unknown> }>,
  clientToolNames: ReadonlySet<string>
): boolean {
  const last = messages.at(-1);
  return (
    last?.role === "assistant" &&
    last.parts.some((part) =>
      partAwaitsClientInteraction(part, clientToolNames)
    )
  );
}

/**
 * Whether the message a continuation turn would continue holds nothing once
 * the reasoning it ends in is gone ({@link replyIsEmpty}). There is nothing
 * to continue: the before-turn repair would strip it and leave an empty
 * message stored. A host asks this with {@link continuationWaitsOnClient},
 * before the turn stores anything. The next turn that starts a new reply
 * removes the message.
 */
export function replyToContinueIsEmpty(
  messages: ReadonlyArray<UIMessage>
): boolean {
  const last = messages.at(-1);
  return (
    last?.role === "assistant" && replyIsEmpty(stripTrailingReasoning(last))
  );
}

/**
 * The default for the hosts' `repairInterruptedToolPart` hook: the call
 * becomes an errored result, so the record survives and the provider gets a
 * result for it. The text says what is known about the call:
 *
 * - a call to a tool the client runs (`clientToolNames`): the conversation
 *   moved on before its result arrived. The tool may have run, and a result
 *   that arrives later is ignored, so the model is told it may have run;
 * - an approval the user never gave: the tool did not run;
 * - an approved call no turn ran: it did not run;
 * - anything else: a server tool whose execution was cut off. Its side
 *   effects may have happened, so the model is told it may have run.
 */
export function interruptedToolPartAsError(
  part: UIMessage["parts"][number],
  context: { clientToolNames?: ReadonlySet<string> } = {}
): UIMessage["parts"][number] {
  const record = part as Record<string, unknown>;
  const toolName = toolPartName(record);
  const errorText =
    record.state === "approval-responded"
      ? INTERRUPTED_TOOL_ERROR_TEXT.approvedNotRun
      : record.state === "approval-requested"
        ? INTERRUPTED_TOOL_ERROR_TEXT.approvalNotGiven
        : record.state === "input-available" &&
            toolName !== undefined &&
            context.clientToolNames?.has(toolName)
          ? INTERRUPTED_TOOL_ERROR_TEXT.clientNotAnswered
          : INTERRUPTED_TOOL_ERROR_TEXT.interrupted;
  return {
    ...part,
    state: "output-error",
    errorText
  } as UIMessage["parts"][number];
}

/** The texts {@link interruptedToolPartAsError} gives the model. */
export const INTERRUPTED_TOOL_ERROR_TEXT = {
  interrupted:
    "The tool call was interrupted before a result was recorded. The tool may still have run.",
  approvedNotRun:
    "The tool call was approved but did not run before the next turn started.",
  approvalNotGiven:
    "The conversation moved on before this tool call was approved or denied. It did not run.",
  clientNotAnswered:
    "The conversation moved on before this tool call was answered. The tool may still have run."
} as const;
