import { ROW_MAX_BYTES } from "../internal/platform-limits";

const textEncoder = new TextEncoder();

/** Byte size of a chunk body in its stored (JSON-escaped) encoding. */
export function storedChunkBytes(body: string): number {
  return textEncoder.encode(JSON.stringify(body)).byteLength;
}

/**
 * Whether `ResumableStream.storeChunk` skips storing this body: it is still
 * broadcast live, but absent from replay.
 */
export function isChunkTooLargeToStore(body: string): boolean {
  return storedChunkBytes(body) > ROW_MAX_BYTES;
}
