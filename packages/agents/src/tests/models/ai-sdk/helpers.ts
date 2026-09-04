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

/** One recorded `binding.gateway(id).run(request, options)` call. */
export interface UniversalCall {
  gatewayId: string;
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
  options: Record<string, unknown>;
}

export interface FakeGatewayBinding extends FakeBinding {
  universal: UniversalCall[];
  gateway(id: string): {
    run(
      request: Record<string, unknown>,
      options: Record<string, unknown>
    ): Promise<Response>;
  };
}

/**
 * An `Ai` binding that answers both paths: `run` for Workers AI models and
 * `gateway(id).run` for the universal request a routed vendor model makes.
 * Both are recorded, so one fake covers a mixed fallback chain.
 */
export function fakeGatewayBinding(options: {
  run?: (call: RunCall, index: number) => Response | Promise<Response>;
  universal?: (
    call: UniversalCall,
    index: number
  ) => Response | Promise<Response>;
}): FakeGatewayBinding {
  const calls: RunCall[] = [];
  const universal: UniversalCall[] = [];
  return {
    aiGatewayLogId: null,
    calls,
    gateway(gatewayId: string) {
      return {
        async run(request, runOptions) {
          const call: UniversalCall = {
            endpoint: String(request.endpoint),
            gatewayId,
            headers: request.headers as Record<string, string>,
            options: runOptions,
            provider: String(request.provider),
            query: request.query as Record<string, unknown>
          };
          universal.push(call);
          return (
            (await options.universal?.(call, universal.length - 1)) ??
            jsonResponse({})
          );
        }
      };
    },
    async run(model, input, runOptions) {
      const call: RunCall = { input, model, options: runOptions };
      calls.push(call);
      return (await options.run?.(call, calls.length - 1)) ?? jsonResponse({});
    },
    universal
  };
}

/** The `cf-aig-*` headers a live gateway answer carries (43-demos captures). */
export function gatewayHeaders(
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    "cf-aig-cache-status": "MISS",
    "cf-aig-event-id": "7bfd3660-9d0f-4bf7-bf9b-fa90b860456f",
    "cf-aig-log-id": "01M1KZWN069WWNPC18V05NKHSS",
    "cf-aig-request-id": "7bfd3660-9d0f-4bf7-bf9b-fa90b860456f",
    "cf-aig-step": "0",
    "cf-aig-trace-id": "2babd9bbb1984dfc90417e513c60a714",
    ...overrides
  };
}

/** A verbatim SSE `Response`, for replaying a captured vendor stream. */
export function rawSseResponse(
  body: string,
  init: { headers?: Record<string, string> } = {}
): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      ...init.headers
    },
    status: 200
  });
}
