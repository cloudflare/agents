import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/** One recorded `binding.run(model, input, options)` call. */
export interface RunCall {
  model: string;
  input: Record<string, unknown>;
  options: Record<string, unknown>;
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

export interface FakeBinding {
  /** Workers AI run-path calls, in order. */
  calls: RunCall[];
  /** Universal AI Gateway calls, in order. */
  universal: UniversalCall[];
  aiGatewayLogId: string | null;
  run(
    model: string,
    input: Record<string, unknown>,
    options: Record<string, unknown>
  ): Promise<Response>;
  gateway(id: string): {
    run(
      request: Record<string, unknown>,
      options: Record<string, unknown>
    ): Promise<Response>;
  };
}

/** What a fake binding answers with, whichever path the call took. */
export type AnyCall =
  | ({ kind: "run" } & RunCall)
  | ({ kind: "universal" } & UniversalCall);

/**
 * An `Ai`-shaped binding that records every call — the Workers AI run path and
 * the universal gateway path — and answers with canned `Response` objects. The
 * responder sees the call so a test can vary the answer per model (fallback
 * legs) or per request body.
 */
export function fakeBinding(
  responder: (call: AnyCall, index: number) => Response | Promise<Response>
): FakeBinding {
  const calls: RunCall[] = [];
  const universal: UniversalCall[] = [];
  let index = 0;
  return {
    aiGatewayLogId: null,
    calls,
    gateway(id) {
      return {
        async run(request, options) {
          const call: UniversalCall = {
            endpoint: String(request.endpoint ?? ""),
            gatewayId: id,
            headers: (request.headers ?? {}) as Record<string, string>,
            options,
            provider: String(request.provider ?? ""),
            query: (request.query ?? {}) as Record<string, unknown>
          };
          universal.push(call);
          return await responder({ kind: "universal", ...call }, index++);
        }
      };
    },
    async run(model, input, options) {
      const call: RunCall = { input, model, options };
      calls.push(call);
      return await responder({ kind: "run", ...call }, index++);
    },
    universal
  };
}

/** Casts a fake binding to the ambient `Ai` type for `createAI({ binding })`. */
export function asAi(binding: FakeBinding): Ai {
  return binding as unknown as Ai;
}

/** A JSON `Response`, the shape both paths return for non-streaming calls. */
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
 * An SSE `Response` in the shape the live captures use: a named `event:` line
 * before each `data:` line, and the padding the gateway appends inside the data
 * payload. Both are things the decoder has to survive.
 */
export function sseEventResponse(
  events: { event: string; data: unknown }[],
  init: { headers?: Record<string, string> } = {}
): Response {
  const body = events
    .map(
      (entry, index) =>
        `event: ${entry.event}\r\ndata: ${JSON.stringify(padded(entry.data))}${" ".repeat(index % 5)}\r\n\r\n`
    )
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream", ...init.headers },
    status: 200
  });
}

/**
 * AI Gateway adds a `p` padding field to every SSE data event it forwards
 * (live capture `43-demos-anthropic-stream.json`). Every vendor parser ignores
 * it, and these fixtures carry it so ours is held to the same bar.
 */
function padded(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }
  return { p: "f002a9", ...(data as Record<string, unknown>) };
}

/** {@link padded} for the string-payload form {@link sseResponse} takes. */
export function gatewayPadded(events: string[]): string[] {
  return events.map((event) => {
    if (event === "[DONE]") return event;
    try {
      return JSON.stringify(padded(JSON.parse(event)));
    } catch {
      return event;
    }
  });
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

/**
 * A vendor model the way a user gets one: from the vendor's own pi-ai registry
 * import. Nothing about these ids lives in `agents`.
 */
export function anthropicModel(id: string): Model<Api> {
  const model = anthropicProvider()
    .getModels()
    .find((entry) => entry.id === id);
  if (model === undefined) throw new Error(`No such Anthropic model: ${id}`);
  return model;
}

/** The OpenAI twin of {@link anthropicModel}. */
export function openaiModel(id: string): Model<Api> {
  const model = openaiProvider()
    .getModels()
    .find((entry) => entry.id === id);
  if (model === undefined) throw new Error(`No such OpenAI model: ${id}`);
  return model;
}

/** A vendor whose models speak chat completions rather than Responses. */
export function groqModel(id: string): Model<Api> {
  const model = groqProvider()
    .getModels()
    .find((entry) => entry.id === id);
  if (model === undefined) throw new Error(`No such Groq model: ${id}`);
  return model;
}

/** Drains a pi-ai event stream and returns the events plus the final message. */
export async function collectEvents(
  stream: AssistantMessageEventStream
): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: await stream.result() };
}

/** A one-message user context. */
export function userContext(text: string, systemPrompt?: string): Context {
  return {
    messages: [{ content: text, role: "user", timestamp: 1 }],
    ...(systemPrompt !== undefined ? { systemPrompt } : {})
  };
}

/** The `getWeather` tool used across the tool-calling tests. */
export const WEATHER_TOOL_PARAMETERS = {
  properties: { city: { type: "string" } },
  required: ["city"],
  type: "object"
} as const;

// ── Workers AI chat-completions fixtures (from live captures) ───────────────

function cfChunk(
  delta: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    choices: [{ delta, finish_reason: null, index: 0, logprobs: null }],
    created: 1788432944,
    id: "chatcmpl-976ebec0943daf97",
    model: "@cf/zai-org/glm-4.7-flash",
    object: "chat.completion.chunk",
    usage: {
      completion_tokens: 1,
      prompt_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
      total_tokens: 1
    },
    ...extra
  });
}

/**
 * The live `@cf/zai-org/glm-4.7-flash` stream shape: reasoning deltas, text
 * deltas, a finish_reason on the last delta, a `choices: []` heartbeat, the
 * native `{ response: "", usage }` tail, then `[DONE]`.
 */
export function workersAITextStream(): string[] {
  return [
    cfChunk({ content: "", reasoning_content: null, role: "assistant" }),
    cfChunk({ reasoning: "Think", reasoning_content: "Think" }),
    cfChunk({ reasoning: "ing", reasoning_content: "ing" }),
    cfChunk({ content: "Hello", reasoning_content: null }),
    cfChunk({ content: " there", reasoning_content: null }),
    JSON.stringify({
      choices: [
        {
          delta: { content: "", reasoning_content: null },
          finish_reason: "stop",
          index: 0
        }
      ],
      id: "chatcmpl-976ebec0943daf97",
      model: "@cf/zai-org/glm-4.7-flash",
      object: "chat.completion.chunk",
      usage: { completion_tokens: 1, prompt_tokens: 0, total_tokens: 1 }
    }),
    JSON.stringify({
      choices: [],
      id: "chatcmpl-976ebec0943daf97",
      model: "@cf/zai-org/glm-4.7-flash",
      object: "chat.completion.chunk",
      usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 }
    }),
    JSON.stringify({
      response: "",
      usage: {
        completion_tokens: 64,
        prompt_tokens: 11,
        prompt_tokens_details: { cached_tokens: 0 },
        total_tokens: 75
      }
    }),
    "[DONE]"
  ];
}

/** The live tool-call stream: one complete tool call in a single delta. */
export function workersAIToolStream(): string[] {
  return [
    cfChunk({ content: "", reasoning_content: null, role: "assistant" }),
    cfChunk({ reasoning: "Need the tool", reasoning_content: "Need the tool" }),
    cfChunk({
      content: "",
      reasoning_content: null,
      tool_calls: [
        {
          function: { arguments: '{"city": "London"}', name: "getWeather" },
          id: "chatcmpl-tool-8a8be1fee2f66115",
          index: 0,
          type: "function"
        }
      ]
    }),
    JSON.stringify({
      choices: [
        {
          delta: { content: "", reasoning_content: null },
          finish_reason: "tool_calls",
          index: 0
        }
      ],
      id: "chatcmpl-8a89690ae79d2cd2",
      model: "@cf/zai-org/glm-4.7-flash",
      object: "chat.completion.chunk"
    }),
    JSON.stringify({
      response: "",
      usage: { completion_tokens: 76, prompt_tokens: 165, total_tokens: 241 }
    }),
    "[DONE]"
  ];
}

/** The live non-streaming tool-call body (OpenAI-shaped, `message.tool_calls`). */
export function workersAIToolJson(): Record<string, unknown> {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        index: 0,
        message: {
          content: "",
          reasoning_content: "Need the tool",
          role: "assistant",
          tool_calls: [
            {
              function: { arguments: '{"city": "London"}', name: "getWeather" },
              id: "chatcmpl-tool-1",
              type: "function"
            }
          ]
        }
      }
    ],
    id: "chatcmpl-1",
    model: "@cf/zai-org/glm-4.7-flash",
    object: "chat.completion",
    usage: { completion_tokens: 20, prompt_tokens: 100, total_tokens: 120 }
  };
}

// ── OpenAI Responses fixtures (from live captures) ──────────────────────────

const RESPONSE_ID = "resp_00e338d0989cb1cd016a997132d32487d1950d5ef6962a059d";

function responseObject(
  status: string,
  output: unknown[],
  usage?: Record<string, unknown>
): Record<string, unknown> {
  return {
    created_at: 1788440882,
    error: null,
    id: RESPONSE_ID,
    incomplete_details:
      status === "incomplete" ? { reason: "max_output_tokens" } : null,
    model: "gpt-5-mini-2025-08-07",
    object: "response",
    output,
    status,
    ...(usage !== undefined ? { usage } : {})
  };
}

/** A Responses stream that produces a text answer. */
export function responsesTextStream(): string[] {
  const item = {
    content: [],
    id: "msg_1",
    role: "assistant",
    status: "in_progress",
    type: "message"
  };
  return [
    JSON.stringify({
      response: responseObject("in_progress", []),
      sequence_number: 0,
      type: "response.created"
    }),
    JSON.stringify({
      item,
      output_index: 0,
      sequence_number: 1,
      type: "response.output_item.added"
    }),
    JSON.stringify({
      content_index: 0,
      item_id: "msg_1",
      output_index: 0,
      part: { annotations: [], text: "", type: "output_text" },
      sequence_number: 2,
      type: "response.content_part.added"
    }),
    JSON.stringify({
      content_index: 0,
      delta: "Hi",
      item_id: "msg_1",
      output_index: 0,
      sequence_number: 3,
      type: "response.output_text.delta"
    }),
    JSON.stringify({
      content_index: 0,
      delta: " there",
      item_id: "msg_1",
      output_index: 0,
      sequence_number: 4,
      type: "response.output_text.delta"
    }),
    JSON.stringify({
      content_index: 0,
      item_id: "msg_1",
      output_index: 0,
      sequence_number: 5,
      text: "Hi there",
      type: "response.output_text.done"
    }),
    JSON.stringify({
      content_index: 0,
      item_id: "msg_1",
      output_index: 0,
      part: { annotations: [], text: "Hi there", type: "output_text" },
      sequence_number: 6,
      type: "response.content_part.done"
    }),
    JSON.stringify({
      item: {
        ...item,
        content: [{ annotations: [], text: "Hi there", type: "output_text" }],
        status: "completed"
      },
      output_index: 0,
      sequence_number: 7,
      type: "response.output_item.done"
    }),
    JSON.stringify({
      response: responseObject(
        "completed",
        [
          {
            ...item,
            content: [
              { annotations: [], text: "Hi there", type: "output_text" }
            ],
            status: "completed"
          }
        ],
        {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 17
        }
      ),
      sequence_number: 8,
      type: "response.completed"
    })
  ];
}

/** The live Responses tool-call stream: reasoning item, then a function call. */
export function responsesToolStream(): string[] {
  const reasoning = {
    content: [],
    encrypted_content: "gAAAAABqmXEz",
    id: "rs_1",
    summary: [],
    type: "reasoning"
  };
  const call = {
    arguments: "",
    call_id: "call_unp9dHSGlMt2wHjx8nqygdbU",
    id: "fc_1",
    name: "getWeather",
    status: "in_progress",
    type: "function_call"
  };
  const doneCall = {
    ...call,
    arguments: '{"city":"London"}',
    status: "completed"
  };
  const delta = (text: string, sequence: number) =>
    JSON.stringify({
      delta: text,
      item_id: "fc_1",
      output_index: 1,
      sequence_number: sequence,
      type: "response.function_call_arguments.delta"
    });
  return [
    JSON.stringify({
      response: responseObject("in_progress", []),
      sequence_number: 0,
      type: "response.created"
    }),
    JSON.stringify({
      item: reasoning,
      output_index: 0,
      sequence_number: 1,
      type: "response.output_item.added"
    }),
    JSON.stringify({
      item: reasoning,
      output_index: 0,
      sequence_number: 2,
      type: "response.output_item.done"
    }),
    JSON.stringify({
      item: call,
      output_index: 1,
      sequence_number: 3,
      type: "response.output_item.added"
    }),
    delta('{"', 4),
    delta("city", 5),
    delta('":"', 6),
    delta("London", 7),
    delta('"}', 8),
    JSON.stringify({
      arguments: '{"city":"London"}',
      item_id: "fc_1",
      output_index: 1,
      sequence_number: 9,
      type: "response.function_call_arguments.done"
    }),
    JSON.stringify({
      item: doneCall,
      output_index: 1,
      sequence_number: 10,
      type: "response.output_item.done"
    }),
    JSON.stringify({
      response: responseObject("completed", [reasoning, doneCall], {
        input_tokens: 80,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 40,
        output_tokens_details: { reasoning_tokens: 20 },
        total_tokens: 120
      }),
      sequence_number: 11,
      type: "response.completed"
    })
  ];
}

// ── Anthropic Messages fixtures (from live captures) ────────────────────────

export function anthropicTextEvents(): { event: string; data: unknown }[] {
  return [
    {
      data: {
        message: {
          content: [],
          id: "msg_011CegXJ2PMnTsENC1z3qbFx",
          model: "claude-sonnet-4-5-20250929",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          type: "message",
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 14,
            output_tokens: 1
          }
        },
        type: "message_start"
      },
      event: "message_start"
    },
    {
      data: {
        content_block: { text: "", type: "text" },
        index: 0,
        type: "content_block_start"
      },
      event: "content_block_start"
    },
    { data: { type: "ping" }, event: "ping" },
    {
      data: {
        delta: { text: "Hi", type: "text_delta" },
        index: 0,
        type: "content_block_delta"
      },
      event: "content_block_delta"
    },
    {
      data: {
        delta: { text: " there!", type: "text_delta" },
        index: 0,
        type: "content_block_delta"
      },
      event: "content_block_delta"
    },
    {
      data: { index: 0, type: "content_block_stop" },
      event: "content_block_stop"
    },
    {
      data: {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        type: "message_delta",
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 14,
          output_tokens: 8
        }
      },
      event: "message_delta"
    },
    { data: { type: "message_stop" }, event: "message_stop" }
  ];
}

export function anthropicToolEvents(): { event: string; data: unknown }[] {
  return [
    {
      data: {
        message: {
          content: [],
          id: "msg_011CegXJHQVkUzmX21onvirW",
          model: "claude-sonnet-4-5-20250929",
          role: "assistant",
          stop_reason: null,
          type: "message",
          usage: { input_tokens: 564, output_tokens: 1 }
        },
        type: "message_start"
      },
      event: "message_start"
    },
    {
      data: {
        content_block: {
          id: "toolu_0155RDpmUnKdRHZkMrjAqgwL",
          input: {},
          name: "getWeather",
          type: "tool_use"
        },
        index: 0,
        type: "content_block_start"
      },
      event: "content_block_start"
    },
    {
      data: {
        delta: { partial_json: '{"c', type: "input_json_delta" },
        index: 0,
        type: "content_block_delta"
      },
      event: "content_block_delta"
    },
    {
      data: {
        delta: { partial_json: 'ity": "Lond', type: "input_json_delta" },
        index: 0,
        type: "content_block_delta"
      },
      event: "content_block_delta"
    },
    {
      data: {
        delta: { partial_json: 'on"}', type: "input_json_delta" },
        index: 0,
        type: "content_block_delta"
      },
      event: "content_block_delta"
    },
    {
      data: { index: 0, type: "content_block_stop" },
      event: "content_block_stop"
    },
    {
      data: {
        delta: { stop_reason: "tool_use", stop_sequence: null },
        type: "message_delta",
        usage: { input_tokens: 564, output_tokens: 53 }
      },
      event: "message_delta"
    },
    { data: { type: "message_stop" }, event: "message_stop" }
  ];
}

/** The gateway envelope for a unified-billing block, as captured live. */
export function billingError(): Record<string, unknown> {
  return {
    error: [
      {
        code: 2021,
        message: "Insufficient balance; add money to your gateway or use BYOK"
      }
    ],
    httpCode: 402,
    internalCode: 2021,
    message: "Insufficient balance; add money to your gateway or use BYOK",
    messages: [],
    name: "AiGatewayError",
    result: [],
    success: false
  };
}
