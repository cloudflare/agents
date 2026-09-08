/**
 * Message hygiene shared by every Sessions write: UTF-8 measurement without a
 * full encoded copy, and removal of ephemeral provider metadata that must not
 * be stored or replayed.
 */

const textEncoder = new TextEncoder();
const BYTE_LENGTH_BUFFER_BYTES = 16 * 1024;
const BYTE_LENGTH_WINDOW_CHARS = 16 * 1024;

/**
 * Measure UTF-8 byte length without allocating a complete encoded copy.
 * Memory stays bounded by a 16 KiB buffer even for near-row-limit strings.
 */
export function byteLength(s: string): number {
  const buffer = new Uint8Array(BYTE_LENGTH_BUFFER_BYTES);
  let offset = 0;
  let bytes = 0;
  while (offset < s.length) {
    let end = Math.min(s.length, offset + BYTE_LENGTH_WINDOW_CHARS);
    if (
      end < s.length &&
      end > offset &&
      isHighSurrogate(s.charCodeAt(end - 1))
    ) {
      end--;
    }
    const { read, written } = textEncoder.encodeInto(
      s.slice(offset, end),
      buffer
    );
    if (read === 0) break;
    offset += read;
    bytes += written;
  }
  return bytes;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

type PartRecord = Record<string, unknown> & { type: string };

/**
 * Sanitize a message for persistence by removing ephemeral provider-specific
 * data that should not be stored or sent back in subsequent requests.
 *
 * 1. Strips OpenAI ephemeral fields (itemId, reasoningEncryptedContent)
 * 2. Filters truly empty reasoning parts (no text, no remaining providerMetadata)
 */
export function sanitizeMessage<M extends { parts: readonly object[] }>(
  message: M
): M {
  const parts = (message.parts as readonly PartRecord[]).flatMap((part) => {
    let sanitized = part;
    for (const key of ["providerMetadata", "callProviderMetadata"] as const) {
      const metadata = sanitized[key];
      if (
        metadata &&
        typeof metadata === "object" &&
        "openai" in (metadata as Record<string, unknown>)
      ) {
        sanitized = stripOpenAIMetadata(sanitized, key);
      }
    }
    if (sanitized.type === "reasoning") {
      const text = sanitized.text;
      if (typeof text !== "string" || text.trim() === "") {
        const metadata = sanitized.providerMetadata;
        const keep =
          metadata &&
          typeof metadata === "object" &&
          Object.keys(metadata as object).length > 0;
        if (!keep) return [];
      }
    }
    return [sanitized];
  });
  return { ...message, parts };
}

function stripOpenAIMetadata(
  part: PartRecord,
  metadataKey: "providerMetadata" | "callProviderMetadata"
): PartRecord {
  const metadata = part[metadataKey] as {
    openai?: Record<string, unknown>;
    [key: string]: unknown;
  };
  if (!metadata?.openai) return part;

  const {
    itemId: _itemId,
    reasoningEncryptedContent: _rec,
    ...restOpenai
  } = metadata.openai;
  const { openai: _openai, ...restMetadata } = metadata;

  let next: Record<string, unknown> | undefined;
  if (Object.keys(restOpenai).length > 0) {
    next = { ...restMetadata, openai: restOpenai };
  } else if (Object.keys(restMetadata).length > 0) {
    next = restMetadata;
  }

  const { [metadataKey]: _old, ...rest } = part;
  return next
    ? ({ ...rest, [metadataKey]: next } as PartRecord)
    : (rest as PartRecord);
}
