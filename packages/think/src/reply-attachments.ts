/**
 * A turn's advisory reply attachments, recorded by actions through
 * `ctx.attachReply`. Both Thinks keep one per agent, for the latest turn.
 *
 * @internal Not exported from any entry point.
 */
import { safeStringifyActionOutput } from "./action-tools";
import type { ReplyAttachment } from "./actions";

const MAX_REPLY_ATTACHMENTS_PER_TURN = 32;

/** @internal */
export class ReplyAttachments {
  #requestId: string | undefined;
  #attachments: ReplyAttachment[] = [];

  /** Start a turn: earlier attachments are dropped. */
  begin(requestId: string): void {
    this.#requestId = requestId;
    this.#attachments = [];
  }

  /**
   * Record one for `requestId`'s turn, JSON-normalized to a safe copy.
   * Returns its `type`, or `undefined` when it was ignored: another turn's,
   * not an object with a string `type`, not JSON, or over the cap.
   */
  record(requestId: string, attachment: unknown): string | undefined {
    if (!requestId || requestId !== this.#requestId) return;
    if (!isAttachment(attachment)) return;
    if (this.#attachments.length >= MAX_REPLY_ATTACHMENTS_PER_TURN) return;
    const serialized = safeStringifyActionOutput(attachment);
    if (serialized.error || serialized.value === undefined) return;
    const normalized = JSON.parse(serialized.value) as unknown;
    if (!isAttachment(normalized)) return;
    this.#attachments.push(normalized);
    return normalized.type;
  }

  count(): number {
    return this.#attachments.length;
  }

  /** Take back the ones recorded after the first `count`. */
  truncate(count: number): void {
    this.#attachments.length = count;
  }

  /**
   * Deep copies. With no `requestId`, the latest turn's; with one, only if
   * they belong to that turn (else `[]`).
   */
  list(requestId?: string): ReplyAttachment[] {
    if (requestId !== undefined && requestId !== this.#requestId) return [];
    return this.#attachments.map(
      (attachment) => JSON.parse(JSON.stringify(attachment)) as ReplyAttachment
    );
  }
}

function isAttachment(value: unknown): value is ReplyAttachment {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
