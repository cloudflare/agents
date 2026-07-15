import { normalizeJson } from "../../kernel/json.js";
import { isToolPart, type ChatMessage, type MessagePart, type ToolPart } from "./model.js";

const UNSETTLED_STATES = new Set<ToolPart["state"]>([
  "input-streaming",
  "input-available",
  "approval-requested",
]);

const DEFAULT_ERROR_TEXT = "Tool call was interrupted before completing.";

export interface RepairReport {
  messages: ChatMessage[];
  /**
   * Count of tool calls whose pending/unsettled status was resolved by this
   * repair pass — whether they ended up as a synthetic error part (the
   * default repair) or were dropped entirely by the backstop (a custom
   * repairPart that leaves the part without output/error).
   */
  removedToolCalls: number;
  normalizedInputs: number;
  toolCallIds: string[];
  changed: boolean;
}

/**
 * Heals a transcript containing tool parts left in an unsettled state by an
 * interrupted turn (eviction, stall abort, cancel). By default, an unsettled
 * tool part is flipped to `output-error` with a generic message, preserving
 * the call and its input so context isn't lost. A caller-provided
 * `repairPart` overrides this per part; if the result is still a tool part
 * lacking both `output` and `errorText`, it is dropped from the transcript
 * (backstop) rather than left unsettled.
 *
 * Also normalizes stringified tool inputs (JSON-parseable strings are
 * parsed) across all tool parts, settled or not.
 */
export function repairTranscript(
  messages: ChatMessage[],
  options?: {
    repairPart?: (part: ToolPart) => MessagePart;
    /**
     * Which states count as repairable. Defaults to every unsettled state;
     * the pre-turn PERSISTENCE pass narrows this to the interrupted-execution
     * states only (`input-streaming`/`input-available`) — `approval-requested`
     * is a deliberately parked state with its own resolution path
     * (resolveApproval), not an orphan.
     */
    repairStates?: ReadonlySet<ToolPart["state"]>;
  }
): RepairReport {
  let removedToolCalls = 0;
  let normalizedInputs = 0;
  const toolCallIds: string[] = [];
  let changed = false;

  const repairedMessages = messages.map((message) => {
    if (message.role !== "assistant") return message;

    let messageChanged = false;
    const newParts: MessagePart[] = [];

    for (const part of message.parts) {
      if (!isToolPart(part)) {
        newParts.push(part);
        continue;
      }

      let working: ToolPart = part;

      if (typeof working.input === "string") {
        const parsed = tryParseJson(working.input);
        if (parsed.ok) {
          working = { ...working, input: parsed.value };
          normalizedInputs++;
          messageChanged = true;
        }
      }

      // Providers require tool inputs to be JSON OBJECTS: a missing input or
      // an array 400s (Anthropic rejects non-object input). Normalize both
      // to {} so persisted transcripts always replay (ISSUE-015 suite).
      if (working.input === undefined || Array.isArray(working.input)) {
        working = { ...working, input: {} };
        normalizedInputs++;
        messageChanged = true;
      }

      if ((options?.repairStates ?? UNSETTLED_STATES).has(working.state)) {
        const repairFn = options?.repairPart ?? defaultRepair;
        const result = repairFn(working);
        messageChanged = true;
        removedToolCalls++;
        toolCallIds.push(working.toolCallId);

        if (isToolPart(result) && result.output === undefined && result.errorText === undefined) {
          // Backstop: still incomplete after repair — drop from the transcript.
          continue;
        }
        newParts.push(result);
        continue;
      }

      newParts.push(working);
    }

    if (!messageChanged) return message;
    changed = true;
    return { ...message, parts: newParts };
  });

  return { messages: repairedMessages, removedToolCalls, normalizedInputs, toolCallIds, changed };
}

function defaultRepair(part: ToolPart): ToolPart {
  return {
    ...part,
    state: "output-error",
    errorText: DEFAULT_ERROR_TEXT,
  };
}

function tryParseJson(input: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

/**
 * Strips ephemeral/provider-specific properties before storage: drops
 * non-JSON values (functions, symbols, undefined) and any keys outside the
 * known ChatMessage/MessagePart shape (e.g. per-chunk provider metadata the
 * stream attaches at runtime).
 */
export function sanitizeForPersistence(message: ChatMessage): ChatMessage {
  const normalized = normalizeJson<ChatMessage>(message);

  const sanitized: ChatMessage = {
    id: normalized.id,
    role: normalized.role,
    parts: normalized.parts.map(sanitizePart),
  };
  if (normalized.metadata !== undefined) sanitized.metadata = normalized.metadata;
  if (normalized.createdAt !== undefined) sanitized.createdAt = normalized.createdAt;
  return sanitized;
}

function sanitizePart(part: MessagePart): MessagePart {
  if (isToolPart(part)) {
    const sanitized: ToolPart = {
      type: part.type,
      toolCallId: part.toolCallId,
      state: part.state,
    };
    if (part.input !== undefined) sanitized.input = part.input;
    if (part.output !== undefined) sanitized.output = part.output;
    if (part.errorText !== undefined) sanitized.errorText = part.errorText;
    if (part.approval !== undefined) sanitized.approval = part.approval;
    return sanitized;
  }

  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return { type: "reasoning", text: part.text };
    case "file": {
      const sanitized: MessagePart = { type: "file", mediaType: part.mediaType };
      if (part.url !== undefined) (sanitized as { url?: string }).url = part.url;
      if (part.data !== undefined) (sanitized as { data?: string }).data = part.data;
      if (part.filename !== undefined) (sanitized as { filename?: string }).filename = part.filename;
      return sanitized;
    }
  }
}
