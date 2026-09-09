import type {
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
  LanguageModelV4StreamPart
} from "@ai-sdk/provider";
import type { SessionMessage, SessionMessagePart } from "agents/sessions";
import type {
  KernelAction,
  KernelEffectResult,
  KernelJson
} from "./kernel-types";

/** Transcript access the model effect needs. */
export interface ModelTranscript {
  /** The conversation to send, oldest first, with compaction applied. */
  history(): Promise<SessionMessage[]>;
  /** Durably store the assistant message this round produced. */
  record(message: SessionMessage): Promise<void>;
}

/** A model round that produced no usable response; the Tasks step retries. */
export class ModelRoundError extends Error {
  override readonly name = "ModelRoundError";
}

/** Outcome of one model round: what the kernel gets and what was stored. */
export type ModelRound = {
  readonly result: KernelEffectResult;
  readonly messageId: string;
};

/**
 * Largest tool input or output sent to the model verbatim. Storage keeps
 * every byte; the prompt shows a marker for anything bigger so one large
 * file write cannot crowd the rest of the conversation out of the context
 * window. The model can page the content back with a ranged read.
 */
export const MAX_PROMPT_PART_BYTES = 64 * 1024;

/** Tool-call arguments as the kernel sees them: a pointer into Sessions. */
export type ToolArgumentPointer = { readonly $message: string };

/**
 * Run one Codex model action through an AI SDK LanguageModelV4.
 *
 * The prompt is built from the session transcript, not from the kernel, and
 * the assistant message is stored before the kernel sees the result. Tool
 * calls reach the kernel with a pointer to that message instead of their
 * arguments, so a call's payload never rides in a checkpoint, an event, or a
 * journaled step result.
 */
export async function completeCodexModel(
  model: LanguageModelV4,
  action: Extract<KernelAction, { type: "model" }>,
  messageId: string,
  transcript: ModelTranscript,
  abortSignal?: AbortSignal
): Promise<ModelRound> {
  const request = parseResponsesRequest(action.request);
  const result = await model.doStream({
    abortSignal,
    prompt: sessionMessagesToPrompt(
      request.instructions,
      await transcript.history()
    ),
    tools: responsesToolsToLanguageModelTools(request.tools),
    toolChoice: { type: "auto" },
    temperature: 0
  });
  const round = await consumeModelStream(result.stream, action.effect_id);
  if (round.failure !== undefined) {
    // Nothing is stored for a failed round, so a retry starts clean.
    throw new ModelRoundError(round.failure);
  }
  const message: SessionMessage = {
    id: messageId,
    role: "assistant",
    parts: round.parts,
    metadata: { responseId: round.responseId }
  };
  if (round.parts.length > 0) await transcript.record(message);
  return { result: round.result(messageId), messageId };
}

function parseResponsesRequest(value: KernelJson): {
  readonly instructions: string;
  readonly tools: KernelJson[];
} {
  if (!isRecord(value)) {
    throw new Error("Codex model action request must be an object");
  }
  const instructions = value.instructions;
  const tools = value.tools;
  if (typeof instructions !== "string" || !Array.isArray(tools)) {
    throw new Error(
      "Codex model action request has an invalid Responses shape"
    );
  }
  return { instructions, tools };
}

// ── Sessions → LanguageModelV4 prompt ──────────────────────────────────────

type AssistantPart = Extract<
  LanguageModelV4Message,
  { role: "assistant" }
>["content"][number];
type ToolResultPart = Extract<
  LanguageModelV4Message,
  { role: "tool" }
>["content"][number];

function toolName(part: SessionMessagePart): string {
  return part.toolName ?? part.type.replace(/^tool-/, "");
}

/**
 * Map stored session messages to the V4 prompt. User and assistant messages
 * map directly; a `tool` message becomes a tool-result message; anything
 * else, including compaction summaries, is folded into a system message.
 */
export function sessionMessagesToPrompt(
  instructions: string,
  messages: readonly SessionMessage[]
): LanguageModelV4Message[] {
  const prompt: LanguageModelV4Message[] = [
    { role: "system", content: instructions }
  ];
  for (const message of messages) {
    switch (message.role) {
      case "user": {
        const text = message.parts
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join("");
        prompt.push({ role: "user", content: [{ type: "text", text }] });
        break;
      }
      case "assistant": {
        const content: AssistantPart[] = [];
        for (const part of message.parts) {
          if (part.type === "text" && part.text) {
            content.push({ type: "text", text: part.text });
          } else if (part.type === "reasoning" && part.text) {
            content.push({ type: "reasoning", text: part.text });
          } else if (part.type.startsWith("tool-") && part.toolCallId) {
            content.push({
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: toolName(part),
              input: boundedForPrompt(part.input, "input")
            });
          }
        }
        if (content.length > 0) prompt.push({ role: "assistant", content });
        break;
      }
      case "tool": {
        const content: ToolResultPart[] = [];
        for (const part of message.parts) {
          if (!part.type.startsWith("tool-") || !part.toolCallId) continue;
          content.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: toolName(part),
            output: {
              type: "text",
              value: outputText(boundedForPrompt(part.output, "output"))
            }
          });
        }
        if (content.length > 0) prompt.push({ role: "tool", content });
        break;
      }
      default: {
        const text = message.parts
          .map((part) => part.text ?? "")
          .filter((text) => text.length > 0)
          .join("\n");
        if (text) prompt.push({ role: "system", content: text });
      }
    }
  }
  return prompt;
}

function boundedForPrompt(value: unknown, label: string): unknown {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = new TextEncoder().encode(serialized ?? "").byteLength;
  if (bytes <= MAX_PROMPT_PART_BYTES) return value;
  const path =
    isRecord(value) && typeof value.path === "string" ? value.path : undefined;
  return {
    elided: `${label} of ${bytes} bytes omitted from the context window`,
    ...(path === undefined
      ? {}
      : {
          path,
          hint: "use workspace_read with offset and max_bytes to page through it"
        })
  };
}

function outputText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function responsesToolsToLanguageModelTools(
  tools: KernelJson[]
): LanguageModelV4FunctionTool[] {
  const converted: LanguageModelV4FunctionTool[] = [];
  for (const tool of tools) {
    if (
      !isRecord(tool) ||
      tool.type !== "function" ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      !isRecord(tool.parameters)
    ) {
      continue;
    }
    converted.push({
      type: "function",
      name: tool.name,
      description: tool.description,
      // SAFETY: The Rust kernel emits JSON Schema objects copied from Codex
      // tool definitions. LanguageModelV4 accepts the same JSON Schema shape.
      inputSchema:
        tool.parameters as LanguageModelV4FunctionTool["inputSchema"],
      strict: tool.strict === true
    });
  }
  return converted;
}

// ── LanguageModelV4 stream → stored message + kernel frames ────────────────

type StreamBlock =
  | { readonly type: "text"; readonly id: string; value: string }
  | { readonly type: "reasoning"; readonly id: string; value: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      name: string;
      input: string;
      complete: boolean;
    };

type ConsumedStream = {
  readonly parts: SessionMessagePart[];
  readonly responseId: string;
  /** Set when the provider returned no usable response. */
  readonly failure?: string;
  result(messageId: string): KernelEffectResult;
};

async function consumeModelStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  fallbackResponseId: string
): Promise<ConsumedStream> {
  const blocks: StreamBlock[] = [];
  const blockIndexes = new Map<string, number>();
  let responseId = fallbackResponseId;
  let finish:
    | Extract<LanguageModelV4StreamPart, { type: "finish" }>
    | undefined;
  let streamError: string | undefined;

  for await (const part of stream) {
    switch (part.type) {
      case "response-metadata":
        if (part.id) responseId = part.id;
        break;
      case "reasoning-start":
        startTextBlock(blocks, blockIndexes, "reasoning", part.id);
        break;
      case "reasoning-delta":
        appendTextDelta(blocks, blockIndexes, "reasoning", part.id, part.delta);
        break;
      case "text-start":
        startTextBlock(blocks, blockIndexes, "text", part.id);
        break;
      case "text-delta":
        appendTextDelta(blocks, blockIndexes, "text", part.id, part.delta);
        break;
      case "tool-input-start":
        if (part.providerExecuted) {
          throw new Error(
            `CodexHarness does not support provider-executed tool ${JSON.stringify(part.toolName)}`
          );
        }
        startToolBlock(blocks, blockIndexes, part.id, part.toolName);
        break;
      case "tool-call": {
        if (part.providerExecuted) {
          throw new Error(
            `CodexHarness does not support provider-executed tool ${JSON.stringify(part.toolName)}`
          );
        }
        const block = startToolBlock(
          blocks,
          blockIndexes,
          part.toolCallId,
          part.toolName
        );
        block.name = part.toolName;
        block.input = part.input;
        block.complete = true;
        break;
      }
      case "finish":
        finish = part;
        break;
      case "error":
        streamError = errorMessage(part.error);
        break;
      case "custom":
      case "file":
      case "reasoning-file":
      case "source":
      case "tool-approval-request":
      case "tool-result":
        throw new Error(
          `CodexHarness does not support LanguageModelV4 stream part ${JSON.stringify(part.type)}`
        );
      case "raw":
      case "reasoning-end":
      case "stream-start":
      case "text-end":
      case "tool-input-delta":
      case "tool-input-end":
        break;
    }
    if (streamError !== undefined) break;
  }

  const parts = blocksToParts(blocks);
  const failure = (message: string) => (messageId: string) =>
    modelFailure(blocks, messageId, responseId, message);

  if (streamError !== undefined) {
    return {
      parts,
      responseId,
      failure: streamError,
      result: failure(streamError)
    };
  }
  if (!finish) {
    const message = "LanguageModelV4 stream ended without finish";
    return { parts, responseId, failure: message, result: failure(message) };
  }
  if (finish.finishReason.unified === "error") {
    const message = `LanguageModelV4 failed with ${finish.finishReason.raw ?? "unknown reason"}`;
    return { parts, responseId, failure: message, result: failure(message) };
  }
  if (
    finish.finishReason.unified === "length" ||
    finish.finishReason.unified === "content-filter"
  ) {
    const reason = finish.finishReason.unified;
    return {
      parts,
      responseId,
      result: (messageId) => ({
        type: "model",
        frames: [
          ...blocksToFrames(blocks, messageId),
          {
            type: "response.incomplete",
            response: {
              id: responseId,
              error: { message: `LanguageModelV4 stopped with ${reason}` }
            }
          }
        ]
      })
    };
  }

  const toolCallCount = blocks.filter(
    (block) => block.type === "tool-call" && block.complete
  ).length;
  const hasText = blocks.some(
    (block) => block.type === "text" && block.value.trim().length > 0
  );
  if (toolCallCount === 0 && !hasText) {
    const message = "LanguageModelV4 returned neither text nor a tool call";
    return { parts, responseId, failure: message, result: failure(message) };
  }
  return {
    parts,
    responseId,
    result: (messageId) => ({
      type: "model",
      frames: [
        ...blocksToFrames(blocks, messageId),
        {
          type: "response.completed",
          response: { id: responseId, end_turn: toolCallCount === 0 }
        }
      ]
    })
  };
}

function startTextBlock(
  blocks: StreamBlock[],
  indexes: Map<string, number>,
  type: "text" | "reasoning",
  id: string
): void {
  const key = `${type}:${id}`;
  if (indexes.has(key)) return;
  indexes.set(key, blocks.length);
  blocks.push({ type, id, value: "" });
}

function appendTextDelta(
  blocks: StreamBlock[],
  indexes: Map<string, number>,
  type: "text" | "reasoning",
  id: string,
  delta: string
): void {
  startTextBlock(blocks, indexes, type, id);
  const index = indexes.get(`${type}:${id}`);
  if (index === undefined) return;
  const block = blocks[index];
  if (!block || block.type !== type) {
    throw new Error(
      `LanguageModelV4 reused stream part id ${JSON.stringify(id)}`
    );
  }
  block.value += delta;
}

function startToolBlock(
  blocks: StreamBlock[],
  indexes: Map<string, number>,
  id: string,
  name: string
): Extract<StreamBlock, { type: "tool-call" }> {
  const key = `tool-call:${id}`;
  const existingIndex = indexes.get(key);
  if (existingIndex !== undefined) {
    const existing = blocks[existingIndex];
    if (existing?.type !== "tool-call") {
      throw new Error(
        `LanguageModelV4 reused tool call id ${JSON.stringify(id)}`
      );
    }
    return existing;
  }
  const block: Extract<StreamBlock, { type: "tool-call" }> = {
    type: "tool-call",
    id,
    name,
    input: "",
    complete: false
  };
  indexes.set(key, blocks.length);
  blocks.push(block);
  return block;
}

/** The stored assistant message: full text, reasoning, and tool inputs. */
function blocksToParts(blocks: StreamBlock[]): SessionMessagePart[] {
  const parts: SessionMessagePart[] = [];
  for (const block of blocks) {
    if (block.type === "reasoning") {
      if (block.value.length > 0) {
        parts.push({ type: "reasoning", text: block.value });
      }
    } else if (block.type === "text") {
      if (block.value.length > 0)
        parts.push({ type: "text", text: block.value });
    } else if (block.complete) {
      parts.push({
        type: `tool-${block.name}`,
        toolCallId: block.id,
        toolName: block.name,
        input: parseJson(block.input),
        state: "input-available"
      });
    }
  }
  return parts;
}

/**
 * The kernel's view of the same round. Text and reasoning ride as deltas so
 * the kernel can journal them as events; each tool call carries only a
 * pointer to the stored message, never its arguments.
 */
function blocksToFrames(
  blocks: StreamBlock[],
  messageId: string
): KernelJson[] {
  const frames: KernelJson[] = [];
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => block.value)
    .join("")
    .trim();
  for (const block of blocks) {
    if (block.type === "reasoning") {
      if (block.value.length > 0) {
        frames.push({
          type: "response.reasoning_summary_text.delta",
          delta: block.value
        });
      }
      continue;
    }
    if (block.type === "text" || !block.complete) continue;
    const pointer: ToolArgumentPointer = { $message: messageId };
    frames.push({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(pointer)
      }
    });
  }
  if (text.length > 0) {
    frames.push(
      { type: "response.output_text.delta", delta: text },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }]
        }
      }
    );
  }
  return frames;
}

function modelFailure(
  blocks: StreamBlock[],
  messageId: string,
  responseId: string,
  message: string
): KernelEffectResult {
  return {
    type: "model",
    frames: [
      ...blocksToFrames(blocks, messageId),
      {
        type: "response.failed",
        response: { id: responseId, error: { message } }
      }
    ]
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
