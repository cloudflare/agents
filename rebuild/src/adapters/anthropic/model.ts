import Anthropic from "@anthropic-ai/sdk";
import type {
  ModelChunk,
  ModelClient,
  ModelMessage,
  ModelRequest,
  ToolDescriptor,
} from "../../ports/model.js";

/**
 * ModelClient adapter over the official Anthropic SDK (streaming Messages
 * API). Maps the domain's ModelRequest/ModelChunk contract onto SDK stream
 * events.
 *
 * Thinking note: the `thinking` parameter is deliberately omitted, which on
 * claude-opus-4-8 runs the request without extended thinking. The domain's
 * ModelMessage cannot yet carry provider thinking blocks across turns, and
 * adaptive thinking with tool use requires echoing those blocks back
 * verbatim — enable adaptive here only once the port grows a raw-provider
 * passthrough.
 */
export function createAnthropicModel(options?: {
  apiKey?: string;
  model?: string;
  maxOutputTokens?: number;
}): ModelClient {
  const client = new Anthropic(options?.apiKey ? { apiKey: options.apiKey } : {});
  const model = options?.model ?? "claude-opus-4-8";
  const defaultMaxTokens = options?.maxOutputTokens ?? 8192;

  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: request.settings?.maxOutputTokens ?? defaultMaxTokens,
          ...(request.system !== undefined ? { system: request.system } : {}),
          messages: toAnthropicMessages(request.messages),
          ...(request.tools.length > 0 ? { tools: request.tools.map(toAnthropicTool) } : {}),
          ...(toolChoice(request.toolChoice) ?? {}),
          ...(request.settings?.stopSequences ? { stop_sequences: request.settings.stopSequences } : {}),
        },
        request.signal ? { signal: request.signal } : undefined,
      );

      // Accumulate tool_use inputs from input_json_delta; emit the tool-call
      // chunk when the block closes.
      const openToolBlocks = new Map<number, { id: string; name: string; json: string }>();
      let stopReason: string | null = null;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start":
            if (event.content_block.type === "tool_use") {
              openToolBlocks.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                json: "",
              });
            }
            break;
          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              yield { type: "text-delta", text: event.delta.text };
            } else if (event.delta.type === "thinking_delta") {
              yield { type: "reasoning-delta", text: event.delta.thinking };
            } else if (event.delta.type === "input_json_delta") {
              const block = openToolBlocks.get(event.index);
              if (block) block.json += event.delta.partial_json;
            }
            break;
          case "content_block_stop": {
            const block = openToolBlocks.get(event.index);
            if (block) {
              openToolBlocks.delete(event.index);
              let input: unknown = {};
              try {
                input = block.json ? JSON.parse(block.json) : {};
              } catch {
                input = { _raw: block.json };
              }
              yield { type: "tool-call", toolCallId: block.id, toolName: block.name, input };
            }
            break;
          }
          case "message_delta":
            stopReason = event.delta.stop_reason ?? stopReason;
            usage = { outputTokens: event.usage.output_tokens };
            break;
          default:
            break;
        }
      }

      const final = await stream.finalMessage();
      usage = {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      };
      yield { type: "finish", finishReason: mapStopReason(stopReason ?? final.stop_reason), usage };
    },
  };
}

function mapStopReason(reason: string | null): "stop" | "tool-calls" | "length" | "error" | "content-filter" {
  switch (reason) {
    case "tool_use":
      return "tool-calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content-filter";
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
    default:
      return "stop";
  }
}

function toAnthropicTool(tool: ToolDescriptor): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: (tool.inputSchema ?? { type: "object" }) as Anthropic.Tool.InputSchema,
  };
}

function toolChoice(
  choice: ModelRequest["toolChoice"],
): { tool_choice: Anthropic.ToolChoice } | undefined {
  if (choice === undefined || choice === "auto") return undefined;
  if (choice === "none") return { tool_choice: { type: "none" } };
  return { tool_choice: { type: "tool", name: choice.toolName } };
}

function toAnthropicMessages(messages: ModelMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        // Top-level system is passed separately; a stray mid-conversation
        // system message becomes user context text.
        out.push({ role: "user", content: [{ type: "text", text: m.content }] });
        break;
      case "user":
        out.push({
          role: "user",
          content: m.content.map((p) =>
            p.type === "text"
              ? ({ type: "text", text: p.text } satisfies Anthropic.TextBlockParam)
              : ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: p.mediaType as "image/png",
                    data: p.data,
                  },
                } satisfies Anthropic.ImageBlockParam),
          ),
        });
        break;
      case "assistant":
        out.push({
          role: "assistant",
          content: m.content.map((p) =>
            p.type === "text"
              ? ({ type: "text", text: p.text } satisfies Anthropic.TextBlockParam)
              : ({
                  type: "tool_use",
                  id: p.toolCallId,
                  name: p.toolName,
                  input: p.input ?? {},
                } satisfies Anthropic.ToolUseBlockParam),
          ),
        });
        break;
      case "tool":
        out.push({
          role: "user",
          content: m.content.map(
            (p) =>
              ({
                type: "tool_result",
                tool_use_id: p.toolCallId,
                content: typeof p.output === "string" ? p.output : JSON.stringify(p.output),
                ...(p.isError ? { is_error: true } : {}),
              }) satisfies Anthropic.ToolResultBlockParam,
          ),
        });
        break;
    }
  }
  return out;
}
