import { isToolPart, type ChatMessage } from "../messages/model.js";

const DEFAULT_PROTECT_HEAD = 3;
const DEFAULT_TAIL_TOKEN_BUDGET = 20_000;
const DEFAULT_MIN_TAIL_MESSAGES = 2;

export interface CompactionConfig {
  summarize: (prompt: string) => Promise<string>;
  protectHead?: number;
  tailTokenBudget?: number;
  minTailMessages?: number;
  compactAfterTokens?: number;
  tokenCounter?: (messages: ChatMessage[]) => number;
}

/**
 * Non-destructive compaction record: originals stay in the store; at read
 * time `applyOverlays` replaces the [fromMessageId, toMessageId] range with a
 * single synthetic assistant message carrying the summary.
 */
export interface Overlay {
  id: string;
  fromMessageId: string;
  toMessageId: string;
  summary: string;
}

/** Flattens a message's parts to a rough text representation for estimation/prompting. */
function textOfMessage(message: ChatMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      chunks.push(part.text);
    } else if (isToolPart(part)) {
      chunks.push(JSON.stringify({ input: part.input, output: part.output, errorText: part.errorText }));
    } else if (part.type === "file") {
      chunks.push(part.filename ?? part.url ?? "");
    }
  }
  return chunks.join("");
}

/**
 * Estimates token usage for a run of messages: `Math.ceil(chars / 4)` over
 * text/reasoning content plus the JSON-serialized form of tool call
 * input/output. Used when no `tokenCounter` is supplied to `planCompaction`,
 * and reusable by `Session` for its own history-token estimate so the
 * compaction trigger threshold is measured on a consistent basis.
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) chars += textOfMessage(message).length;
  return Math.ceil(chars / 4);
}

/**
 * Renders the prompt handed to `CompactionConfig.summarize` for a range of
 * messages being compacted. When `previousSummary` is given (an earlier
 * overlay being superseded/extended), it's folded in so the model can
 * produce one updated summary rather than losing prior context.
 */
export function renderCompactionPrompt(messages: ChatMessage[], previousSummary?: string): string {
  const transcript = messages.map((m) => `${m.role}: ${textOfMessage(m)}`).join("\n");
  const prefix =
    previousSummary !== undefined
      ? `Existing summary of earlier context:\n${previousSummary}\n\nIncorporate it with the following additional conversation and produce one updated summary.\n\n`
      : "Summarize the following conversation excerpt, preserving key facts, decisions, and open threads.\n\n";
  return `${prefix}${transcript}`;
}

function hasUnsettledToolPart(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.parts.some(
    (part) =>
      isToolPart(part) &&
      (part.state === "input-streaming" || part.state === "input-available" || part.state === "approval-requested")
  );
}

/**
 * Computes the [from, to) half-open index range of `messages` worth
 * compacting into a summary, or `null` if nothing is worth compacting.
 *
 * Boundary algorithm:
 * 1. Protect the head: the first `protectHead` messages are never touched.
 * 2. Protect the tail: walk backward from the end accumulating tokens up to
 *    `tailTokenBudget`, but always keep at least `minTailMessages`.
 * 3. Align: never leave an unsettled tool call (awaiting input/approval/
 *    output) inside the compacted middle — pull it, and everything after it,
 *    into the protected tail so it stays live for repair/resolution.
 */
export function planCompaction(messages: ChatMessage[], cfg: CompactionConfig): { from: number; to: number } | null {
  const protectHead = cfg.protectHead ?? DEFAULT_PROTECT_HEAD;
  const tailTokenBudget = cfg.tailTokenBudget ?? DEFAULT_TAIL_TOKEN_BUDGET;
  const minTailMessages = cfg.minTailMessages ?? DEFAULT_MIN_TAIL_MESSAGES;
  const countTokens = cfg.tokenCounter ?? estimateMessagesTokens;

  const total = messages.length;
  const headEnd = Math.min(protectHead, total);

  let tailStart = total;
  let tailTokens = 0;
  for (let i = total - 1; i >= headEnd; i--) {
    const keptSoFar = total - i;
    const messageTokens = countTokens([messages[i]!]);
    if (keptSoFar > minTailMessages && tailTokens + messageTokens > tailTokenBudget) {
      break;
    }
    tailTokens += messageTokens;
    tailStart = i;
  }

  // Tool-pair alignment: an unsettled tool call anywhere in the middle pulls
  // itself and everything after it out of the compacted range and into the
  // protected tail, so it stays live for repair/resolution.
  for (let i = headEnd; i < tailStart; i++) {
    if (hasUnsettledToolPart(messages[i]!)) {
      tailStart = i;
      break;
    }
  }

  if (tailStart <= headEnd) return null;
  return { from: headEnd, to: tailStart };
}

/**
 * Applies overlays to `messages` at read time. Each overlay's
 * [fromMessageId, toMessageId] range (inclusive, resolved by id) is replaced
 * with a single synthetic assistant message `id: "compaction_<id>"` holding
 * the summary text. When overlays overlap, later entries in `overlays` win —
 * an earlier overlay whose range intersects a later one is dropped entirely.
 * Overlays referencing message ids no longer present are skipped.
 */
export function applyOverlays(messages: ChatMessage[], overlays: Overlay[]): ChatMessage[] {
  if (overlays.length === 0) return messages;

  const indexOf = new Map<string, number>();
  messages.forEach((m, i) => indexOf.set(m.id, i));

  interface Resolved {
    id: string;
    from: number;
    to: number;
    summary: string;
  }

  const resolved: Resolved[] = [];
  for (const overlay of overlays) {
    const from = indexOf.get(overlay.fromMessageId);
    const to = indexOf.get(overlay.toMessageId);
    if (from === undefined || to === undefined || to < from) continue;
    resolved.push({ id: overlay.id, from, to, summary: overlay.summary });
  }

  const consumed = new Array<boolean>(messages.length).fill(false);
  const applied = new Map<number, Resolved>(); // keyed by `from` index

  for (let i = resolved.length - 1; i >= 0; i--) {
    const r = resolved[i]!;
    let overlaps = false;
    for (let idx = r.from; idx <= r.to; idx++) {
      if (consumed[idx]) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    for (let idx = r.from; idx <= r.to; idx++) consumed[idx] = true;
    applied.set(r.from, r);
  }

  const result: ChatMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    if (!consumed[i]) {
      result.push(messages[i]!);
      i++;
      continue;
    }
    const r = applied.get(i);
    if (!r) {
      // Consumed by a range that started earlier; already emitted.
      i++;
      continue;
    }
    result.push({
      id: `compaction_${r.id}`,
      role: "assistant",
      parts: [{ type: "text", text: r.summary }],
    });
    i = r.to + 1;
  }
  return result;
}
