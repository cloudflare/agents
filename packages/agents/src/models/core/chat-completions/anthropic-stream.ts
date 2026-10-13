/**
 * Translates an Anthropic Messages SSE stream into `chat.completion.chunk`
 * events.
 *
 * AI Gateway's `/run` converts a chat-completions request into a catalog
 * model's native format, and converts a non-streamed answer back. On its
 * legacy runtime it does not convert a stream back
 * (`compat/run-compat.ts`: "a streaming legacy request gets the connector's
 * native stream format"), so a streamed Claude catalog model answers in
 * Anthropic events even though chat completions was asked for. This bridges
 * that gap until the gateway converts streams; once it does, no Anthropic
 * event arrives and this code never runs.
 *
 * Detection is by shape: an event with a string `type` and no `choices` is an
 * Anthropic event. A chat-completions chunk always has `choices` and no
 * `type`, so a stream that is already chat completions passes untouched.
 */

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Anthropic's stop reasons, as chat-completions finish reasons. */
const FINISH_REASONS: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  pause_turn: "stop",
  refusal: "content_filter",
  stop_sequence: "stop",
  tool_use: "tool_calls"
};

/** Whether a parsed SSE payload is an Anthropic Messages event. */
export function isAnthropicEvent(event: Record_): boolean {
  return typeof event.type === "string" && !("choices" in event);
}

/**
 * A stateful translator for one stream. Returns the chat-completions chunks
 * an Anthropic event becomes — possibly none — or `undefined` for an event
 * that is not Anthropic, which the caller handles as it is.
 */
export function createAnthropicStreamTranslator(): (
  event: Record_
) => Record_[] | undefined {
  let id: string | undefined;
  let model: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  // Content block index → tool-call index, for tool_use blocks.
  const toolIndexes = new Map<number, number>();

  const chunk = (delta: Record_, finishReason: string | null = null) => ({
    choices: [{ delta, finish_reason: finishReason, index: 0 }],
    ...(id === undefined ? {} : { id }),
    ...(model === undefined ? {} : { model }),
    object: "chat.completion.chunk"
  });

  return (event) => {
    if (!isAnthropicEvent(event)) return undefined;
    switch (event.type) {
      case "message_start": {
        const message = isRecord(event.message) ? event.message : {};
        if (typeof message.id === "string") id = message.id;
        if (typeof message.model === "string") model = message.model;
        const usage = isRecord(message.usage) ? message.usage : {};
        const cacheRead = Number(usage.cache_read_input_tokens ?? 0) || 0;
        const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0) || 0;
        inputTokens =
          (Number(usage.input_tokens ?? 0) || 0) + cacheRead + cacheWrite;
        cachedTokens = cacheRead;
        outputTokens = Number(usage.output_tokens ?? 0) || 0;
        return [chunk({ role: "assistant" })];
      }
      case "content_block_start": {
        const block = isRecord(event.content_block) ? event.content_block : {};
        const index = Number(event.index ?? 0);
        if (block.type !== "tool_use") return [];
        const toolIndex = toolIndexes.size;
        toolIndexes.set(index, toolIndex);
        return [
          chunk({
            tool_calls: [
              {
                function: {
                  arguments: "",
                  name: typeof block.name === "string" ? block.name : ""
                },
                id: typeof block.id === "string" ? block.id : undefined,
                index: toolIndex,
                type: "function"
              }
            ]
          })
        ];
      }
      case "content_block_delta": {
        const delta = isRecord(event.delta) ? event.delta : {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          return [chunk({ content: delta.text })];
        }
        if (
          delta.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        ) {
          return [chunk({ reasoning_content: delta.thinking })];
        }
        if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          const toolIndex = toolIndexes.get(Number(event.index ?? 0));
          if (toolIndex === undefined) return [];
          return [
            chunk({
              tool_calls: [
                {
                  function: { arguments: delta.partial_json },
                  index: toolIndex
                }
              ]
            })
          ];
        }
        // signature_delta and anything newer carry nothing chat completions
        // can express.
        return [];
      }
      case "message_delta": {
        const usage = isRecord(event.usage) ? event.usage : {};
        if (typeof usage.output_tokens === "number") {
          outputTokens = usage.output_tokens;
        }
        const delta = isRecord(event.delta) ? event.delta : {};
        const stop =
          typeof delta.stop_reason === "string" ? delta.stop_reason : undefined;
        if (stop === undefined) return [];
        return [chunk({}, FINISH_REASONS[stop] ?? "stop")];
      }
      case "message_stop":
        return [
          {
            choices: [],
            ...(id === undefined ? {} : { id }),
            ...(model === undefined ? {} : { model }),
            object: "chat.completion.chunk",
            usage: {
              completion_tokens: outputTokens,
              prompt_tokens: inputTokens,
              ...(cachedTokens > 0
                ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
                : {}),
              total_tokens: inputTokens + outputTokens
            }
          }
        ];
      case "error": {
        const error = isRecord(event.error) ? event.error : {};
        return [
          {
            error: {
              message:
                typeof error.message === "string"
                  ? error.message
                  : "The model's stream ended with an error.",
              type: typeof error.type === "string" ? error.type : "error"
            }
          }
        ];
      }
      default:
        // ping, content_block_stop, and event types added later.
        return [];
    }
  };
}
