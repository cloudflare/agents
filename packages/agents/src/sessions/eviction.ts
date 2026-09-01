/**
 * Memory-bounded rewriting of aged tool outputs.
 *
 * File parts use the attachment engine's normal lossless pointer extraction.
 * This module handles strings nested inside tool outputs while preserving the
 * output's object and array shape. Blob writes happen during the walk, before
 * the caller attempts its compare-and-swap message rewrite.
 */

import { byteLength } from "../chat/sanitize";
import {
  attachmentUrl,
  estimatedDataUrlBytes,
  type StoredAttachment
} from "./attachments";
import type { SessionMessage, SessionMessagePart } from "./types";

const MAX_WALK_DEPTH = 8;

/** Sink used by the tool-output walker to store one evicted value. */
export type EvictionAttachmentSink = (
  value: string,
  mediaType: string
) => Promise<StoredAttachment>;

/** Result of externalizing oversized strings from one message's tool parts. */
export interface ToolOutputEvictionResult {
  /** Rewritten message, or the original reference when nothing changed. */
  message: SessionMessage;
  /** True when at least one string was replaced. */
  changed: boolean;
  /** Number of strings replaced. */
  parts: number;
  /** UTF-8 payload bytes removed from the row. */
  bytes: number;
  /** Blobs written before the row rewrite. */
  attachments: StoredAttachment[];
}

type WalkState = {
  readonly minBytes: number;
  readonly put: EvictionAttachmentSink | null;
  readonly attachments: StoredAttachment[];
  parts: number;
  bytes: number;
};

/**
 * Largest payload aged maintenance could rewrite in one stored message.
 * Storing this threshold-independent number lets hosts change policy without
 * rescanning rows that contain no file or tool-output payloads.
 */
export function maxEvictableMediaBytes(message: SessionMessage): number {
  let maximum = 0;
  for (const part of message.parts) {
    if (
      part.type === "file" &&
      typeof part.url === "string" &&
      part.url.startsWith("data:")
    ) {
      maximum = Math.max(maximum, estimatedDataUrlBytes(part.url));
      continue;
    }
    if (
      (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
      part.output !== undefined
    ) {
      maximum = Math.max(maximum, maxNestedStringBytes(part.output, 0));
    }
  }
  return maximum;
}

/** Whether a message has an externalizable payload at the current threshold. */
export function hasEvictableMedia(
  message: SessionMessage,
  minBytes: number
): boolean {
  return maxEvictableMediaBytes(message) >= Math.max(1, Math.floor(minBytes));
}

/**
 * Externalize large strings nested in tool outputs.
 *
 * Plain text and reasoning parts remain untouched. The walker stops after
 * eight nested object or array levels so hostile output cannot exhaust the
 * stack.
 */
export async function evictToolOutputStrings(
  message: SessionMessage,
  minBytes: number,
  put: EvictionAttachmentSink | null
): Promise<ToolOutputEvictionResult> {
  const state: WalkState = {
    minBytes: Math.max(1, Math.floor(minBytes)),
    put,
    attachments: [],
    parts: 0,
    bytes: 0
  };
  let changed = false;
  const parts: SessionMessagePart[] = [];

  for (const part of message.parts) {
    if (
      (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
      part.output !== undefined
    ) {
      const result = await walkAndEvict(state, part.output, 0);
      if (result !== part.output) {
        changed = true;
        parts.push({ ...part, output: result });
        continue;
      }
    }
    parts.push(part);
  }

  return {
    message: changed ? { ...message, parts } : message,
    changed,
    parts: state.parts,
    bytes: state.bytes,
    attachments: state.attachments
  };
}

function maxNestedStringBytes(value: unknown, depth: number): number {
  if (typeof value === "string") return byteLength(value);
  if (value === null || typeof value !== "object" || depth >= MAX_WALK_DEPTH) {
    return 0;
  }
  let maximum = 0;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    maximum = Math.max(maximum, maxNestedStringBytes(item, depth + 1));
  }
  return maximum;
}

async function walkAndEvict(
  state: WalkState,
  value: unknown,
  depth: number
): Promise<unknown> {
  if (typeof value === "string") {
    const bytes = byteLength(value);
    if (bytes < state.minBytes) return value;
    const mediaType = dataUrlMediaType(value);
    state.parts++;
    state.bytes += bytes;
    if (!state.put) return evictionMarker(bytes, mediaType, null);
    const attachment = await state.put(value, mediaType ?? "text/plain");
    state.attachments.push(attachment);
    return evictionMarker(bytes, mediaType, attachment);
  }

  if (value === null || typeof value !== "object" || depth >= MAX_WALK_DEPTH) {
    return value;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const output: unknown[] = [];
    for (const item of value) {
      const next = await walkAndEvict(state, item, depth + 1);
      if (next !== item) changed = true;
      output.push(next);
    }
    return changed ? output : value;
  }

  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const next = await walkAndEvict(state, item, depth + 1);
    if (next !== item) changed = true;
    output[key] = next;
  }
  return changed ? output : value;
}

/** Replace oversized data-URL file parts without preserving their bytes. */
export function dropLargeFileParts(
  message: SessionMessage,
  minBytes: number
): ToolOutputEvictionResult {
  let count = 0;
  let bytes = 0;
  let changed = false;
  const threshold = Math.max(1, Math.floor(minBytes));
  const parts = message.parts.map((part) => {
    if (
      part.type !== "file" ||
      typeof part.url !== "string" ||
      !part.url.startsWith("data:")
    ) {
      return part;
    }
    const payloadBytes = estimatedDataUrlBytes(part.url);
    if (payloadBytes < threshold) return part;
    const storedBytes = byteLength(part.url);
    changed = true;
    count++;
    bytes += storedBytes;
    return {
      type: "text",
      text: evictionMarker(
        storedBytes,
        part.mediaType ?? dataUrlMediaType(part.url),
        null
      )
    };
  });
  return {
    message: changed ? { ...message, parts } : message,
    changed,
    parts: count,
    bytes,
    attachments: []
  };
}

function evictionMarker(
  bytes: number,
  mediaType: string | null | undefined,
  attachment: StoredAttachment | null
): string {
  const media = mediaType ? `${mediaType}, ` : "";
  return attachment
    ? `[evicted ${media}${bytes} bytes; preserved at ${attachment.path}; pointer ${attachmentUrl(attachment.hash)}]`
    : `[evicted ${media}${bytes} bytes]`;
}

function dataUrlMediaType(value: string): string | null {
  if (!value.startsWith("data:")) return null;
  const match = /^data:([^;,]+)/.exec(value);
  return match?.[1] || null;
}
