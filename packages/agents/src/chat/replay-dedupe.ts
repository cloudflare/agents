/**
 * Replay de-duplication for continuation streams (#1951).
 *
 * A continuation appends to an assistant message this client may already have
 * rendered live. After a reconnect the server replays the continuation's
 * whole buffer, and applying it on top of the live-rendered bytes would
 * duplicate them. Every live and replayed chunk frame carries its index in
 * the stream (`seq`), so a client that records how far it applied each
 * stream can drop the replayed chunks it already has.
 *
 * Non-continuation replays are left alone: the client resets the message and
 * rebuilds it from chunk 0 for those.
 */

type ChunkFrame = {
  body?: string;
  continuation?: boolean;
  replay?: boolean;
  seq?: number;
};

/** Highest chunk `seq` this client applied, per request id. */
export class AppliedChunkLedger {
  private readonly applied = new Map<string, number>();

  record(requestId: string, seq: number | undefined): void {
    if (seq === undefined) return;
    if (seq > (this.applied.get(requestId) ?? -1)) {
      this.applied.set(requestId, seq);
    }
  }

  /** Whether `frame` replays a continuation chunk this client already applied. */
  isAppliedReplay(requestId: string, frame: ChunkFrame): boolean {
    return (
      frame.replay === true &&
      frame.continuation === true &&
      frame.seq !== undefined &&
      frame.seq <= (this.applied.get(requestId) ?? -1)
    );
  }

  forget(requestId: string): void {
    this.applied.delete(requestId);
  }

  clear(): void {
    this.applied.clear();
  }
}

/**
 * Filters one resumed stream's frames for a consumer that needs every part
 * opened before its deltas arrive (the AI SDK UI message stream). Applied
 * replay chunks are dropped; a part that was still open when they end is
 * re-opened with its original start chunk, so the new deltas have a part to
 * land in. The re-opened part renders as a second, adjacent part until the
 * server's final message replaces it.
 */
export class ContinuationReplayFilter<F extends ChunkFrame> {
  private readonly openParts = new Map<string, string>();

  constructor(
    private readonly ledger: AppliedChunkLedger,
    private readonly requestId: string
  ) {}

  /** The frames to apply in place of `frame`. */
  frames(frame: F): F[] {
    if (this.ledger.isAppliedReplay(this.requestId, frame)) {
      this.trackOpenPart(frame.body);
      return frame.body?.trim() ? [{ ...frame, body: "" }] : [frame];
    }
    this.ledger.record(this.requestId, frame.seq);
    if (this.openParts.size === 0 || !frame.body?.trim()) return [frame];
    const reopened = [...this.openParts.values()].map(
      (body) => ({ ...frame, body, seq: undefined }) as F
    );
    this.openParts.clear();
    return [...reopened, frame];
  }

  private trackOpenPart(body: string | undefined): void {
    let chunk: { type?: string; id?: string; toolCallId?: string };
    try {
      chunk = JSON.parse(body ?? "") as typeof chunk;
    } catch {
      return;
    }
    switch (chunk.type) {
      case "text-start":
      case "reasoning-start":
        this.openParts.set(`${chunk.type}:${chunk.id}`, body ?? "");
        break;
      case "text-end":
        this.openParts.delete(`text-start:${chunk.id}`);
        break;
      case "reasoning-end":
        this.openParts.delete(`reasoning-start:${chunk.id}`);
        break;
      case "tool-input-start":
        this.openParts.set(`tool:${chunk.toolCallId}`, body ?? "");
        break;
      case "tool-input-available":
      case "tool-input-error":
        this.openParts.delete(`tool:${chunk.toolCallId}`);
        break;
    }
  }
}
