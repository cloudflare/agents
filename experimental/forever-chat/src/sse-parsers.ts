/**
 * Raw SSE parsers for buffer recovery.
 *
 * ## Why these exist
 *
 * The inference buffer stores raw provider bytes — whatever OpenAI, Anthropic,
 * or Workers AI sent over the wire. On recovery after DO eviction, we need to
 * extract text content and tool calls from these raw bytes to reconstruct the
 * assistant message.
 *
 * We can't use the AI SDK to parse these because the buffer sits BEFORE the
 * AI SDK in the pipeline (that's what lets it survive DO eviction — the provider
 * connection lives in the buffer, not in the agent). So on recovery, we
 * short-circuit the AI SDK and parse the raw SSE ourselves.
 *
 * If AI Gateway implemented this natively, it could store responses in a
 * normalized format and provide a retrieval API that returns parsed content
 * alongside raw SSE, eliminating the need for these client-side parsers.
 *
 * ## Provider SSE formats
 *
 * OpenAI: `data: {"choices":[{"delta":{"content":"text"}}]}`
 *         Tool calls via `delta.tool_calls[].{id, function.name, function.arguments}`
 *         Streamed incrementally by index.
 *
 * Anthropic: `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}`
 *            Tool calls via `content_block_start` (type: "tool_use") + `input_json_delta`.
 *
 * Workers AI: Either OpenAI-compatible (newer models like kimi-k2.5) or
 *             native `data: {"response":"text"}` format.
 */

export type ParsedToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ParsedResponse = {
  text: string;
  reasoning: string;
  toolCalls: ParsedToolCall[];
};

/**
 * Parse OpenAI SSE — handles BOTH formats:
 *
 * Chat Completions (/v1/chat/completions):
 *   data: {"choices":[{"delta":{"content":"text"}}]}
 *   Tool calls via delta.tool_calls[].{id, function.name, function.arguments}
 *   Reasoning via delta.reasoning_content or delta.reasoning
 *
 * Responses API (/v1/responses):
 *   data: {"type":"response.output_text.delta","delta":"text"}
 *   data: {"type":"response.reasoning_summary_text.delta","delta":"..."}
 *   Tool calls via response.output_item.added (name/id) +
 *     response.function_call_arguments.delta (incremental args)
 */
export function parseOpenAIStream(raw: string): ParsedResponse {
  let text = "";
  let reasoning = "";
  // Chat Completions format: tool calls indexed by position in delta array
  const chatToolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  // Responses API format: tool calls indexed by output_index
  const responsesToolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const data = JSON.parse(line.slice(6));

      // -- Chat Completions format --
      const delta = data.choices?.[0]?.delta;
      if (delta) {
        if (typeof delta.content === "string") {
          text += delta.content;
        }
        const r = delta.reasoning_content ?? delta.reasoning;
        if (typeof r === "string") {
          reasoning += r;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index as number;
            if (!chatToolCalls.has(idx)) {
              chatToolCalls.set(idx, { id: "", name: "", arguments: "" });
            }
            const entry = chatToolCalls.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") {
              entry.arguments += tc.function.arguments;
            }
          }
        }
        continue;
      }

      // -- Responses API format --
      const type = data.type as string | undefined;
      if (!type) continue;

      if (type === "response.output_text.delta") {
        if (typeof data.delta === "string") text += data.delta;
      } else if (type === "response.reasoning_summary_text.delta") {
        if (typeof data.delta === "string") reasoning += data.delta;
      } else if (type === "response.output_item.added") {
        const item = data.item;
        if (item?.type === "function_call") {
          responsesToolCalls.set(data.output_index as number, {
            id: item.call_id ?? item.id ?? "",
            name: item.name ?? "",
            arguments: ""
          });
        }
      } else if (type === "response.function_call_arguments.delta") {
        const entry = responsesToolCalls.get(data.output_index as number);
        if (entry && typeof data.delta === "string") {
          entry.arguments += data.delta;
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  const toolCalls = [
    ...chatToolCalls.values(),
    ...responsesToolCalls.values()
  ].filter((tc) => tc.id && tc.name);

  return { text, reasoning, toolCalls };
}

export function parseAnthropicStream(raw: string): ParsedResponse {
  let text = "";
  let reasoning = "";
  // Track which content block indices are thinking blocks
  const thinkingBlocks = new Set<number>();
  const toolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const data = JSON.parse(line.slice(6));

      if (
        data.type === "content_block_delta" &&
        data.delta?.type === "text_delta"
      ) {
        text += data.delta.text;
      }

      // Thinking blocks: content_block_start with type "thinking",
      // then thinking_delta chunks append the reasoning text.
      if (
        data.type === "content_block_start" &&
        data.content_block?.type === "thinking"
      ) {
        thinkingBlocks.add(data.index);
      }

      if (
        data.type === "content_block_delta" &&
        data.delta?.type === "thinking_delta" &&
        thinkingBlocks.has(data.index)
      ) {
        reasoning += data.delta.thinking;
      }

      // Tool use starts with content_block_start (id + name),
      // then input_json_delta chunks append partial JSON.
      if (
        data.type === "content_block_start" &&
        data.content_block?.type === "tool_use"
      ) {
        toolCalls.set(data.index, {
          id: data.content_block.id,
          name: data.content_block.name,
          arguments: ""
        });
      }

      if (
        data.type === "content_block_delta" &&
        data.delta?.type === "input_json_delta"
      ) {
        const entry = toolCalls.get(data.index);
        if (entry) {
          entry.arguments += data.delta.partial_json;
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return {
    text,
    reasoning,
    toolCalls: [...toolCalls.values()].filter((tc) => tc.id && tc.name)
  };
}

/**
 * Workers AI models may use either OpenAI-compatible SSE or the native
 * format (`{"response":"text"}`). Try OpenAI first; fall back to native.
 */
export function parseWorkersAIStream(raw: string): ParsedResponse {
  const openai = parseOpenAIStream(raw);
  if (openai.text || openai.reasoning || openai.toolCalls.length > 0)
    return openai;

  let text = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const data = JSON.parse(line.slice(6));
      if (typeof data.response === "string") text += data.response;
    } catch {
      // skip malformed lines
    }
  }
  return { text, reasoning: "", toolCalls: [] };
}

export type Provider = "workersai" | "openai" | "anthropic";

export function parseProviderStream(
  provider: Provider,
  raw: string
): ParsedResponse {
  switch (provider) {
    case "anthropic":
      return parseAnthropicStream(raw);
    case "workersai":
      return parseWorkersAIStream(raw);
    default:
      return parseOpenAIStream(raw);
  }
}
