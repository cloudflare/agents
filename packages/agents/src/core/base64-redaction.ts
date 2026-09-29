// Internal base64 redaction shared by the browser tools (model-facing output)
// and AI tracing (oversized tool payloads). Not part of the public API.

const BASE64_REDACTION_THRESHOLD = 4096;
const MAX_REDACTION_DEPTH = 20;
const MAX_REDACTION_NODES = 10_000;

function base64Details(
  value: string,
  minimumLength = BASE64_REDACTION_THRESHOLD
): {
  mediaType?: string;
  chars: number;
  bytes: number;
} | null {
  if (value.length < minimumLength) return null;

  const dataUrl =
    /^data:([^;,]+)(?:;[^;,]*)*;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  const encoded = dataUrl?.[2] ?? value;
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    return null;
  }

  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return {
    mediaType: dataUrl?.[1],
    chars: encoded.length,
    bytes: (encoded.length / 4) * 3 - padding
  };
}

function base64Redaction(
  value: string,
  mediaType?: string,
  minimumLength?: number
): string {
  const details = base64Details(value, minimumLength);
  if (!details) return value;
  const type = mediaType ?? details.mediaType;
  return `[base64${type ? ` ${type}` : ""} data omitted: ${details.chars.toLocaleString()} chars, approximately ${details.bytes.toLocaleString()} bytes]`;
}

export function redactBase64Payloads(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  function visit(current: unknown, depth: number): unknown {
    if (depth > MAX_REDACTION_DEPTH) return "[nested value omitted]";
    if (++nodes > MAX_REDACTION_NODES) return "[remaining values omitted]";
    if (typeof current === "string") return base64Redaction(current);
    if (typeof current !== "object" || current === null) return current;
    // Binary values cross the sandbox boundary as Uint8Array/ArrayBuffer —
    // walking them would rebuild them as index-keyed plain objects. The same
    // is true of Date/Map/Set, whose own enumerable entries are empty.
    if (
      current instanceof ArrayBuffer ||
      ArrayBuffer.isView(current) ||
      current instanceof Date ||
      current instanceof Map ||
      current instanceof Set
    ) {
      return current;
    }
    if (ancestors.has(current)) return "[circular reference omitted]";

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((entry) => visit(entry, depth + 1));
      }

      const record = current as Record<string, unknown>;
      const screenshot =
        record.type === "browser_screenshot" &&
        typeof record.mediaType === "string";
      return Object.fromEntries(
        Object.entries(record).map(([key, entry]) => [
          key,
          screenshot && key === "data" && typeof entry === "string"
            ? base64Redaction(entry, record.mediaType as string, 0)
            : visit(entry, depth + 1)
        ])
      );
    } finally {
      ancestors.delete(current);
    }
  }

  return visit(value, 0);
}

/**
 * `JSON.stringify` replacer applying the same rules as
 * {@link redactBase64Payloads}. Because it runs inside `JSON.stringify`,
 * `toJSON`, cycles and unsupported values behave exactly as they do without
 * it, and no depth or node limits are needed.
 */
export function redactBase64Replacer(
  this: unknown,
  key: string,
  value: unknown
): unknown {
  if (typeof value !== "string") return value;
  const holder = this as Record<string, unknown>;
  return key === "data" &&
    holder.type === "browser_screenshot" &&
    typeof holder.mediaType === "string"
    ? base64Redaction(value, holder.mediaType, 0)
    : base64Redaction(value);
}
