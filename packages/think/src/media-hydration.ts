/**
 * Media that was read back WITHOUT its payload.
 *
 * Sessions keeps a message's media out of the row as a content-addressed
 * pointer (`attachment:sha256:<hash>`) and puts the bytes back on read.
 * Think asks for that only on the newest messages (`mediaHydration`): the
 * model replays those at full fidelity, and a payload older than that is a
 * copy the isolate would hold, serialize to every client, and walk on every
 * turn for nothing. Older messages keep their pointers in the live cache.
 *
 * A pointer is safe to hold and to write back — Sessions keeps the reference
 * it names — but it is not something a model provider can fetch. Before a
 * turn, a part still carrying one becomes a short marker saying what was
 * withheld, the way media eviction leaves a marker for bytes it moved to the
 * Workspace. Unlike eviction this rewrites nothing durable: the row keeps its
 * pointer and a full read still returns the bytes.
 */

import type { UIMessage } from "ai";

const ATTACHMENT_POINTER = /^attachment:sha256:[0-9a-f]{64}$/;

/** Hostile or deeply nested tool output stops here rather than recursing forever. */
const MAX_WALK_DEPTH = 8;

/** Whether a stored media field holds a Sessions pointer instead of bytes. */
export function isAttachmentPointer(value: unknown): value is string {
  return typeof value === "string" && ATTACHMENT_POINTER.test(value);
}

/** The text a model sees in place of media whose bytes were not hydrated. */
export function withheldMediaMarker(mediaType?: string): string {
  return `[${mediaType ?? "media"} omitted: older than the recent window]`;
}

/**
 * Replace every pointer-form media in a message with a marker. Returns the
 * same message by reference when it carried none, so the common case
 * allocates nothing.
 */
export function withholdUnhydratedMedia(message: UIMessage): UIMessage {
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > MAX_WALK_DEPTH || value === null || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((entry) => {
        const walked = walk(entry, depth + 1);
        if (walked !== entry) changed = true;
        return walked;
      });
      return changed ? next : value;
    }
    const record = value as Record<string, unknown>;
    const mediaType =
      typeof record.mediaType === "string" ? record.mediaType : undefined;
    if (isAttachmentPointer(record.url)) {
      return record.type === "file"
        ? { type: "text", text: withheldMediaMarker(mediaType) }
        : { ...record, url: withheldMediaMarker(mediaType) };
    }
    if (isAttachmentPointer(record.data)) {
      return { ...record, data: withheldMediaMarker(mediaType) };
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      const walked = walk(entry, depth + 1);
      if (walked !== entry) changed = true;
      next[key] = walked;
    }
    return changed ? next : value;
  };

  const parts = walk(message.parts, 0) as UIMessage["parts"];
  return parts === message.parts ? message : { ...message, parts };
}
