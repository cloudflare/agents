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

/** Which turn the before-turn repair runs for. */
export interface BeforeTurnRepairMode {
  /**
   * `true` when the turn continues the last message (an auto-continuation
   * after a tool result or approval, `continueLastTurn`, a recovery
   * continue). `false` when it starts a new reply.
   */
  continuation: boolean;
  /**
   * `true` while a continuation is scheduled and has not started. An
   * approved call it may still run is kept.
   */
  continuationWaiting: boolean;
}

export interface BeforeTurnRepairOptions
  extends
    BeforeTurnRepairMode,
    Pick<
      RepairInterruptedToolPartsOptions,
      "repairPart" | "isSettled" | "normalizeInput"
    > {
  /** Names of the tools a client is known to run (the schemas it sent). */
  clientToolNames: ReadonlySet<string>;
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
 *   approval the user never gave. The turn cannot succeed otherwise, and a
 *   late answer has no continuation to run (`ChatTurns.takeContinuation`).
 * - A turn that starts a new reply treats the last message the same way. Its
 *   reply follows that message, so it moves past it.
 * - A continuation turn continues the last message. There it keeps what a
 *   client is known to still answer: an `input-available` call for a tool
 *   the client sent a schema for, and an `approval-requested` call. Any
 *   other unanswered call there is dead and is settled.
 * - An approved call that has not run (`approval-responded`) is kept in the
 *   last message, where the AI SDK runs it. In an earlier message it is
 *   settled only by a turn that starts a new reply while no continuation is
 *   waiting.
 *
 * A settled call goes through `repairPart`, the host's
 * `repairInterruptedToolPart` hook, which by default turns it into an errored
 * result.
 *
 * Pure. The host persists and broadcasts what changed.
 */
export function repairTranscriptBeforeTurn(
  messages: UIMessage[],
  options: BeforeTurnRepairOptions
): RepairInterruptedToolPartsResult {
  const { continuation, clientToolNames } = options;
  return repairInterruptedToolParts(messages, {
    repairPart: options.repairPart,
    isSettled: options.isSettled,
    normalizeInput: options.normalizeInput,
    shouldRepair: (part, { isLastMessage }) =>
      !(
        continuation &&
        isLastMessage &&
        partAwaitsClientInteraction(part, clientToolNames)
      ),
    repairApprovalResponded: !continuation && !options.continuationWaiting
  });
}

/**
 * Whether the before-turn repair left `part` unanswered on purpose: a
 * continuation turn keeps, in the message it continues, a call a client is
 * known to still answer.
 */
export function keptByContinuationRepair(
  part: unknown,
  context: {
    continuation: boolean;
    isLastMessage: boolean;
    clientToolNames: ReadonlySet<string>;
  }
): boolean {
  return (
    context.continuation &&
    context.isLastMessage &&
    partAwaitsClientInteraction(part, context.clientToolNames)
  );
}
