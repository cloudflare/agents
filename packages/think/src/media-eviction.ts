/**
 * Aged-media eviction — a CONTEXT-WINDOW technique owned by Think.
 *
 * This is deliberately not how Sessions stores a message, and the two must
 * not be confused:
 *
 *   - Row chunking is a STORAGE detail. A message too large for one SQLite
 *     row is split across continuation rows and reassembled on read, byte
 *     for byte. Invisible to the model and lossless.
 *   - Media eviction is a CONTEXT decision. Once a screenshot has aged out
 *     of the recent window, re-sending it on every turn is pure cost, so
 *     Think removes it from the conversation and leaves a marker naming a
 *     Workspace file. Visible to the model and lossy on purpose — the agent
 *     reads the file back with the workspace `read` tool when it actually
 *     needs the picture again.
 *
 * The bytes are written to the Workspace RAW (not as a `data:` URL string)
 * with their real mime type, so `read` recognises `image/*` and puts a real
 * image back into the model's context.
 *
 * Evicted values are:
 *   - `file` parts whose `url` is a large `data:` URL — the part becomes a
 *     text marker;
 *   - large `data:` strings nested anywhere inside a tool part's `output`
 *     (screenshots commonly arrive that way) — the string is replaced in
 *     place so tool-specific `toModelOutput` handlers still work.
 *
 * Plain text parts are never evicted: they are the conversation itself.
 */

import type { UIMessage } from "ai";

/** Nested tool-output walks stop here so hostile output cannot recurse forever. */
const MAX_WALK_DEPTH = 8;

export interface MediaEvictionConfig {
  /**
   * Messages at the tail of the active path that are never evicted.
   * Think clamps this to at least the read-time window the model replays at
   * full fidelity, so a misconfigured low value can never strip content the
   * model still sees.
   * @default 8
   */
  keepRecentMessages?: number;
  /**
   * Minimum decoded payload size, in bytes, for a value to be evicted.
   * @default 32 * 1024
   */
  minPartBytes?: number;
  /**
   * Maximum stored rows processed per pass. Bounds how long a single pass
   * can take; remaining rows are picked up by the next pass.
   * @default 64
   */
  maxRowsPerPass?: number;
  /**
   * @deprecated Ignored. Evicted bytes are always preserved in the Workspace
   * under `/attachments/evicted/`; there is no drop-the-bytes mode. Accepted
   * so existing configurations keep compiling.
   */
  externalizeToWorkspace?: boolean;
}

export interface ResolvedMediaEvictionConfig {
  keepRecentMessages: number;
  minPartBytes: number;
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
    maxRowsPerPass: base.maxRowsPerPass ?? 64
  };
}

/**
 * The exact marker Think has always written. Old and new markers are
 * byte-identical, so a transcript evicted before and after the Sessions
 * replatform reads the same and old markers keep resolving.
 */
export function evictionMarker(
  bytes: number,
  path: string,
  mediaType?: string
): string {
  const media = mediaType ? `${mediaType}, ` : "";
  return `[evicted ${media}${bytes} bytes; preserved at ${path}]`;
}

export interface EvictMessageOptions {
  /** Minimum decoded payload size to evict. */
  minPartBytes: number;
  /**
   * Persist one payload and return the Workspace path it was written to.
   * `index` is the 0-based ordinal of the evicted value within the message.
   */
  write(
    index: number,
    bytes: Uint8Array,
    mediaType: string | undefined
  ): Promise<string>;
}

export interface EvictMessageResult {
  /** Rewritten message, or the original reference when nothing was evicted. */
  message: UIMessage;
  changed: boolean;
  /** Individual values replaced by markers. */
  parts: number;
  /** Decoded payload bytes removed from the conversation. */
  bytes: number;
}

interface WalkState {
  options: EvictMessageOptions;
  index: number;
  parts: number;
  bytes: number;
}

/**
 * Replace aged oversized media in one message with markers, writing the
 * bytes to the Workspace first. Returns a new message — the input is never
 * mutated, and nothing is written when nothing qualifies.
 */
export async function evictMediaFromMessage(
  message: UIMessage,
  options: EvictMessageOptions
): Promise<EvictMessageResult> {
  const state: WalkState = { options, index: 0, parts: 0, bytes: 0 };
  let changed = false;
  const parts: UIMessage["parts"] = [];

  for (const part of message.parts) {
    if (part.type === "file" && "url" in part) {
      const marker = await evictUrl(
        state,
        (part as { url: string }).url,
        (part as { mediaType?: string }).mediaType
      );
      if (marker !== null) {
        changed = true;
        parts.push({ type: "text", text: marker });
        continue;
      }
      parts.push(part);
      continue;
    }

    if (
      (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
      "output" in part
    ) {
      const output = (part as { output?: unknown }).output;
      if (output !== undefined) {
        const before = state.parts;
        const rewritten = await walkAndEvict(state, output, 0);
        if (state.parts > before) {
          changed = true;
          parts.push({ ...part, output: rewritten } as UIMessage["parts"][0]);
          continue;
        }
      }
    }

    parts.push(part);
  }

  return {
    message: changed ? { ...message, parts } : message,
    changed,
    parts: state.parts,
    bytes: state.bytes
  };
}

/**
 * Evict one stored payload locator. Returns its marker, or `null` when the
 * value is not an evictable payload or is below the size threshold.
 */
async function evictUrl(
  state: WalkState,
  url: unknown,
  fallbackMediaType?: string
): Promise<string | null> {
  if (typeof url !== "string") return null;
  const payload = resolvePayload(state, url);
  if (!payload) return null;
  const mediaType = payload.mediaType ?? fallbackMediaType;
  const path = await state.options.write(state.index, payload.bytes, mediaType);
  state.index++;
  state.parts++;
  state.bytes += payload.bytes.byteLength;
  return evictionMarker(payload.bytes.byteLength, path, mediaType);
}

/**
 * A stored payload is always an inline `data:` URL now, so eviction decodes
 * it directly.
 */
function resolvePayload(
  state: WalkState,
  url: string
): { bytes: Uint8Array; mediaType?: string } | null {
  const { minPartBytes } = state.options;
  if (!url.startsWith("data:")) return null;
  // A `data:` URL is always larger than its payload, so the cheap string
  // length rules out small values before any decoding happens.
  if (url.length < minPartBytes) return null;
  const decoded = decodeDataUrl(url);
  if (!decoded || decoded.bytes.byteLength < minPartBytes) return null;
  return decoded;
}

async function walkAndEvict(
  state: WalkState,
  value: unknown,
  depth: number
): Promise<unknown> {
  if (typeof value === "string") {
    return (await evictUrl(state, value)) ?? value;
  }

  if (value === null || typeof value !== "object" || depth >= MAX_WALK_DEPTH) {
    return value;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const result: unknown[] = [];
    for (const item of value) {
      const next = await walkAndEvict(state, item, depth + 1);
      if (next !== item) changed = true;
      result.push(next);
    }
    return changed ? result : value;
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = await walkAndEvict(state, entry, depth + 1);
    if (next !== entry) changed = true;
    result[key] = next;
  }
  return changed ? result : value;
}

/** Decode a `data:` URL into raw bytes. Returns null when it is malformed. */
export function decodeDataUrl(
  url: string
): { bytes: Uint8Array; mediaType?: string } | null {
  const comma = url.indexOf(",");
  if (comma === -1) return null;
  const header = url.slice("data:".length, comma);
  const base64 = /;base64$/i.test(header);
  const mediaType =
    header
      .replace(/;base64$/i, "")
      .split(";")[0]
      ?.trim() || undefined;
  const payload = url.slice(comma + 1);
  try {
    if (base64) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return mediaType === undefined ? { bytes } : { bytes, mediaType };
    }
    const bytes = new TextEncoder().encode(decodeURIComponent(payload));
    return mediaType === undefined ? { bytes } : { bytes, mediaType };
  } catch {
    return null;
  }
}

/** File extension for an evicted payload, derived from its media type. */
export function extensionFor(mediaType: string | undefined): string {
  if (!mediaType) return "txt";
  const subtype = mediaType.split("/")[1]?.replace(/[^a-zA-Z0-9]/g, "");
  return subtype || "bin";
}

/** Workspace path for the n-th value evicted from a message. */
export function evictedFilePath(
  messageId: string,
  index: number,
  mediaType: string | undefined
): string {
  return `/attachments/evicted/${messageId}-${index}.${extensionFor(mediaType)}`;
}
