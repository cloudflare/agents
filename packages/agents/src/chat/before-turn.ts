/**
 * What a turn settles before the model is called: the stored request context
 * and the unanswered tool calls in the transcript. One rule for
 * `@cloudflare/ai-chat` and `@cloudflare/think`.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { UIMessage } from "ai";
import type { ClientToolSchema } from "./client-tools";
import {
  repairInterruptedToolParts,
  type RepairInterruptedToolPartsOptions,
  type RepairInterruptedToolPartsResult
} from "./repair-transcript";
import { partAwaitsClientInteraction } from "./tool-state";

/** The tools and body a chat request leaves stored for later turns. */
export interface ClientRequestContext {
  clientTools: ClientToolSchema[] | undefined;
  body: Record<string, unknown> | undefined;
}

/**
 * The request context a client's chat request stores when its turn starts.
 *
 * The request replaces the stored context whole. One that sends no client
 * tools (no `clientTools` key, or an empty list) clears the stored tools: the
 * tools a turn offers the model are the ones the client that sent the request
 * can run, never the ones an earlier request from another client left behind.
 * The same goes for the body.
 */
export function clientRequestContext(request: {
  clientTools?: ClientToolSchema[] | null;
  body?: Record<string, unknown> | null;
}): ClientRequestContext {
  const { clientTools, body } = request;
  return {
    clientTools:
      Array.isArray(clientTools) && clientTools.length > 0
        ? clientTools
        : undefined,
    body: body && Object.keys(body).length > 0 ? body : undefined
  };
}

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
    repairApprovalResponded: true
  });
  return { ...result, keptToolCallIds };
}

/**
 * The default for the hosts' `repairInterruptedToolPart` hook: the call
 * becomes an errored result, so the record survives and the provider gets a
 * result for it.
 */
export function interruptedToolPartAsError(
  part: UIMessage["parts"][number]
): UIMessage["parts"][number] {
  return {
    ...part,
    state: "output-error",
    errorText:
      (part as { state?: string }).state === "approval-responded"
        ? "The tool call was approved but did not run before the next turn started."
        : "The tool call was interrupted before a result was recorded."
  } as UIMessage["parts"][number];
}
