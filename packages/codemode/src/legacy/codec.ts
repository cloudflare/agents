/**
 * Host-side value codec.
 *
 * Two layers share the binary encoding (a tagged base64 envelope):
 *
 * - **Transport** (`stringifyForCodemode`/`parseForCodemode`): used for the
 *   host↔sandbox tool-call boundary. Must stay in lockstep with the sandbox's
 *   own codec (`SANDBOX_CODEC` in executor.ts).
 * - **Storage** (`stringifyForStorage`/`parseForStorage`): used by the
 *   CodemodeRuntime facet to persist args/results in SQLite. Builds on the
 *   transport encoding and additionally round-trips `bigint` (which plain
 *   `JSON.stringify` rejects). The bigint tag is storage-only — it never
 *   crosses into the sandbox.
 */

export const BINARY_TAG = "__codemode_binary_v1__";
const BIGINT_TAG = "__codemode_bigint_v1__";

type EncodedBinary = {
  [BINARY_TAG]: "Uint8Array" | "ArrayBuffer" | "ArrayBufferView";
  data: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength))
    );
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function encodeCodemodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { [BINARY_TAG]: "Uint8Array", data: bytesToBase64(value) };
  }
  if (value instanceof ArrayBuffer) {
    return {
      [BINARY_TAG]: "ArrayBuffer",
      data: bytesToBase64(new Uint8Array(value))
    };
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return {
      [BINARY_TAG]: "ArrayBufferView",
      data: bytesToBase64(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      )
    };
  }
  return value;
}

export function decodeCodemodeValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || !(BINARY_TAG in value)) {
    return value;
  }
  const encoded = value as EncodedBinary;
  if (typeof encoded.data !== "string") return value;
  const bytes = base64ToBytes(encoded.data);
  if (encoded[BINARY_TAG] === "ArrayBuffer") {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
  }
  return bytes;
}

export function stringifyForCodemode(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => encodeCodemodeValue(nested));
}

export function parseForCodemode(json: string): unknown {
  return JSON.parse(json, (_key, nested) => decodeCodemodeValue(nested));
}

// ---------------------------------------------------------------------------
// Storage codec — binary + bigint, for the runtime's SQLite columns.
// ---------------------------------------------------------------------------

/**
 * Serialize a value for durable storage. Returns `undefined` when the value is
 * `undefined` (callers store SQL NULL — distinguishing "no value" from a
 * recorded `null`, which serializes to the string `"null"`).
 *
 * Throws on values JSON cannot represent even with the codec (e.g. cycles):
 * a durable replay log cannot faithfully store such a value, and silently
 * storing an approximation would corrupt replay.
 */
export function stringifyForStorage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return JSON.stringify(value, (_key, nested) => {
    if (typeof nested === "bigint") {
      return { [BIGINT_TAG]: nested.toString() };
    }
    return encodeCodemodeValue(nested);
  });
}

export function parseForStorage(json: string | null): unknown {
  if (json === null) return undefined;
  return JSON.parse(json, (_key, nested) => {
    if (
      nested &&
      typeof nested === "object" &&
      BIGINT_TAG in nested &&
      typeof (nested as Record<string, unknown>)[BIGINT_TAG] === "string"
    ) {
      return BigInt((nested as Record<string, string>)[BIGINT_TAG]);
    }
    return decodeCodemodeValue(nested);
  });
}
