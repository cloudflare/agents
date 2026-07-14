import {
  jsonSchema,
  streamText,
  tool,
  type JSONSchema7,
  type JSONValue,
  type LanguageModel,
  type ModelMessage as AiModelMessage,
  type Tool,
  type ToolChoice,
} from "ai";
import { AbortedError } from "../../kernel/errors.js";
import type {
  ModelChunk,
  ModelClient,
  ModelMessage,
  ModelRequest,
  ToolDescriptor,
} from "../../ports/model.js";

type AiToolSet = Record<string, Tool<unknown, never>>;
type AiProviderOptions = Parameters<typeof streamText<AiToolSet>>[0]["providerOptions"];

export function createAiSdkModel(model: LanguageModel): ModelClient {
  return {
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const { providerOptions, ...settings } = request.settings ?? {};
      const result = streamText({
        model,
        ...(request.system !== undefined ? { system: request.system } : {}),
        messages: request.messages.map(toAiMessage),
        allowSystemInMessages: true,
        ...(request.tools.length > 0 ? { tools: toAiTools(request.tools) } : {}),
        ...(request.toolChoice !== undefined ? { toolChoice: toAiToolChoice(request.toolChoice) } : {}),
        ...settings,
        ...(providerOptions !== undefined ? { providerOptions: providerOptions as AiProviderOptions } : {}),
        ...(request.signal ? { abortSignal: request.signal } : {}),
      });

      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              yield { type: "text-delta", text: part.text };
              break;
            case "reasoning-delta":
              yield { type: "reasoning-delta", text: part.text };
              break;
            case "tool-call":
              yield {
                type: "tool-call",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
              };
              break;
            case "finish":
              yield {
                type: "finish",
                finishReason: toModelFinishReason(part.finishReason),
                usage: {
                  inputTokens: part.totalUsage.inputTokens,
                  outputTokens: part.totalUsage.outputTokens,
                },
              };
              break;
            case "error":
              throw normalizeError(part.error, request.signal);
            case "abort":
              throw new AbortedError(part.reason ?? "Model request aborted");
            default:
              break;
          }
        }
      } catch (error) {
        throw normalizeError(error, request.signal);
      }
    },
  };
}

function toAiMessage(message: ModelMessage): AiModelMessage {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return { role: "assistant", content: message.content };
    case "tool":
      return {
        role: "tool",
        content: message.content.map((part) => ({
          type: "tool-result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: toAiToolResultOutput(part.output, part.isError === true),
        })),
      };
  }
}

function toAiTools(descriptors: ToolDescriptor[]): AiToolSet {
  const out: AiToolSet = {};
  for (const descriptor of descriptors) {
    out[descriptor.name] = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(descriptor.inputSchema as JSONSchema7),
    });
  }
  return out;
}

function toAiToolChoice(choice: ModelRequest["toolChoice"]): ToolChoice<AiToolSet> | undefined {
  if (choice === undefined) return undefined;
  if (choice === "auto" || choice === "none") return choice;
  return { type: "tool", toolName: choice.toolName };
}

function toAiToolResultOutput(output: unknown, isError: boolean) {
  if (typeof output === "string") {
    return isError ? { type: "error-text" as const, value: output } : { type: "text" as const, value: output };
  }
  return isError
    ? { type: "error-json" as const, value: output as JSONValue }
    : { type: "json" as const, value: output as JSONValue };
}

function toModelFinishReason(
  reason: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other",
): Extract<ModelChunk, { type: "finish" }>["finishReason"] {
  switch (reason) {
    case "stop":
    case "tool-calls":
    case "length":
    case "error":
    case "content-filter":
      return reason;
    case "other":
    default:
      // The port has no "other"/"unknown" vocabulary; an otherwise completed
      // generation is treated as a normal stop.
      return "stop";
  }
}

function normalizeError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (error instanceof AbortedError) return error;
  if (signal?.aborted) {
    const message =
      signal.reason instanceof Error
        ? signal.reason.message
        : typeof signal.reason === "string"
          ? signal.reason
          : "Model request aborted";
    return new AbortedError(message);
  }
  return error;
}
