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
import { normalizeToolInput, settleInterruptedPart } from "./message-builder";
import { cutOffReplyToSettle } from "./recovery-attempt";
import { partAwaitsClientInteraction } from "./tool-state";

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

/** The tool call id of a tool part, or `undefined` for any other part. */
function toolCallIdOf(record: Record<string, unknown>): string | undefined {
  const isToolPart =
    typeof record.type === "string" &&
    (record.type.startsWith("tool-") || record.type === "dynamic-tool");
  return isToolPart &&
    typeof record.toolCallId === "string" &&
    record.toolCallId.length > 0
    ? record.toolCallId
    : undefined;
}

/**
 * Remove the reasoning an assistant message ends in.
 *
 * Anthropic rejects a request in which an assistant message's final block
 * is a thinking block ("The final block in an assistant message cannot be
 * `thinking`"), whether that message is the last one or a user message or a
 * tool result follows it. A reply cut off right after the model's reasoning
 * is stored in exactly that shape, and would fail every later request.
 *
 * `convertToModelMessages` turns each step of a UI message into its own
 * assistant message, and the Anthropic provider joins consecutive ones. So
 * reasoning is safe when anything the model is sent comes after it in the
 * message (text, a file, a tool call), in the same step or a later one, and
 * unsafe only at the end. This removes every reasoning part after the last
 * such part, then the `step-start` markers left with nothing after them.
 * A text part with no text goes with it: it is the start of an answer the
 * model never wrote, and a continuation would write its answer into it, in
 * front of its own reasoning. Parts that send nothing to the model but that
 * a client shows (sources, data parts) are kept.
 *
 * @returns The same message when it does not end in reasoning.
 */
export function stripTrailingReasoning<TMessage extends UIMessage>(
  message: TMessage
): TMessage {
  if (message.role !== "assistant") return message;
  let lastContent = -1;
  for (let i = message.parts.length - 1; i >= 0; i--) {
    if (partSendsContent(message.parts[i])) {
      lastContent = i;
      break;
    }
  }
  const tail = message.parts.slice(lastContent + 1);
  if (!tail.some((part) => part.type === "reasoning")) return message;
  // A text part in the tail has no text: one with text is content, and the
  // tail starts after the last content part.
  const kept = tail.filter(
    (part) => part.type !== "reasoning" && part.type !== "text"
  );
  while (kept.at(-1)?.type === "step-start") kept.pop();
  return {
    ...message,
    parts: [...message.parts.slice(0, lastContent + 1), ...kept]
  };
}

/**
 * Whether a reply holds nothing: nothing a client can show and nothing a
 * model request can carry. That is an assistant message with no parts, or
 * with only `step-start` markers and text or reasoning parts that have no
 * text. A reply cut off while the model was still reasoning is left like
 * this once {@link stripTrailingReasoning} has run.
 *
 * Such a reply is not stored, and one that is stored is removed: a client
 * draws it as an empty bubble, and nothing can continue it.
 */
export function replyIsEmpty(message: {
  role: string;
  parts: ReadonlyArray<unknown>;
}): boolean {
  return (
    message.role === "assistant" &&
    message.parts.every((part) => {
      const record = part as { type?: unknown; text?: unknown };
      if (record.type === "step-start") return true;
      return (
        (record.type === "text" || record.type === "reasoning") &&
        (typeof record.text !== "string" || record.text.length === 0)
      );
    })
  );
}

function countReasoning(message: UIMessage): number {
  return message.parts.filter((part) => part.type === "reasoning").length;
}

/** Whether a part reaches the model as something other than reasoning. */
function partSendsContent(part: UIMessage["parts"][number]): boolean {
  const record = part as Record<string, unknown>;
  if (record.type === "text") {
    return typeof record.text === "string" && record.text.length > 0;
  }
  return record.type === "file" || toolCallIdOf(record) !== undefined;
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
   *
   * `context.isLastMessage` is `true` for a part of the last message, the one
   * no later message follows.
   */
  shouldRepair?: (
    part: UIMessage["parts"][number],
    context: { isLastMessage: boolean }
  ) => boolean;
  /**
   * Also repair `approval-responded` parts in any message a later message
   * follows. Pass `true` only when no continuation will execute them: a turn
   * that is not itself a continuation, with no continuation waiting to run.
   * Parts in the last message are always kept, because the AI SDK executes a
   * trailing approval response when the transcript is submitted as-is. A
   * denied approval settles as `output-denied`; an approved one is handed to
   * `repairPart`. Defaults to `false`.
   */
  repairApprovalResponded?: boolean;
  /**
   * Do not report the last message as empty ({@link replyIsEmpty}). A
   * continuation turn passes `true`: the last message is the one it writes
   * into. Defaults to `false`.
   */
  keepEmptyLastMessage?: boolean;
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
  /**
   * Count of reasoning parts removed from the end of assistant messages
   * ({@link stripTrailingReasoning}).
   */
  removedReasoningParts: number;
  /**
   * Ids of the assistant messages in `messages` that hold nothing
   * ({@link replyIsEmpty}), whether this repair emptied them or they were
   * stored that way. `messages` still lists them, in place. A caller that
   * stores the result removes them ({@link persistRepairedTranscript}).
   */
  emptyReplyIds: string[];
}

/**
 * Repair interrupted tool calls and normalize malformed tool inputs across a
 * transcript. Behavior mirrors `@cloudflare/think`'s original
 * `_repairToolTranscriptParts`:
 *
 *   - a tool part with NO settled result and state `approval-responded` is kept
 *     verbatim (an approved server tool waiting for its continuation to run
 *     `execute()` — not abandoned), unless `repairApprovalResponded` is set;
 *   - a tool part with NO settled result for which `shouldRepair` returns false
 *     is kept verbatim (a part still awaiting a CLIENT interaction; see option);
 *   - any other tool part with no settled result is normalized then handed to
 *     `repairPart` (default: flipped to an errored result);
 *   - a tool part WITH a settled result only has its `input` normalized.
 *
 * An assistant message that ends in reasoning has that reasoning removed
 * ({@link stripTrailingReasoning}).
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
  let removedReasoningParts = 0;
  const toolCallIds: string[] = [];
  const emptyReplyIds: string[] = [];
  const repaired: UIMessage[] = [];

  for (const [messageIndex, message] of messages.entries()) {
    const isLastMessage = messageIndex === messages.length - 1;
    const parts: UIMessage["parts"] = [];
    let messageChanged = false;
    for (const part of message.parts) {
      const record = part as Record<string, unknown>;
      const toolCallId = toolCallIdOf(record);
      if (toolCallId === undefined) {
        parts.push(part);
        continue;
      }

      if (!isSettled(record)) {
        const state = typeof record.state === "string" ? record.state : "";
        // An approved server tool waits at `approval-responded` until its
        // scheduled continuation runs `execute()`. It is not abandoned, so
        // preserve it verbatim — flipping it to an error (or removing it) would
        // strand the approval and prevent the real result from ever being
        // produced by the continuation. Once no continuation will run it, the
        // provider needs a result for it like any other interrupted call.
        if (state === "approval-responded") {
          if (!options.repairApprovalResponded || isLastMessage) {
            parts.push(part);
            continue;
          }
          const approval = record.approval as
            | { approved?: boolean }
            | undefined;
          if (approval?.approved === false) {
            const normalized = normalizeInput(
              "input" in record ? record.input : undefined
            );
            parts.push({
              ...part,
              input: normalized.input,
              state: "output-denied"
            } as UIMessage["parts"][number]);
            if (normalized.changed) normalizedInputs++;
            removedToolCalls++;
            messageChanged = true;
            toolCallIds.push(toolCallId);
            continue;
          }
        }
        // A part still legitimately awaiting a CLIENT interaction (the host's
        // `shouldRepair` returns false) is left verbatim — erroring it would
        // clobber a tool-result / approval the client may still replay. Only
        // hosts whose default repair ERRORS the part opt into this; Think keeps
        // the default (repair everything, converting client tools via its hook).
        if (!shouldRepair(part, { isLastMessage })) {
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

    const settled = messageChanged ? { ...message, parts } : message;
    const stripped = stripTrailingReasoning(settled);
    removedReasoningParts += countReasoning(settled) - countReasoning(stripped);
    repaired.push(stripped);
    if (
      replyIsEmpty(stripped) &&
      !(options.keepEmptyLastMessage && isLastMessage)
    ) {
      emptyReplyIds.push(stripped.id);
    }
  }

  return {
    messages: repaired,
    removedToolCalls,
    normalizedInputs,
    toolCallIds,
    removedReasoningParts,
    emptyReplyIds
  };
}

/**
 * Settle the tool calls a cut-off reply left unanswered.
 *
 * A reply whose stream did not finish (an eviction, a stall, a provider
 * error, a stop) can hold a tool call with no result. If the tool ran on the
 * server, its `execute()` died with the stream and nothing will ever answer
 * it. Hosts call this on such a reply before they persist it, and on the
 * reply a recovery attempt is about to continue, so the stored transcript
 * never shows a call as running that nothing is running.
 *
 * Reasoning the reply ends in is removed too
 * ({@link stripTrailingReasoning}): a reply cut off right after the model's
 * reasoning would otherwise fail every later request.
 *
 * A text or reasoning part the cut left `streaming` is closed
 * (`settleInterruptedPart`).
 *
 * A call a client is known to own (`clientToolNames`, from the tool schemas
 * the client sent) is kept: the client replays its result after a reconnect.
 * So are `approval-requested` and `approval-responded` calls, which a client
 * answer or a continuation still completes. Every other unanswered call goes
 * to `repairPart`, which by default turns it into an errored result.
 *
 * Do NOT call this on a reply whose stream finished. There, an unanswered
 * call is one the stream ended on, so it is waiting for a client, whether or
 * not the client ever sent that tool's schema.
 *
 * The result can be empty ({@link replyIsEmpty}), for a reply cut off while
 * the model was still reasoning. The caller must not store it.
 *
 * @returns The same message when nothing changed.
 */
export function settleInterruptedReply<TMessage extends UIMessage>(
  message: TMessage,
  options: SettleInterruptedReplyOptions
): TMessage {
  // SAFETY: repairInterruptedToolParts returns the message it was given, or a
  // copy of it with repaired parts.
  return settleInterruptedReplyParts(message, options).messages[0] as TMessage;
}

export interface SettleInterruptedReplyOptions {
  repairPart: RepairInterruptedToolPartsOptions["repairPart"];
  clientToolNames: ReadonlySet<string>;
}

function settleInterruptedReplyParts(
  message: UIMessage,
  options: SettleInterruptedReplyOptions
): RepairInterruptedToolPartsResult {
  const result = repairInterruptedToolParts([message], {
    repairPart: options.repairPart,
    // An approved call that has not run yet is kept: the reply is the last
    // message, and the repair never touches an approved call there.
    shouldRepair: (part) =>
      !partAwaitsClientInteraction(part, options.clientToolNames)
  });
  // Nothing will write into a text or reasoning part the cut left
  // `streaming`: a continuation opens parts of its own. Close it, so the
  // stored reply does not show a part as still being written.
  const settled = result.messages[0];
  const parts = settled.parts.map(settleInterruptedPart);
  return parts.every((part, index) => part === settled.parts[index])
    ? result
    : { ...result, messages: [{ ...settled, parts }] };
}

/**
 * What a host does with a repaired transcript. The repair itself is the
 * same for every host; where messages are stored is not.
 */
export interface RepairedTranscriptSink {
  /**
   * Store the repaired messages and show them to clients.
   *
   * @param changed - The messages whose parts the repair changed.
   * @param repaired - The whole list the repair ran on, repaired.
   */
  persist(changed: UIMessage[], repaired: UIMessage[]): Promise<void>;
  /**
   * Remove stored messages and tell every client, so each tab drops them.
   *
   * @param ids - The messages to remove.
   * @param repaired - The list the repair ran on, repaired, without them.
   */
  remove(ids: string[], repaired: UIMessage[]): Promise<void>;
  /** Emit the `chat:transcript:repaired` observability event. */
  emitRepaired(event: {
    removedToolCalls: number;
    normalizedInputs: number;
    toolCallIds: string[];
    removedReasoningParts?: number;
    /** The removed messages, as they were stored. */
    removedMessages?: UIMessage[];
  }): void;
}

/**
 * Store what a repair changed and report it, once. A reply the repair
 * found or left empty ({@link replyIsEmpty}) is removed, not stored. Does
 * nothing when the repair changed nothing, which is the common case.
 *
 * @returns The repaired messages without the removed ones. The same array
 *   as `result.messages` when none was removed.
 */
export async function persistRepairedTranscript(
  original: ReadonlyArray<UIMessage>,
  result: RepairInterruptedToolPartsResult,
  sink: RepairedTranscriptSink
): Promise<UIMessage[]> {
  const removed = new Set(result.emptyReplyIds);
  const kept =
    removed.size === 0
      ? result.messages
      : result.messages.filter((message) => !removed.has(message.id));
  const changed = result.messages.filter(
    (message, index) => message !== original[index] && !removed.has(message.id)
  );
  if (changed.length > 0) await sink.persist(changed, kept);
  if (removed.size > 0) await sink.remove([...removed], kept);
  if (
    result.removedToolCalls === 0 &&
    result.normalizedInputs === 0 &&
    result.removedReasoningParts === 0 &&
    removed.size === 0
  ) {
    return kept;
  }
  sink.emitRepaired({
    removedToolCalls: result.removedToolCalls,
    normalizedInputs: result.normalizedInputs,
    toolCallIds: result.toolCallIds,
    ...(result.removedReasoningParts > 0 && {
      removedReasoningParts: result.removedReasoningParts
    }),
    // As stored, reasoning included, so an app can keep its own copy.
    ...(removed.size > 0 && {
      removedMessages: original.filter((message) => removed.has(message.id))
    })
  });
  return kept;
}

/**
 * Remove the reply a continuation turn would continue when it holds nothing
 * once its trailing reasoning is gone ({@link replyIsEmpty}), and report it.
 * The caller then answers the question again, as recovery does for a reply
 * that was lost: there is nothing to continue, and left in place the reply
 * is a block of reasoning nothing will ever answer.
 *
 * @returns Whether the last message was removed.
 */
export async function removeEmptyReplyToContinue(
  messages: ReadonlyArray<UIMessage>,
  sink: RepairedTranscriptSink
): Promise<boolean> {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return false;
  const stripped = stripTrailingReasoning(last);
  if (!replyIsEmpty(stripped)) return false;
  await persistRepairedTranscript(
    messages,
    {
      messages: [...messages.slice(0, -1), stripped],
      removedToolCalls: 0,
      normalizedInputs: 0,
      toolCallIds: [],
      removedReasoningParts: countReasoning(last) - countReasoning(stripped),
      emptyReplyIds: [last.id]
    },
    sink
  );
  return true;
}

/** What is known about the removal of the reply a recovery continues. */
export interface ReplyRemoval {
  /**
   * Runs before a reply that holds nothing is removed, with the question
   * the reply answered (the last user message before it).
   */
  beforeRemove?: (questionId?: string) => Promise<void>;
  /** Whether an earlier run of the attempt removed the reply. */
  removedEarlier?: boolean | "unknown";
  /** The question an earlier run recorded with the removal. */
  removedFor?: string;
  /** The user messages the interrupted request came from, when known. */
  originMessageIds?: ReadonlyArray<string>;
}

/**
 * Settle and store the reply a recovery attempt is about to continue, before
 * the attempt waits for the chat to be stable. That reply was cut off by
 * definition. One this version stored is settled already; one an older
 * version stored may hold a server tool call nothing will answer, and the
 * attempt would otherwise wait on it as if a client could.
 *
 * Only the latest message is touched, and only when it is the reply the
 * attempt continues and settling changes it (`cutOffReplyToSettle`). Earlier replies are left alone: the conversation has
 * moved past them, nothing waits on them, and the turn that follows settles
 * what they left unanswered.
 *
 * A reply that is empty once settled ({@link replyIsEmpty}) is removed.
 * There is then nothing to continue, and the attempt retries the question.
 *
 * That decision must survive the attempt: the removal is a durable write,
 * and the same continue payload is delivered again after a platform
 * transient, an eviction or a stable-timeout reschedule. So `beforeRemove`
 * runs before the reply is removed (the engine records it on the incident),
 * and `removedEarlier` says what an earlier run recorded. With no incident
 * record to ask (`"unknown"`), the transcript decides: the reply is gone and
 * the latest message is the question.
 *
 * @returns `"removed"` when the reply is not in the transcript because it
 *   held nothing: this call removed it, or an earlier one did.
 */
export async function settleReplyBeforeRecovery(
  messages: ReadonlyArray<UIMessage>,
  continueReplyId: string,
  options: SettleInterruptedReplyOptions,
  sink: RepairedTranscriptSink,
  removal: ReplyRemoval = {}
): Promise<"removed" | undefined> {
  const latest = messages.at(-1);
  if (
    latest?.role === "user" &&
    !messages.some((message) => message.id === continueReplyId)
  ) {
    const {
      removedEarlier = "unknown",
      originMessageIds,
      removedFor
    } = removal;
    // A latest message other than the question the removed reply answered
    // is a newer question: the conversation has moved. The removal records
    // that question; a payload's origin ids say the same for a removal an
    // older version made.
    const isItsQuestion =
      removedFor !== undefined
        ? removedFor === latest.id
        : originMessageIds === undefined ||
          originMessageIds.length === 0 ||
          originMessageIds.includes(latest.id);
    return removedEarlier !== false && isItsQuestion ? "removed" : undefined;
  }
  const { beforeRemove } = removal;
  const recordingSink: RepairedTranscriptSink = beforeRemove
    ? {
        ...sink,
        remove: async (ids, repaired) => {
          await beforeRemove(questionBefore(messages, continueReplyId));
          await sink.remove(ids, repaired);
        }
      }
    : sink;
  let result: RepairInterruptedToolPartsResult | undefined;
  const change = cutOffReplyToSettle(messages, continueReplyId, (reply) => {
    result = settleInterruptedReplyParts(reply, options);
    return result.messages[0];
  });
  if (!result) return undefined;
  // A reply that settles to itself changes nothing here, unless it was
  // stored empty: that one is still removed.
  await persistRepairedTranscript(
    messages,
    {
      ...result,
      messages: messages.map((message) =>
        message === change?.stored ? change.settled : message
      )
    },
    recordingSink
  );
  return result.emptyReplyIds.length > 0 ? "removed" : undefined;
}

/** The id of the last user message before `replyId`, if there is one. */
function questionBefore(
  messages: ReadonlyArray<UIMessage>,
  replyId: string
): string | undefined {
  const at = messages.findIndex((message) => message.id === replyId);
  for (let i = at - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].id;
  }
  return undefined;
}

/**
 * Ids of the tool calls that still have no result. After the before-turn
 * repair this holds only what the repair kept on purpose; anything else is a
 * shape the repair missed. An `approval-responded` call is not counted: it
 * is waiting for its turn to run it, and the AI SDK keeps it.
 */
export function unsettledToolCallIds(
  messages: ReadonlyArray<UIMessage>,
  isSettled: (
    record: Record<string, unknown>
  ) => boolean = toolPartHasSettledResult
): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      const record = part as Record<string, unknown>;
      const toolCallId = toolCallIdOf(record);
      if (toolCallId === undefined) continue;
      if (record.state === "approval-responded") continue;
      if (!isSettled(record)) ids.push(toolCallId);
    }
  }
  return ids;
}

/** Whether a stored chunk log holds the `finish` chunk of its stream. */
export function streamChunksFinished(
  chunks: ReadonlyArray<{ body: string }>
): boolean {
  for (let i = chunks.length - 1; i >= 0; i--) {
    try {
      if ((JSON.parse(chunks[i].body) as { type?: string }).type === "finish") {
        return true;
      }
    } catch {
      // A malformed body is not a finish chunk.
    }
  }
  return false;
}
