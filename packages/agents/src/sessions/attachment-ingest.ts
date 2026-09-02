/**
 * Which parts of a message become attachments, and how they come back.
 *
 * The rule is typed, not size-based: a part that DECLARES a non-text media
 * type and carries its payload inline is an attachment, whatever its size.
 * Text, reasoning and plain tool output are never extracted — they stay in the
 * row and, if they are too large for one, chunk across continuation rows.
 *
 * That distinction is the whole point. Sizing the rule off bytes would make a
 * message's stored shape depend on how big an image happened to be, which is
 * how the previous design ended up as a rescue mechanism that competed with
 * row chunking. Extraction here is uniform, so a reader never has to ask why
 * one image is a pointer and another is inline.
 *
 * Extraction is lossless: bytes move to the attachment store and a read puts
 * them back verbatim. Nothing that shapes what a model SEES belongs here — a
 * cap on tool output discards content and so lives on the read path, in
 * `agents/context`, where it can change without having destroyed anything.
 */

import { hashPayload, type AttachmentBytes } from "./attachment-store";
import type { SessionMessage, SessionMessagePart } from "./types";

/** Pointer scheme written into a stored part in place of its payload. */
export const ATTACHMENT_URL_PREFIX = "attachment:sha256:";

/** Hostile or deeply nested tool output stops here rather than recursing forever. */
const MAX_WALK_DEPTH = 8;

/** Build the pointer for a content address. */
export function attachmentUrl(hash: string): string {
  return `${ATTACHMENT_URL_PREFIX}${hash}`;
}

/** The content address in a pointer, or `null` when the value is not one. */
export function parseAttachmentUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith(ATTACHMENT_URL_PREFIX)) {
    return null;
  }
  const hash = url.slice(ATTACHMENT_URL_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

interface ParsedDataUrl {
  mediaType: string;
  payload: string;
}

/** Parse a base64 `data:` URL. Non-base64 data URLs are left alone. */
function parseDataUrl(url: string): ParsedDataUrl | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  if (!header.endsWith(";base64")) return null;
  const mediaType =
    header.slice(0, -";base64".length) || "application/octet-stream";
  return { mediaType, payload: url.slice(comma + 1) };
}

/**
 * Text payloads stay in the message. They chunk perfectly well, they are what
 * FTS indexes, and moving them out would put prose behind a pointer for no gain.
 */
function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/");
}

function decodeBase64(payload: string): Uint8Array | null {
  const compact = /[\t\n\f\r ]/.test(payload)
    ? payload.replace(/[\t\n\f\r ]/g, "")
    : payload;
  if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact))
    return null;
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  // Chunked so a large payload never blows the argument limit of `apply`.
  const step = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** Rebuild the exact `data:` URL a payload was extracted from. */
export function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${encodeBase64(bytes)}`;
}

/**
 * A value carrying inline media: anything that declares a `mediaType` and
 * holds its bytes in a `url` data URL or a base64 `data` string. Covers AI SDK
 * file parts and the media entries tool results return, without either shape
 * being named here.
 */
function inlineMediaOf(
  value: Record<string, unknown>
): { field: "url" | "data"; mediaType: string; bytes: Uint8Array } | null {
  const declared = typeof value.mediaType === "string" ? value.mediaType : null;

  const url = value.url;
  if (typeof url === "string") {
    const parsed = parseDataUrl(url);
    if (!parsed) return null;
    const mediaType = declared ?? parsed.mediaType;
    if (isTextMediaType(mediaType)) return null;
    const bytes = decodeBase64(parsed.payload);
    return bytes ? { field: "url", mediaType, bytes } : null;
  }

  // A bare `data` string is only media when something declared it as such.
  if (
    declared &&
    typeof value.data === "string" &&
    !isTextMediaType(declared)
  ) {
    const bytes = decodeBase64(value.data);
    return bytes ? { field: "data", mediaType: declared, bytes } : null;
  }
  return null;
}

/** One payload lifted out of a message, already addressed. */
export interface PendingAttachment {
  readonly hash: string;
  readonly payload: AttachmentBytes;
}

/** What one extraction pass produced. */
export interface ExtractionResult {
  /** The message to store: identical when it carried no inline media. */
  message: SessionMessage;
  /** Payloads to write, deduplicated by address, in encounter order. */
  attachments: PendingAttachment[];
}

/**
 * Replace inline media with pointers, collecting the payloads to store.
 *
 * Returns the original message by reference when nothing was extracted, so the
 * overwhelmingly common text-only write allocates nothing and pays only a walk.
 */
export function extractAttachments(message: SessionMessage): ExtractionResult {
  const attachments: PendingAttachment[] = [];
  const seen = new Set<string>();

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
    const media = inlineMediaOf(record);
    if (media) {
      // Hashing is pure CPU, so the address is known here and the write
      // transaction never has to hash anything.
      const hash = hashPayload(media.bytes);
      if (!seen.has(hash)) {
        seen.add(hash);
        attachments.push({
          hash,
          payload: { bytes: media.bytes, mediaType: media.mediaType }
        });
      }
      // The pointer replaces the payload IN PLACE, in whichever field held it.
      // Keeping the field means a resolve restores the original shape exactly,
      // rather than rewriting a `data` entry into a `url` one.
      return {
        ...record,
        mediaType: media.mediaType,
        [media.field]: attachmentUrl(hash)
      };
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

  if (message.parts.length === 0) return { message, attachments };
  const parts = walk(message.parts, 0) as SessionMessagePart[];
  if (parts === message.parts) return { message, attachments };
  return { message: { ...message, parts }, attachments };
}

/** Every content address a stored message points at. */
export function referencedAttachments(message: SessionMessage): string[] {
  const hashes = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || value === null || typeof value !== "object")
      return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const hash =
      parseAttachmentUrl(record.url) ?? parseAttachmentUrl(record.data);
    if (hash) {
      hashes.add(hash);
      return;
    }
    for (const entry of Object.values(record)) walk(entry, depth + 1);
  };
  walk(message.parts, 0);
  return [...hashes];
}

/**
 * Put payloads back inline, undoing extraction exactly.
 *
 * A pointer whose bytes cannot be loaded is left as it is: an unresolvable
 * pointer is a truthful record that the reference survived its payload, which
 * only a bug could produce, and inventing a placeholder would hide it.
 */
export function resolveAttachments(
  message: SessionMessage,
  load: (hash: string) => { mediaType: string; bytes: Uint8Array } | undefined
): SessionMessage {
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
    const urlHash = parseAttachmentUrl(record.url);
    if (urlHash) {
      const loaded = load(urlHash);
      if (!loaded) return value;
      return { ...record, url: dataUrl(loaded.mediaType, loaded.bytes) };
    }
    const dataHash = parseAttachmentUrl(record.data);
    if (dataHash) {
      const loaded = load(dataHash);
      if (!loaded) return value;
      // A `data` field held bare base64, not a data URL, so it is restored bare.
      return { ...record, data: encodeBase64(loaded.bytes) };
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

  const parts = walk(message.parts, 0) as SessionMessagePart[];
  return parts === message.parts ? message : { ...message, parts };
}
