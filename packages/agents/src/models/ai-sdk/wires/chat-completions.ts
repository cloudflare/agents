/**
 * The OpenAI chat-completions wire, in AI SDK terms.
 *
 * This module only maps AI SDK prompts and call options onto a strict OpenAI
 * chat-completions body, and strict OpenAI responses and chunks back onto AI
 * SDK content. Everything Cloudflare or a vendor does differently — Workers
 * AI's native events, its field spellings, per-family limits — is absorbed
 * once in `core/chat-completions`, before the request leaves and before the
 * response arrives here.
 */

import type {
  JSONObject,
  JSONSchema7,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4ProviderOptions,
  SharedV4Warning
} from "@ai-sdk/provider";
import {
  type CompatWarning,
  normalizeChatCompletion,
  prepareChatCompletionsRequest
} from "../../core/chat-completions";
import { PROVIDER_OPTIONS_KEY } from "../settings";
import {
  array,
  count,
  defaultFinishReason,
  emptyUsage,
  newId,
  record,
  text,
  toBase64,
  type WireGeneration,
  type WireRequest,
  type WireStreamParser
} from "./shared";

/**
 * What a request needs beyond the AI SDK call options.
 *
 * @experimental This surface is experimental and may change.
 */
export interface OpenAIWireContext {
  /** The catalog id; the compat layer keys its quirks off it. */
  modelId: string;
  stream: boolean;
  reasoningEffort: "low" | "medium" | "high" | null | undefined;
  chatTemplateKwargs: Record<string, unknown> | undefined;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function fullMediaType(mediaType: string): string {
  // A bare top-level segment ("image") is legal in the AI SDK but not in a
  // data URL, so pick a concrete subtype rather than emitting a broken URL.
  return mediaType.includes("/") ? mediaType : `${mediaType}/jpeg`;
}

function unsupported(feature: string, details: string): SharedV4Warning {
  return { details, feature, type: "unsupported" };
}

/** A compat-layer warning in the AI SDK's warning shape. */
function fromCompat(warning: CompatWarning): SharedV4Warning {
  return unsupported(warning.feature, warning.message);
}

/**
 * Gemini 3 signs each assistant turn and each function call with an opaque
 * `extra_content.google.thought_signature`, and rejects a function call
 * replayed in the same turn without it. Nothing here reads the payload: it is
 * carried out as provider metadata and put back verbatim on the next turn.
 *
 * `extraContent` is the signature of the assistant message; `toolExtraContent`
 * is the one that belongs to an individual `tool_calls[i]` entry.
 */
function extraContentMetadata(fields: {
  extraContent?: unknown;
  toolExtraContent?: unknown;
}): { providerMetadata: SharedV4ProviderMetadata } | Record<string, never> {
  const metadata: Record<string, unknown> = {};
  const message = record(fields.extraContent);
  const tool = record(fields.toolExtraContent);
  if (message !== undefined) metadata.extraContent = message;
  if (tool !== undefined) metadata.toolExtraContent = tool;
  if (Object.keys(metadata).length === 0) return {};
  return {
    providerMetadata: {
      [PROVIDER_OPTIONS_KEY]: metadata as JSONObject
    }
  };
}

/** Reads back what {@link extraContentMetadata} stored on a replayed part. */
function storedExtraContent(
  options: SharedV4ProviderOptions | undefined,
  key: "extraContent" | "toolExtraContent"
): Record<string, unknown> | undefined {
  return record(options?.[PROVIDER_OPTIONS_KEY]?.[key]);
}

function toolResultText(
  output: LanguageModelV4ToolResultOutput,
  warnings: SharedV4Warning[]
): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return output.reason ?? "The user denied this tool call.";
    case "content": {
      const dropped = output.value.filter((part) => part.type !== "text");
      if (dropped.length > 0) {
        // A tool result travels as one string on this wire, so anything that
        // is not text is lost rather than silently mangled into "".
        warnings.push(
          unsupported(
            "tool-result-part",
            `Tool result parts of type ${[
              ...new Set(dropped.map((part) => part.type))
            ].join(
              ", "
            )} cannot be sent on the chat-completions wire and were dropped.`
          )
        );
      }
      return output.value
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter((part) => part !== "")
        .join("\n");
    }
    default: {
      const exhaustive: never = output;
      return String(exhaustive);
    }
  }
}

function userContent(
  message: Extract<LanguageModelV4Message, { role: "user" }>,
  warnings: SharedV4Warning[]
): string | ContentPart[] {
  const parts: ContentPart[] = [];
  let onlyText = true;
  for (const part of message.content) {
    if (part.type === "text") {
      parts.push({ text: part.text, type: "text" });
      continue;
    }
    const isImage =
      part.mediaType === "image" || part.mediaType.startsWith("image/");
    if (!isImage) {
      warnings.push(
        unsupported(
          "file-part",
          `Files of type ${part.mediaType} are not supported on this wire and were dropped.`
        )
      );
      continue;
    }
    if (part.data.type === "data") {
      onlyText = false;
      parts.push({
        image_url: {
          url: `data:${fullMediaType(part.mediaType)};base64,${toBase64(part.data.data)}`
        },
        type: "image_url"
      });
      continue;
    }
    if (part.data.type === "url") {
      onlyText = false;
      parts.push({
        image_url: { url: part.data.url.toString() },
        type: "image_url"
      });
      continue;
    }
    warnings.push(
      unsupported(
        "file-part",
        "Only inline data and URL images are supported; the file was dropped."
      )
    );
  }
  if (onlyText) {
    return parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  }
  return parts;
}

function convertPrompt(
  prompt: LanguageModelV4Prompt,
  warnings: SharedV4Warning[]
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const message of prompt) {
    switch (message.role) {
      case "system":
        messages.push({ content: message.content, role: "system" });
        break;
      case "user":
        messages.push({
          content: userContent(message, warnings),
          role: "user"
        });
        break;
      case "assistant": {
        let content = "";
        let reasoning = "";
        let extraContent: Record<string, unknown> | undefined;
        const toolCalls: Record<string, unknown>[] = [];
        for (const part of message.content) {
          extraContent ??= storedExtraContent(
            part.providerOptions,
            "extraContent"
          );
          if (part.type === "text") content += part.text;
          else if (part.type === "reasoning") reasoning += part.text;
          else if (part.type === "tool-call") {
            const toolExtra = storedExtraContent(
              part.providerOptions,
              "toolExtraContent"
            );
            toolCalls.push({
              function: {
                arguments:
                  typeof part.input === "string"
                    ? part.input
                    : JSON.stringify(part.input ?? {}),
                name: part.toolName
              },
              id: part.toolCallId,
              type: "function",
              ...(toolExtra === undefined ? {} : { extra_content: toolExtra })
            });
          } else {
            warnings.push(
              unsupported(
                "assistant-part",
                `Assistant "${part.type}" parts cannot be replayed on the chat-completions wire and were dropped.`
              )
            );
          }
        }
        messages.push({
          content,
          // Replayed reasoning travels as `reasoning_content`; the compat
          // layer drops it for models that have no such field.
          ...(reasoning !== "" ? { reasoning_content: reasoning } : {}),
          ...(extraContent === undefined
            ? {}
            : { extra_content: extraContent }),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          role: "assistant"
        });
        break;
      }
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool-result") {
            warnings.push(
              unsupported(
                "tool-part",
                `Tool "${part.type}" parts are not carried on the chat-completions wire and were dropped.`
              )
            );
            continue;
          }
          messages.push({
            content: toolResultText(part.output, warnings),
            name: part.toolName,
            role: "tool",
            tool_call_id: part.toolCallId
          });
        }
        break;
      default: {
        const exhaustive: never = message;
        throw new Error(`Unsupported message role: ${String(exhaustive)}`);
      }
    }
  }
  return messages;
}

/** Folds the AI SDK's schema description into the schema itself. */
function foldSchema(
  schema: JSONSchema7,
  description: string | undefined
): JSONSchema7 {
  if (description === undefined || schema.description !== undefined) {
    return schema;
  }
  return { ...schema, description };
}

function responseFormat(
  options: LanguageModelV4CallOptions
): Record<string, unknown> | undefined {
  const format = options.responseFormat;
  if (format === undefined || format.type !== "json") return undefined;
  if (format.schema === undefined) return { type: "json_object" };
  return {
    json_schema: {
      name: format.name ?? "response",
      schema: foldSchema(format.schema, format.description),
      // The compat layer keeps `strict` only for vendors that implement it.
      strict: true
    },
    type: "json_schema"
  };
}

function toolFields(
  options: LanguageModelV4CallOptions,
  warnings: SharedV4Warning[]
): Record<string, unknown> {
  const tools: Record<string, unknown>[] = [];
  for (const tool of options.tools ?? []) {
    if (tool.type !== "function") {
      warnings.push(
        unsupported(
          "provider-tool",
          `Provider tool "${tool.name}" is not available through the Cloudflare run path.`
        )
      );
      continue;
    }
    tools.push({
      function: {
        description: tool.description,
        name: tool.name,
        parameters: tool.inputSchema
      },
      type: "function"
    });
  }
  if (tools.length === 0) return {};

  const choice = options.toolChoice;
  let toolChoice: unknown;
  switch (choice?.type) {
    case undefined:
      break;
    case "auto":
      toolChoice = "auto";
      break;
    case "none":
      toolChoice = "none";
      break;
    case "required":
      toolChoice = "required";
      break;
    case "tool":
      toolChoice = { function: { name: choice.toolName }, type: "function" };
      break;
    default: {
      const exhaustive: never = choice;
      throw new Error(`Unsupported tool choice: ${String(exhaustive)}`);
    }
  }
  return {
    tools,
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice })
  };
}

/**
 * The strict-body spelling of the reasoning request: an effort level, or
 * `null` for "off". The compat layer turns `null` into whatever the model
 * understands, or warns when nothing does.
 */
function reasoningEffortField(
  options: LanguageModelV4CallOptions,
  context: OpenAIWireContext
): Record<string, unknown> {
  if (context.reasoningEffort !== undefined) {
    return { reasoning_effort: context.reasoningEffort };
  }
  const reasoning = options.reasoning;
  if (reasoning === undefined || reasoning === "provider-default") return {};
  if (reasoning === "none") return { reasoning_effort: null };
  return { reasoning_effort: reasoning };
}

/**
 * Builds a strict OpenAI chat-completions body from AI SDK call options and
 * runs it through the compat layer for the target model.
 *
 * @experimental This surface is experimental and may change.
 */
export function buildOpenAIRequest(
  options: LanguageModelV4CallOptions,
  context: OpenAIWireContext
): WireRequest {
  const warnings: SharedV4Warning[] = [];

  if (options.topK !== undefined) {
    warnings.push(
      unsupported("topK", "topK is not part of the chat-completions API.")
    );
  }

  const format = responseFormat(options);
  const strict: Record<string, unknown> = {
    messages: convertPrompt(options.prompt, warnings),
    ...(options.maxOutputTokens === undefined
      ? {}
      : { max_tokens: options.maxOutputTokens }),
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
    ...(options.topP === undefined ? {} : { top_p: options.topP }),
    ...(options.stopSequences === undefined ||
    options.stopSequences.length === 0
      ? {}
      : { stop: options.stopSequences }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.frequencyPenalty === undefined
      ? {}
      : { frequency_penalty: options.frequencyPenalty }),
    ...(options.presencePenalty === undefined
      ? {}
      : { presence_penalty: options.presencePenalty }),
    ...(format === undefined ? {} : { response_format: format }),
    ...toolFields(options, warnings),
    ...reasoningEffortField(options, context),
    ...(context.chatTemplateKwargs === undefined
      ? {}
      : { chat_template_kwargs: context.chatTemplateKwargs }),
    // Usage on a stream only arrives when asked for, in a final
    // `choices: []` chunk; the compat layer makes every model look that way.
    ...(context.stream
      ? { stream: true, stream_options: { include_usage: true } }
      : {})
  };
  const prepared = prepareChatCompletionsRequest(strict, context.modelId);
  return {
    body: prepared.body,
    reasoningOff: prepared.reasoningOff,
    warnings: [...warnings, ...prepared.warnings.map(fromCompat)]
  };
}

function mapFinishReason(raw: unknown): LanguageModelV4FinishReason {
  const value = text(raw);
  switch (value) {
    case "stop":
      return { raw: value, unified: "stop" };
    case "length":
      return { raw: value, unified: "length" };
    case "tool_calls":
    case "function_call":
      return { raw: value, unified: "tool-calls" };
    case "content_filter":
      return { raw: value, unified: "content-filter" };
    case "error":
      return { raw: value, unified: "error" };
    default:
      return value === undefined
        ? defaultFinishReason()
        : { raw: value, unified: "other" };
  }
}

function mapUsage(raw: unknown): LanguageModelV4Usage {
  const usage = record(raw);
  if (usage === undefined) return emptyUsage();
  const promptTokens = count(usage.prompt_tokens);
  const cacheRead = count(record(usage.prompt_tokens_details)?.cached_tokens);
  const reasoningTokens = count(
    record(usage.completion_tokens_details)?.reasoning_tokens
  );
  const completionTokens = count(usage.completion_tokens);
  const totalTokens = count(usage.total_tokens);
  // Google counts reasoning outside `completion_tokens` (live: prompt 6 +
  // completion 3 + reasoning 57 = total 66), so taking `completion_tokens` as
  // the output total under-reports every reasoning token. OpenAI and Workers
  // AI both satisfy prompt + completion = total, so the derived figure agrees
  // with theirs.
  const outputTotal =
    totalTokens !== undefined && promptTokens !== undefined
      ? Math.max(completionTokens ?? 0, totalTokens - promptTokens)
      : completionTokens;
  return {
    inputTokens: {
      cacheRead,
      // The OpenAI usage shape carries no cache-write signal.
      cacheWrite: undefined,
      // A vendor that reports no cache-read detail at all (Google is one)
      // still knows its prompt total, and every one of those tokens was
      // uncached — reporting `undefined` there loses a number we have.
      noCache:
        promptTokens === undefined
          ? undefined
          : Math.max(0, promptTokens - (cacheRead ?? 0)),
      total: promptTokens
    },
    outputTokens: {
      reasoning: reasoningTokens,
      text: undefined,
      total: outputTotal
    },
    raw: usage as JSONObject
  };
}

function toolCallsFrom(
  raw: unknown,
  /** Message-level `extra_content`, when no text part could carry it. */
  messageExtra: unknown
): LanguageModelV4Content[] {
  const calls = array(raw) ?? [];
  const content: LanguageModelV4Content[] = [];
  for (const entry of calls) {
    const call = record(entry);
    if (call === undefined) continue;
    const fn = record(call.function);
    const name = text(fn?.name);
    if (name === undefined) continue;
    content.push({
      input: text(fn?.arguments) ?? "{}",
      toolCallId: text(call.id) ?? newId(),
      toolName: name,
      type: "tool-call",
      ...extraContentMetadata({
        // Only the first call carries the message-level signature, so a
        // replayed turn puts exactly one back.
        extraContent: content.length === 0 ? messageExtra : undefined,
        toolExtraContent: call.extra_content
      })
    });
  }
  return content;
}

/**
 * Parses a non-streaming response. The body is normalized to the strict
 * `chat.completion` shape first, so only `choices[0].message` is read.
 *
 * @experimental This surface is experimental and may change.
 */
export function parseOpenAIGeneration(
  json: unknown,
  modelId: string
): WireGeneration {
  const body = normalizeChatCompletion(json, modelId);
  const choice = record(array(body.choices)?.[0]);
  const message = record(choice?.message);
  const content: LanguageModelV4Content[] = [];

  const reasoning = text(message?.reasoning_content);
  if (reasoning !== undefined && reasoning !== "") {
    content.push({ text: reasoning, type: "reasoning" });
  }

  const answer = text(message?.content);
  const messageExtra = message?.extra_content;
  if (answer !== undefined && answer !== "") {
    content.push({
      text: answer,
      type: "text",
      ...extraContentMetadata({ extraContent: messageExtra })
    });
  }

  content.push(
    ...toolCallsFrom(
      message?.tool_calls,
      answer === undefined || answer === "" ? messageExtra : undefined
    )
  );

  const created = count(body.created);
  return {
    content,
    finishReason: mapFinishReason(choice?.finish_reason),
    responseId: text(body.id),
    responseModelId: text(body.model),
    timestamp: created === undefined ? undefined : new Date(created * 1000),
    usage: mapUsage(body.usage)
  };
}

interface ToolCallState {
  id: string;
  name: string;
  input: string;
  closed: boolean;
  /** This call's own `extra_content`, when the vendor signs each call. */
  extraContent: unknown;
}

/**
 * Streams strict OpenAI `chat.completion.chunk` events into AI SDK stream
 * parts. Tool calls arrive either as incremental `arguments` fragments closed
 * by a null-finalization chunk, or as one delta with the complete arguments
 * string; both are handled. Usage is read from whichever chunk carries it.
 *
 * @experimental This surface is experimental and may change.
 */
export function openAIStreamParser(): WireStreamParser {
  const toolCalls = new Map<number, ToolCallState>();
  let lastToolIndex: number | undefined;
  let textId: string | undefined;
  let reasoningId: string | undefined;
  let usage = emptyUsage();
  let finishReason: LanguageModelV4FinishReason | undefined;
  let sentMetadata = false;
  let receivedDone = false;
  let receivedEvent = false;
  /** Message-level `extra_content` (Gemini's thought signature). */
  let messageExtra: unknown;
  let messageExtraClaimed = false;
  let textEverOpened = false;

  type Controller = TransformStreamDefaultController<LanguageModelV4StreamPart>;

  /**
   * The message signature belongs on whichever part replays the message: the
   * text block when there is one, otherwise the first tool call.
   */
  const claimMessageExtra = (): unknown => {
    if (messageExtraClaimed) return undefined;
    messageExtraClaimed = true;
    return messageExtra;
  };

  const closeReasoning = (controller: Controller) => {
    if (reasoningId === undefined) return;
    controller.enqueue({ id: reasoningId, type: "reasoning-end" });
    reasoningId = undefined;
  };

  const closeText = (controller: Controller) => {
    if (textId === undefined) return;
    controller.enqueue({
      id: textId,
      type: "text-end",
      ...extraContentMetadata({ extraContent: claimMessageExtra() })
    });
    textId = undefined;
  };

  const closeToolCall = (index: number, controller: Controller) => {
    const state = toolCalls.get(index);
    if (state === undefined || state.closed) return;
    state.closed = true;
    controller.enqueue({ id: state.id, type: "tool-input-end" });
    controller.enqueue({
      input: state.input,
      toolCallId: state.id,
      toolName: state.name,
      type: "tool-call",
      ...extraContentMetadata({
        extraContent: textEverOpened ? undefined : claimMessageExtra(),
        toolExtraContent: state.extraContent
      })
    });
  };

  const emitToolDeltas = (raw: unknown, controller: Controller) => {
    const deltas = array(raw);
    if (deltas === undefined) return;
    for (const entry of deltas) {
      const call = record(entry);
      if (call === undefined) continue;
      const fn = record(call.function);
      const name = text(fn?.name);
      const input = text(fn?.arguments);
      const id = text(call.id);
      const rawIndex = count(call.index);

      // The null-finalization sentinel carries no id, no name, no arguments
      // and — crucially — no index, which is what tells it apart from an
      // ordinary empty argument fragment that some vLLM tool parsers emit
      // between real fragments.
      if (
        rawIndex === undefined &&
        id === undefined &&
        (name === undefined || name === "") &&
        (input === undefined || input === "")
      ) {
        if (lastToolIndex !== undefined)
          closeToolCall(lastToolIndex, controller);
        continue;
      }

      // Text and reasoning blocks close before a tool call opens, so the
      // stream never has two kinds of block open at once.
      closeReasoning(controller);
      closeText(controller);

      const index = rawIndex ?? lastToolIndex ?? 0;
      let state = toolCalls.get(index);
      // A fragment for an index that was already finalized cannot be reopened
      // without emitting a delta after its `tool-input-end`; drop it.
      if (state?.closed === true) continue;
      if (state === undefined) {
        if (lastToolIndex !== undefined && lastToolIndex !== index) {
          closeToolCall(lastToolIndex, controller);
        }
        state = {
          closed: false,
          extraContent: call.extra_content,
          id: id ?? newId(),
          input: "",
          name: name ?? ""
        };
        toolCalls.set(index, state);
        lastToolIndex = index;
        controller.enqueue({
          id: state.id,
          toolName: state.name,
          type: "tool-input-start"
        });
      } else {
        if (name !== undefined && state.name === "") state.name = name;
        state.extraContent ??= call.extra_content;
      }
      if (input !== undefined && input !== "") {
        state.input += input;
        controller.enqueue({
          delta: input,
          id: state.id,
          type: "tool-input-delta"
        });
      }
    }
  };

  return new TransformStream<string, LanguageModelV4StreamPart>({
    flush(controller) {
      for (const index of toolCalls.keys()) closeToolCall(index, controller);
      closeReasoning(controller);
      closeText(controller);
      if (finishReason === undefined) {
        finishReason =
          receivedEvent && !receivedDone
            ? { raw: "stream-truncated", unified: "error" }
            : defaultFinishReason();
      }
      controller.enqueue({ finishReason, type: "finish", usage });
    },
    transform(data, controller) {
      if (data === "") return;
      if (data === "[DONE]") {
        receivedDone = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        // A malformed event must not kill a stream that is otherwise fine.
        return;
      }
      const chunk = record(parsed);
      if (chunk === undefined) return;
      receivedEvent = true;

      // A 200 SSE stream can still carry an upstream failure (content policy,
      // a rate limit hit mid-generation) as an `error` payload and then close.
      // Surfacing it beats finishing with empty text and no diagnostic.
      const failure = record(chunk.error);
      if (failure !== undefined) {
        closeReasoning(controller);
        closeText(controller);
        controller.enqueue({ error: failure, type: "error" });
        finishReason = {
          raw: text(failure.type) ?? "error",
          unified: "error"
        };
        return;
      }

      if (!sentMetadata) {
        const created = count(chunk.created);
        const id = text(chunk.id);
        const modelId = text(chunk.model);
        if (id !== undefined || modelId !== undefined) {
          sentMetadata = true;
          controller.enqueue({
            id,
            modelId,
            timestamp:
              created === undefined ? undefined : new Date(created * 1000),
            type: "response-metadata"
          });
        }
      }

      if (record(chunk.usage) !== undefined) usage = mapUsage(chunk.usage);

      const choice = record(array(chunk.choices)?.[0]);
      const delta = record(choice?.delta);
      if (delta !== undefined) {
        messageExtra ??= record(delta.extra_content);
        const reasoning = text(delta.reasoning_content);
        if (reasoning !== undefined && reasoning !== "") {
          if (reasoningId === undefined) {
            reasoningId = newId();
            controller.enqueue({ id: reasoningId, type: "reasoning-start" });
          }
          controller.enqueue({
            delta: reasoning,
            id: reasoningId,
            type: "reasoning-delta"
          });
        }
        const content = text(delta.content);
        if (content !== undefined && content !== "") {
          closeReasoning(controller);
          if (textId === undefined) {
            textId = newId();
            textEverOpened = true;
            controller.enqueue({ id: textId, type: "text-start" });
          }
          controller.enqueue({
            delta: content,
            id: textId,
            type: "text-delta"
          });
        }
        emitToolDeltas(delta.tool_calls, controller);
      }

      if (text(choice?.finish_reason) !== undefined) {
        finishReason = mapFinishReason(choice?.finish_reason);
      }
    }
  });
}
