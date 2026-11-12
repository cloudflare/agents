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
 *     `execute()` — not abandoned), unless `repairApprovalResponded` is set;
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

  for (const [messageIndex, message] of messages.entries()) {
    const isLastMessage = messageIndex === messages.length - 1;
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

    repaired.push(messageChanged ? { ...message, parts } : message);
  }

  return {
    messages: repaired,
    removedToolCalls,
    normalizedInputs,
    toolCallIds
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
  return repairInterruptedToolParts([message], {
    repairPart: options.repairPart,
    shouldRepair: (part) => !awaitsKnownClient(part, options.clientToolNames),
    repairApprovalResponded: false
  });
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
  /** Emit the `chat:transcript:repaired` observability event. */
  emitRepaired(event: {
    removedToolCalls: number;
    normalizedInputs: number;
    toolCallIds: string[];
  }): void;
}

/**
 * Store what a repair changed and report it, once. Does nothing when the
 * repair changed nothing, which is the common case.
 */
export async function persistRepairedTranscript(
  original: ReadonlyArray<UIMessage>,
  result: RepairInterruptedToolPartsResult,
  sink: RepairedTranscriptSink
): Promise<void> {
  if (result.removedToolCalls === 0 && result.normalizedInputs === 0) return;
  const changed = result.messages.filter(
    (message, index) => message !== original[index]
  );
  await sink.persist(changed, result.messages);
  sink.emitRepaired({
    removedToolCalls: result.removedToolCalls,
    normalizedInputs: result.normalizedInputs,
    toolCallIds: result.toolCallIds
  });
}

/**
 * Settle and store the reply a recovery attempt is about to continue, before
 * the attempt waits for the chat to be stable. That reply was cut off by
 * definition. One this version stored is settled already; one an older
 * version stored may hold a server tool call nothing will answer, and the
 * attempt would otherwise wait on it as if a client could.
 *
 * Only the latest message is touched, and only when it is the reply the
 * attempt continues. Earlier replies are left alone: the conversation has
 * moved past them, nothing waits on them, and the turn that follows settles
 * what they left unanswered.
 */
export async function settleReplyBeforeRecovery(
  messages: ReadonlyArray<UIMessage>,
  continueReplyId: string,
  options: SettleInterruptedReplyOptions,
  sink: RepairedTranscriptSink
): Promise<void> {
  const last = messages.at(-1);
  if (last?.id !== continueReplyId || last.role !== "assistant") return;
  const result = settleInterruptedReplyParts(last, options);
  const settled = result.messages[0];
  if (settled === last) return;
  await persistRepairedTranscript(
    messages,
    {
      ...result,
      messages: messages.map((message) =>
        message === last ? settled : message
      )
    },
    sink
  );
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
      const toolCallId =
        typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      const isToolPart =
        typeof record.type === "string" &&
        (record.type.startsWith("tool-") || record.type === "dynamic-tool") &&
        toolCallId;
      if (!isToolPart) continue;
      if (record.state === "approval-responded") continue;
      if (!isSettled(record)) ids.push(toolCallId);
    }
  }
  return ids;
}

function awaitsKnownClient(
  part: UIMessage["parts"][number],
  clientToolNames: ReadonlySet<string>
): boolean {
  const record = part as Record<string, unknown>;
  if (record.state === "approval-requested") return true;
  if (record.state !== "input-available") return false;
  const type = typeof record.type === "string" ? record.type : "";
  const name =
    type === "dynamic-tool"
      ? record.toolName
      : type.startsWith("tool-")
        ? type.slice("tool-".length)
        : undefined;
  return typeof name === "string" && clientToolNames.has(name);
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
