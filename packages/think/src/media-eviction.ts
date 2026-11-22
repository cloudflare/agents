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
import {
  MODEL_RECENT_WINDOW,
  mediaEvictionCutoff
} from "./inference/model-messages";

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
   * under `/workspace/attachments/evicted/`; there is no drop-the-bytes mode. Accepted
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

/**
 * Whether a pass over `message` could evict anything: a file part or a tool
 * output holding a `data:` URL at least `minPartBytes` long. Decodes nothing —
 * this is the in-memory gate that decides whether a pass is worth scheduling,
 * so a decoded payload that turns out smaller than the threshold is merely a
 * pass that changes nothing.
 */
export function hasEvictableMedia(
  message: UIMessage,
  minPartBytes: number
): boolean {
  const isCandidate = (value: unknown): boolean =>
    typeof value === "string" &&
    value.length >= minPartBytes &&
    value.startsWith("data:");
  const walk = (value: unknown, depth: number): boolean => {
    if (isCandidate(value)) return true;
    if (
      value === null ||
      typeof value !== "object" ||
      depth >= MAX_WALK_DEPTH
    ) {
      return false;
    }
    const entries = Array.isArray(value) ? value : Object.values(value);
    return entries.some((entry) => walk(entry, depth + 1));
  };
  for (const part of message.parts) {
    if (part.type === "file" && "url" in part) {
      if (isCandidate((part as { url: unknown }).url)) return true;
      continue;
    }
    if (
      (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
      "output" in part &&
      walk((part as { output?: unknown }).output, 0)
    ) {
      return true;
    }
  }
  return false;
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
  return `/workspace/attachments/evicted/${messageId}-${index}.${extensionFor(mediaType)}`;
}

/** Totals of one eviction pass. */
export interface MediaEvictionPassResult {
  messages: number;
  parts: number;
  bytes: number;
  backlogRemains: boolean;
}

/** What {@link MediaEvictionPasses} reads from and does on its agent. */
export interface MediaEvictionPassHost {
  /** The resolved `mediaEviction` setting; `null` when eviction is off. */
  config(): ResolvedMediaEvictionConfig | null;
  truncationStep(): number;
  /** The hydrated message cache. */
  cachedMessages(): readonly UIMessage[];
  /**
   * Whether the cache cannot stand in for the stored path: the hydration is
   * a window of it, or a compaction overlay hides rows a pass would read.
   */
  agedRowsHiddenFromCache(): boolean;
  /** Stored content bytes the last hydration measured, if known. */
  storedBytes(): number | null;
  rowStats(): Promise<ReadonlyArray<{ id: string; bytes: number }>>;
  readMessage(id: string): Promise<UIMessage | null>;
  /**
   * A file writer for one pass, opened once at the start of the pass so every
   * payload of the pass lands in the same Workspace.
   */
  openFiles(): { write(path: string, bytes: Uint8Array): Promise<void> };
  updateMessage(message: UIMessage): Promise<unknown>;
  emitEvicted(totals: Omit<MediaEvictionPassResult, "backlogRemains">): void;
  /** Queue one pass on the agent's job queue, coalesced by a stable id. */
  queuePass(): Promise<unknown>;
}

/**
 * Schedules and runs bounded media-eviction passes for one agent.
 *
 * In memory only: whether a pass is running, a request that arrived during
 * it, and the last fruitless pass. A pass is one queue item, so repeated
 * requests coalesce; the gate below decides from memory whether a pass could
 * evict anything before queuing one.
 */
export class MediaEvictionPasses {
  readonly #host: MediaEvictionPassHost;
  #running = false;
  /**
   * A request that arrived while a pass was running. That pass read its
   * candidates before the request's append landed, so the request is kept
   * and re-evaluated once the pass ends rather than dropped.
   */
  #pending = false;
  /**
   * Linear appends that landed while a pass was running. The pass read its
   * candidates before them, so a fruitless result records them as appends
   * since — not zero — and the request they left pending can pass the gate.
   */
  #appendsDuringPass = 0;
  /**
   * The last pass that found nothing to evict while aged rows were hidden
   * from the cache: the stored size it saw, and how many linear appends have
   * landed since. Until either changes enough, another pass would scan the
   * same rows to the same answer. A refresh that measures a different size
   * re-arms it, and so do `keepRecentMessages` appends: that is what it takes
   * for a row the pass had to protect to age into a candidate. An update
   * that grows a cached row clears it outright ({@link invalidate}).
   */
  #fruitless: { storedBytes: number; appendsSince: number } | null = null;

  constructor(host: MediaEvictionPassHost) {
    this.#host = host;
  }

  /** Whether a pass is running now. */
  get running(): boolean {
    return this.#running;
  }

  /**
   * A linear append landed. Appends are what age older messages, so this
   * is where a pass becomes worth scheduling.
   */
  noteAppend(): void {
    if (this.#fruitless) this.#fruitless.appendsSince++;
    if (this.#running) this.#appendsDuringPass++;
    this.request();
  }

  /** A cached row grew, so an aged row may now hold a payload. */
  invalidate(): void {
    this.#fruitless = null;
  }

  /**
   * Queue a pass if one could evict anything. A request that lands while a
   * pass runs is re-evaluated once the pass ends, so media aged by an append
   * during the pass is not left until the next one. Passes run from the
   * alarm loop, never inside the request or cache refresh that asked.
   */
  request(): void {
    if (this.#running) {
      this.#pending = true;
      return;
    }
    const config = this.#host.config();
    if (!config) return;
    // Decide from memory whether a pass could evict anything, so a pass is
    // not the way to find out: its first act is a content-free scan of the
    // whole stored path, and this runs after every cache refresh and every
    // linear append.
    //
    // When the cache holds every aged row, it is the same rows the pass
    // would read, so a pass is scheduled only when an aged cached message
    // still carries an inline payload. When it does not — a windowed
    // hydration, or rows hidden under a compaction overlay — a pass is
    // scheduled once per distinct stored size, since until the bytes change
    // it would scan the same rows to the same answer.
    const keepRecent = Math.max(config.keepRecentMessages, MODEL_RECENT_WINDOW);
    if (this.#host.agedRowsHiddenFromCache()) {
      const fruitless = this.#fruitless;
      const storedBytes = this.#host.storedBytes();
      if (
        fruitless !== null &&
        storedBytes !== null &&
        fruitless.storedBytes === storedBytes &&
        fruitless.appendsSince < keepRecent
      ) {
        return;
      }
    } else {
      const cached = this.#host.cachedMessages();
      const aged = cached.slice(
        0,
        mediaEvictionCutoff(
          cached.length,
          config.keepRecentMessages,
          this.#host.truncationStep()
        )
      );
      if (
        !aged.some((message) => hasEvictableMedia(message, config.minPartBytes))
      ) {
        return;
      }
    }
    void this.#host.queuePass().catch((error) => {
      console.error("[Think] Failed to queue media eviction pass", error);
    });
  }

  /**
   * Remove aged media from the conversation, leaving a Workspace pointer the
   * agent can read back.
   *
   * Memory-bounded by design: candidate sizes come from the row stats (no
   * content loaded), only rows big enough to hold an evictable payload are
   * read, and they are processed one at a time. Bytes are written to the
   * Workspace BEFORE the row is rewritten, so a failed pass never loses data;
   * once the rewritten row is stored, its Sessions attachment reference is
   * gone and the blob is reaped, so the bytes live in exactly one place.
   *
   * The aged cutoff is {@link mediaEvictionCutoff}: the stepped truncation
   * cutoff, kept at least `keepRecentMessages` back. Messages the model still
   * replays at full fidelity are never rewritten, and the cutoff moves only
   * once per truncation step.
   *
   * Best-effort: failures are logged and the next pass retries. When a pass
   * stops at `maxRowsPerPass` having made progress, the next one is scheduled
   * so a backlog drains on its own; a pass that changed nothing does not
   * reschedule, which is what guarantees termination.
   *
   * @returns `null` when eviction is off, a pass is already running, or the
   * pass failed.
   */
  async run(): Promise<MediaEvictionPassResult | null> {
    if (this.#running) return null;
    const config = this.#host.config();
    if (!config) return null;
    this.#running = true;
    this.#appendsDuringPass = 0;
    const totals: MediaEvictionPassResult = {
      messages: 0,
      parts: 0,
      bytes: 0,
      backlogRemains: false
    };
    try {
      const files = this.#host.openFiles();
      const stats = await this.#host.rowStats();
      const aged = stats.slice(
        0,
        mediaEvictionCutoff(
          stats.length,
          config.keepRecentMessages,
          this.#host.truncationStep()
        )
      );

      let processed = 0;
      for (const row of aged) {
        // The stored row is not large enough to hold an evictable payload —
        // skip without reading it. A rewritten row drops below this line and
        // is skipped by every later pass.
        if (row.bytes < config.minPartBytes) continue;
        if (processed >= config.maxRowsPerPass) {
          totals.backlogRemains = true;
          break;
        }
        processed++;

        const message = await this.#host.readMessage(row.id);
        if (!message) continue;

        const result = await evictMediaFromMessage(message, {
          minPartBytes: config.minPartBytes,
          write: async (index, bytes, mediaType) => {
            const path = evictedFilePath(message.id, index, mediaType);
            await files.write(path, bytes);
            return path;
          }
        });
        if (!result.changed) continue;

        // The rewritten row no longer carries the payload, so the bytes now
        // exist only as the Workspace file.
        await this.#host.updateMessage(result.message);
        totals.messages++;
        totals.parts += result.parts;
        totals.bytes += result.bytes;
      }

      const storedBytes = this.#host.storedBytes();
      if (totals.messages > 0) {
        this.#fruitless = null;
        this.#host.emitEvicted({
          messages: totals.messages,
          parts: totals.parts,
          bytes: totals.bytes
        });
      } else if (this.#host.agedRowsHiddenFromCache() && storedBytes !== null) {
        this.#fruitless = {
          storedBytes,
          appendsSince: this.#appendsDuringPass
        };
      }
      return totals;
    } catch (error) {
      console.error(
        "[Think] media eviction pass failed; a later pass will retry.",
        error
      );
      return null;
    } finally {
      this.#running = false;
      // Only chain when this pass actually shrank something: a pass that
      // changed nothing would otherwise reschedule itself forever.
      if (totals.backlogRemains && totals.messages > 0) {
        this.request();
      }
      // A request that landed mid-pass goes back through the gate now, so
      // media aged by an append during this pass is not left until the
      // next one. The gate, not the request, decides whether a pass runs.
      if (this.#pending) {
        this.#pending = false;
        this.request();
      }
    }
  }
}
