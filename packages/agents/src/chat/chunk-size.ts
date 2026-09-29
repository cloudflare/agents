const textEncoder = new TextEncoder();

/** Maximum serialized chunk body size before skipping storage (bytes). */
export const CHUNK_MAX_BYTES = 1_800_000;

/** Byte size of a chunk body in its stored (JSON-escaped) encoding. */
export function storedChunkBytes(body: string): number {
  return textEncoder.encode(JSON.stringify(body)).byteLength;
}

/**
 * Whether `ResumableStream.storeChunk` skips storing this body: it is still
 * broadcast live, but absent from replay.
 */
export function isChunkTooLargeToStore(body: string): boolean {
  return storedChunkBytes(body) > CHUNK_MAX_BYTES;
}
