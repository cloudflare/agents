export async function createResponsePayload(response: Response) {
  const body = response.body
    ? await extractBody(enforceSizeLimit(response.body, 1024 * 1024 * 10))
    : undefined;

  // Create the payload object
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersToObject(response.headers),
    body,
  };
}

export async function createRequestPayload(
  request: Request<unknown, CfProperties<unknown>>
) {
  const body = request.body ? await extractBody(request.body) : undefined;

  // Create the payload object
  return {
    method: request.method,
    url: request.url,
    headers: headersToObject(request.headers),
    body,
  };
}

async function extractBody(body: ReadableStream<Uint8Array<ArrayBufferLike>>) {
  let bodyText: string | undefined;

  try {
    const reader = enforceSizeLimit(body, 1024 * 1024 * 2).getReader();
    const decoder = new TextDecoder("utf-8");
    bodyText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      // Decode the value and append it to the body
      // Use the decoder to convert the Uint8Array to a string
      // and append it to the body
      bodyText += decoder.decode(value, { stream: true });
    }
    return bodyText;
  } catch (e) {
    if (e instanceof SizeError) {
      return "Body too large";
    }

    return "Error reading body";
  }
}

function headersToObject(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });

  return result;
}

class SizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SizeError";
  }
}

/**
 * Wrap a ReadableStream so it errors once > maxBytes have flowed through.
 * The transformer preserves the original chunk type (string | Uint8Array).
 */
export function enforceSizeLimit(
  src: ReadableStream<string>,
  maxBytes: number
): ReadableStream<string>;
export function enforceSizeLimit(
  src: ReadableStream<Uint8Array>,
  maxBytes: number
): ReadableStream<Uint8Array>;
export function enforceSizeLimit<T extends string | Uint8Array>(
  src: ReadableStream<T>,
  maxBytes: number
): ReadableStream<T> {
  let total = 0;

  const { readable, writable } = new TransformStream<T, T>({
    transform(chunk, controller) {
      // Compute byte length for either strings or Uint8Arrays
      const bytes =
        typeof chunk === "string"
          ? new TextEncoder().encode(chunk).byteLength
          : chunk.byteLength;
      total += bytes;

      if (total > maxBytes) {
        controller.error(
          new SizeError(`Payload too large: ${total} > ${maxBytes} bytes`)
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  // Start piping in the background; ignore the promise.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  src.pipeTo(writable).catch(() => {
    /* suppressed: downstream handles the error */
  });

  return readable;
}
