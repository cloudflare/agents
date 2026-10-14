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

/** One recorded provider-native request: `env.AI.fetch` to the gateway. */
export interface NativeCall {
  gatewayId: string;
  provider: string;
  endpoint: string;
  method: string;
  /** Request headers, names lowercased. */
  headers: Record<string, string>;
  /** The raw body the vendor sent. */
  body: BodyInit | null | undefined;
  /** The body parsed as JSON, or `{}` when it is not JSON. */
  query: Record<string, unknown>;
}

export interface FakeGatewayBinding extends FakeBinding {
  native: NativeCall[];
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** The binding route aig-entry serves for the provider-native path. */
const NATIVE_ROUTE =
  /^https:\/\/workers-binding\.ai\/ai-gateway\/gateways\/([^/]+)\/([^/]+)\/(.*)$/;

function parsedQuery(
  body: BodyInit | null | undefined
): Record<string, unknown> {
  const text =
    typeof body === "string"
      ? body
      : body instanceof ArrayBuffer
        ? new TextDecoder().decode(body)
        : undefined;
  if (text === undefined) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * An `Ai` binding that answers both halves: `run` for model ids and `fetch`
 * for the provider-native requests a vendor's model object makes. Both are
 * recorded, so one fake covers a mixed fallback chain.
 */
export function fakeGatewayBinding(options: {
  run?: (call: RunCall, index: number) => Response | Promise<Response>;
  native?: (call: NativeCall, index: number) => Response | Promise<Response>;
}): FakeGatewayBinding {
  const calls: RunCall[] = [];
  const native: NativeCall[] = [];
  return {
    aiGatewayLogId: null,
    calls,
    async fetch(input, init) {
      const match = NATIVE_ROUTE.exec(input);
      if (match === null) throw new Error(`unexpected binding fetch: ${input}`);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      // A streamed body (a `Request`'s, passed through) is read here, as the
      // gateway would read it.
      const body =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : init?.body;
      const call: NativeCall = {
        body,
        endpoint: match[3] ?? "",
        gatewayId: decodeURIComponent(match[1] ?? ""),
        headers,
        method: init?.method ?? "GET",
        provider: match[2] ?? "",
        query: parsedQuery(body)
      };
      native.push(call);
      return (
        (await options.native?.(call, native.length - 1)) ?? jsonResponse({})
      );
    },
    native,
    async run(model, input, runOptions) {
      const call: RunCall = { input, model, options: runOptions };
      calls.push(call);
      return (await options.run?.(call, calls.length - 1)) ?? jsonResponse({});
    }
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
