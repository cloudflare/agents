import type { AiMarkdownConversionResult } from "../../../web/fetch/convert";

/** One request the stub fetch saw. */
export type SeenRequest = {
  url: string;
  method?: string;
  redirect?: RequestRedirect;
  headers: Record<string, string>;
};

/**
 * A `fetch` that answers from a URL → response table and records what it
 * was asked. Responses are built per call so bodies can be read again.
 */
export function stubFetch(
  routes: Record<string, () => Response | Promise<Response>>
): { fetch: typeof fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      url,
      method: init?.method,
      redirect: init?.redirect,
      headers: Object.fromEntries(new Headers(init?.headers).entries())
    });
    const route = routes[url];
    if (!route) return new Response("no route", { status: 599 });
    return route();
  };
  return { fetch: stub as typeof fetch, seen };
}

export function redirect(location: string, status = 302): () => Response {
  return () => new Response(null, { status, headers: { location } });
}

export function page(
  body: BodyInit | null,
  contentType: string | undefined,
  init: { status?: number; headers?: Record<string, string> } = {}
): () => Response {
  return () =>
    new Response(body, {
      status: init.status ?? 200,
      headers: {
        ...(contentType ? { "content-type": contentType } : {}),
        ...init.headers
      }
    });
}

/** What the fake binding was asked to convert. */
export type ConversionCall = { name: string; type: string; text: string };

/**
 * A fake `Ai` whose `toMarkdown` returns `markdown` (or whatever `respond`
 * produces) and records each file it was given.
 */
export function fakeAi(
  respond: (
    call: ConversionCall
  ) =>
    | AiMarkdownConversionResult
    | AiMarkdownConversionResult[]
    | Promise<AiMarkdownConversionResult> = (call) => ({
    name: call.name,
    mimeType: call.type,
    format: "markdown",
    tokens: 3,
    data: `# Converted ${call.name}`
  })
): { binding: Ai; calls: ConversionCall[] } {
  const calls: ConversionCall[] = [];
  const binding = {
    async toMarkdown(file: { name: string; blob: Blob }) {
      const call = {
        name: file.name,
        type: file.blob.type,
        text: await file.blob.text()
      };
      calls.push(call);
      return respond(call);
    }
  };
  return { binding: binding as unknown as Ai, calls };
}

/** A body that streams `chunks` of `size` bytes and counts how many were pulled. */
export function countingStream(
  chunks: number,
  size: number
): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) {
        controller.close();
        return;
      }
      pulled++;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    }
  });
  return { stream, pulled: () => pulled };
}
