interface BodySource {
  body: ReadableStream<Uint8Array> | null;
  headers: Headers;
}

/** Reads a body and enforces the byte limit independently of Content-Length. */
export async function readBodyWithLimit(
  source: BodySource,
  limit: number,
  tooLargeMessage = "Request body is too large"
): Promise<string> {
  const declaredLength = Number(source.headers.get("Content-Length") ?? "0");
  if (declaredLength > limit) {
    await source.body?.cancel().catch(() => undefined);
    throw new Error(tooLargeMessage);
  }
  if (!source.body) return "";

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      length += value.byteLength;
      if (length > limit) throw new Error(tooLargeMessage);
      chunks.push(value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}
