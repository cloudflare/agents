/**
 * Aged-media eviction (#1710).
 *
 * Long-lived sessions accumulate inline base64 media — screenshot/image
 * tool results, data-URL file attachments — in the persisted transcript.
 * Read-time truncation hides that content from the model, but it stays in
 * storage forever and is rehydrated on every wake, so the boot footprint
 * grows with the number of images a session ever produced until SQLite's
 * allocator fails with `SQLITE_NOMEM`.
 *
 * This module rewrites oversized part values in AGED messages (the recent
 * tail is never touched) with small markers, optionally preserving the
 * original bytes as workspace files. Targets:
 *
 *   - `file` parts whose `url` is a large `data:` URL — the part is
 *     replaced with a text marker;
 *   - large string values nested anywhere inside a tool part's `output` —
 *     the string is replaced in place, preserving the container shape so
 *     tool-specific `toModelOutput` handlers can still replay the result.
 *
 * Plain `text` parts are intentionally NOT evicted: they are user-visible
 * prose, and the row-size limit already bounds them at write time.
 */

import type { UIMessage } from "ai";

export interface MediaEvictionConfig {
  /**
   * Messages at the tail of the active path that are never evicted.
   * Think clamps this to at least the read-time truncation window
   * (4 messages — the recent span the model replays at full fidelity),
   * so a misconfigured low value can never strip content the model
   * still sees.
   * @default 8
   */
  keepRecentMessages?: number;
  /**
   * Minimum serialized size (in characters; base64 is ASCII so this equals
   * bytes for media) of a single part value to evict.
   * @default 32 * 1024
   */
  minPartBytes?: number;
  /**
   * Preserve evicted values as workspace files under
   * `/attachments/evicted/` instead of dropping them. The marker records
   * the file path.
   * @default true
   */
  externalizeToWorkspace?: boolean;
  /**
   * Maximum oversized stored rows processed per pass. Bounds how long a
   * single pass can take; remaining rows are picked up by later passes.
   * @default 64
   */
  maxRowsPerPass?: number;
}

export interface ResolvedMediaEvictionConfig {
  keepRecentMessages: number;
  minPartBytes: number;
  externalizeToWorkspace: boolean;
  maxRowsPerPass: number;
}

export function resolveMediaEvictionConfig(
  config: MediaEvictionConfig | boolean
): ResolvedMediaEvictionConfig | null {
  if (config === false) return null;
  const base = config === true ? {} : config;
  return {
    keepRecentMessages: base.keepRecentMessages ?? 8,
    minPartBytes: base.minPartBytes ?? 32 * 1024,
    externalizeToWorkspace: base.externalizeToWorkspace ?? true,
    maxRowsPerPass: base.maxRowsPerPass ?? 64
  };
}

/** An oversized value extracted from a message, to be written to the workspace. */
export interface EvictedBlob {
  path: string;
  data: string;
  mediaType?: string;
}

export interface EvictMessageResult {
  message: UIMessage;
  changed: boolean;
  /** Individual oversized values evicted. */
  parts: number;
  /** Total characters removed from the serialized message. */
  bytes: number;
  /** Values to persist before the rewritten row is stored (may be empty). */
  blobs: EvictedBlob[];
}

export interface EvictMessageOptions {
  minPartBytes: number;
  /** When false, evicted values are dropped and markers record size only. */
  externalize: boolean;
  /** Workspace path for the n-th evicted value of this message. */
  pathFor: (index: number, extension: string) => string;
}

const MAX_WALK_DEPTH = 8;

/**
 * Replace oversized media values in a message with markers.
 * Returns a new message — the input is not mutated.
 */
export function evictLargeMediaFromMessage(
  message: UIMessage,
  options: EvictMessageOptions
): EvictMessageResult {
  const state = {
    options,
    parts: 0,
    bytes: 0,
    blobs: [] as EvictedBlob[]
  };

  let changed = false;
  const parts = message.parts.map((part) => {
    // Large data-URL file attachments → text marker.
    if (part.type === "file" && "url" in part) {
      const url = (part as { url: string }).url;
      if (
        typeof url === "string" &&
        url.startsWith("data:") &&
        url.length >= options.minPartBytes
      ) {
        changed = true;
        const mediaType =
          (part as { mediaType?: string }).mediaType ?? dataUrlMediaType(url);
        const path = extractBlob(state, url, mediaType);
        return {
          type: "text" as const,
          text: evictionMarker(url.length, path, mediaType)
        };
      }
      return part;
    }

    // Large strings nested in tool outputs → marker strings in place.
    if (
      (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
      "output" in part
    ) {
      const output = (part as { output?: unknown }).output;
      if (output !== undefined) {
        const before = state.parts;
        const evicted = walkAndEvict(state, output, 0);
        if (state.parts > before) {
          changed = true;
          return { ...part, output: evicted };
        }
      }
    }

    return part;
  }) as UIMessage["parts"];

  return {
    message: changed ? { ...message, parts } : message,
    changed,
    parts: state.parts,
    bytes: state.bytes,
    blobs: state.blobs
  };
}

type WalkState = {
  options: EvictMessageOptions;
  parts: number;
  bytes: number;
  blobs: EvictedBlob[];
};

function walkAndEvict(
  state: WalkState,
  value: unknown,
  depth: number
): unknown {
  if (typeof value === "string") {
    if (value.length < state.options.minPartBytes) return value;
    const mediaType = value.startsWith("data:")
      ? dataUrlMediaType(value)
      : undefined;
    const path = extractBlob(state, value, mediaType);
    return evictionMarker(value.length, path, mediaType);
  }

  if (value === null || typeof value !== "object" || depth >= MAX_WALK_DEPTH) {
    return value;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item) => {
      const next = walkAndEvict(state, item, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? result : value;
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = walkAndEvict(state, entry, depth + 1);
    if (next !== entry) changed = true;
    result[key] = next;
  }
  return changed ? result : value;
}

/** Record an evicted value; returns its workspace path or null when dropped. */
function extractBlob(
  state: WalkState,
  data: string,
  mediaType: string | undefined
): string | null {
  state.parts++;
  state.bytes += data.length;
  if (!state.options.externalize) return null;
  const path = state.options.pathFor(
    state.blobs.length,
    extensionFor(mediaType)
  );
  state.blobs.push({ path, data, mediaType });
  return path;
}

function evictionMarker(
  bytes: number,
  path: string | null,
  mediaType?: string
): string {
  const media = mediaType ? `${mediaType}, ` : "";
  return path
    ? `[evicted ${media}${bytes} bytes; preserved at ${path}]`
    : `[evicted ${media}${bytes} bytes]`;
}

function dataUrlMediaType(url: string): string | undefined {
  const match = /^data:([^;,]+)/.exec(url);
  return match?.[1] || undefined;
}

function extensionFor(mediaType: string | undefined): string {
  if (!mediaType) return "txt";
  const subtype = mediaType.split("/")[1]?.replace(/[^a-zA-Z0-9]/g, "");
  return subtype || "bin";
}
