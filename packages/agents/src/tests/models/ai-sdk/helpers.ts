import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";

/** One recorded `binding.run(model, input, options)` call. */
export interface RunCall {
  model: string;
  input: Record<string, unknown>;
  options: Record<string, unknown>;
}

export interface FakeBinding {
  calls: RunCall[];
  aiGatewayLogId: string | null;
  run(
    model: string,
    input: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<Response>;
}

/**
 * An `Ai`-shaped binding that records every call and answers with canned
 * `Response` objects. The responder receives the call so a test can vary the
 * answer per model (fallback legs) or per request body.
 */
export function fakeBinding(
  responder: (call: RunCall, index: number) => Response | Promise<Response>
): FakeBinding {
  const calls: RunCall[] = [];
  return {
    aiGatewayLogId: null,
    calls,
    async run(model, input, options) {
      const call: RunCall = { input, model, options };
      calls.push(call);
      return await responder(call, calls.length - 1);
    }
  };
}

/** Casts a fake binding to the ambient `Ai` type for `createAI({ binding })`. */
export function asAi(binding: FakeBinding): Ai {
  return binding as unknown as Ai;
}

/** A JSON `Response`, the shape the run path returns for non-streaming calls. */
export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...init.headers },
    status: init.status ?? 200
  });
}

/**
 * An SSE `Response`. CRLF separators, as the live captures use, so the decoder
 * is exercised on the real byte shape rather than a tidied one.
 */
export function sseResponse(
  events: string[],
  init: { headers?: Record<string, string> } = {}
): Response {
  const body = events.map((event) => `data: ${event}\r\n\r\n`).join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream", ...init.headers },
    status: 200
  });
}

/**
 * An SSE `Response` in the shape the live Anthropic captures use: a named
 * `event:` line before each `data:` line, and the run-length padding Anthropic
 * appends inside the data payload. Both are things the decoder has to survive.
 */
export function sseEventResponse(
  events: { event: string; data: unknown }[],
  init: { headers?: Record<string, string> } = {}
): Response {
  const body = events
    .map(
      (entry, index) =>
        `event: ${entry.event}\r\ndata: ${JSON.stringify(entry.data)}${" ".repeat(index % 5)}\r\n\r\n`
    )
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream", ...init.headers },
    status: 200
  });
}

/** Drains a stream into an array. */
export async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const parts: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

/** Minimal valid `doGenerate`/`doStream` options with a one-line user prompt. */
export function callOptions(
  overrides: Partial<LanguageModelV4CallOptions> = {}
): LanguageModelV4CallOptions {
  return {
    prompt: [{ content: [{ text: "hi", type: "text" }], role: "user" }],
    ...overrides
  };
}

/** Reads a nested field off a recorded request body without widening to any. */
export function field(body: unknown, path: string): unknown {
  let current: unknown = body;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
