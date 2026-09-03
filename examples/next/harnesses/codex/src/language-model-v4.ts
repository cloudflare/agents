import type {
  LanguageModelV4,
  LanguageModelV4FunctionTool,
  LanguageModelV4Message,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCallPart,
  LanguageModelV4ToolResultPart
} from "@ai-sdk/provider";
import type {
  KernelAction,
  KernelEffectResult,
  KernelJson
} from "./kernel-types";

/** Run one Codex model action through an AI SDK LanguageModelV4. */
export async function completeCodexModel(
  model: LanguageModelV4,
  action: Extract<KernelAction, { type: "model" }>,
  abortSignal?: AbortSignal
): Promise<KernelEffectResult> {
  const request = parseResponsesRequest(action.request);
  const result = await model.doStream({
    abortSignal,
    prompt: responsesInputToPrompt(request.instructions, request.input),
    tools: responsesToolsToLanguageModelTools(request.tools),
    toolChoice: { type: "auto" },
    maxOutputTokens: 4096,
    temperature: 0
  });

  return consumeModelStream(result.stream, action.effect_id);
}

function parseResponsesRequest(value: KernelJson): {
  readonly instructions: string;
  readonly input: KernelJson[];
  readonly tools: KernelJson[];
} {
  if (!isRecord(value)) {
    throw new Error("Codex model action request must be an object");
  }
  const instructions = value.instructions;
  const input = value.input;
  const tools = value.tools;
  if (
    typeof instructions !== "string" ||
    !Array.isArray(input) ||
    !Array.isArray(tools)
  ) {
    throw new Error(
      "Codex model action request has an invalid Responses shape"
    );
  }
  return { instructions, input, tools };
}

function responsesInputToPrompt(
  instructions: string,
  input: KernelJson[]
): LanguageModelV4Message[] {
  const prompt: LanguageModelV4Message[] = [
    { role: "system", content: instructions }
  ];

  for (let index = 0; index < input.length; ) {
    const item = input[index];
    if (!isRecord(item) || typeof item.type !== "string") {
      index += 1;
      continue;
    }

    if (item.type === "function_call") {
      const calls: LanguageModelV4ToolCallPart[] = [];
      while (index < input.length) {
        const candidate = input[index];
        if (!isRecord(candidate) || candidate.type !== "function_call") break;
        const call = functionCallPart(candidate);
        if (call) calls.push(call);
        index += 1;
      }
      if (calls.length > 0) {
        prompt.push({ role: "assistant", content: calls });
      }
      continue;
    }

    if (item.type === "function_call_output") {
      const results: LanguageModelV4ToolResultPart[] = [];
      while (index < input.length) {
        const candidate = input[index];
        if (!isRecord(candidate) || candidate.type !== "function_call_output") {
          break;
        }
        const result = functionResultPart(candidate, input);
        if (result) results.push(result);
        index += 1;
      }
      if (results.length > 0) prompt.push({ role: "tool", content: results });
      continue;
    }

    if (item.type === "message") {
      const role = item.role;
      const text = contentText(item.content);
      if (role === "user") {
        prompt.push({ role: "user", content: [{ type: "text", text }] });
      } else if (role === "assistant") {
        prompt.push({
          role: "assistant",
          content: [{ type: "text", text }]
        });
      }
    }
    index += 1;
  }

  return prompt;
}

function functionCallPart(
  item: Record<string, unknown>
): LanguageModelV4ToolCallPart | undefined {
  const toolCallId = item.call_id;
  const toolName = item.name;
  const input = item.arguments;
  if (
    typeof toolCallId !== "string" ||
    typeof toolName !== "string" ||
    typeof input !== "string"
  ) {
    return undefined;
  }
  return { type: "tool-call", toolCallId, toolName, input: parseJson(input) };
}

function functionResultPart(
  item: Record<string, unknown>,
  input: KernelJson[]
): LanguageModelV4ToolResultPart | undefined {
  const toolCallId = item.call_id;
  if (typeof toolCallId !== "string") return undefined;
  const toolName = findToolName(input, toolCallId);
  if (!toolName) return undefined;
  return {
    type: "tool-result",
    toolCallId,
    toolName,
    output: { type: "text", value: modelText(item.output) }
  };
}

function findToolName(input: KernelJson[], toolCallId: string): string | null {
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index];
    if (
      isRecord(item) &&
      item.type === "function_call" &&
      item.call_id === toolCallId &&
      typeof item.name === "string"
    ) {
      return item.name;
    }
  }
  return null;
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

async function consumeModelStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  fallbackResponseId: string
): Promise<KernelEffectResult> {
  const blocks: StreamBlock[] = [];
  const blockIndexes = new Map<string, number>();
  let responseId = fallbackResponseId;
  let finish:
    | Extract<LanguageModelV4StreamPart, { type: "finish" }>
    | undefined;

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
        return modelFailure(blocks, responseId, errorMessage(part.error));
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
  }

  if (!finish) {
    return modelFailure(
      blocks,
      responseId,
      "LanguageModelV4 stream ended without finish"
    );
  }
  if (finish.finishReason.unified === "error") {
    return modelFailure(
      blocks,
      responseId,
      `LanguageModelV4 failed with ${finish.finishReason.raw ?? "unknown reason"}`
    );
  }
  if (
    finish.finishReason.unified === "length" ||
    finish.finishReason.unified === "content-filter"
  ) {
    return {
      type: "model",
      frames: [
        ...blocksToFrames(blocks),
        {
          type: "response.incomplete",
          response: {
            id: responseId,
            error: {
              message: `LanguageModelV4 stopped with ${finish.finishReason.unified}`
            }
          }
        }
      ]
    };
  }

  const frames = blocksToFrames(blocks);
  const toolCallCount = blocks.filter(
    (block) => block.type === "tool-call" && block.complete
  ).length;
  const hasText = blocks.some(
    (block) => block.type === "text" && block.value.trim().length > 0
  );
  if (toolCallCount === 0 && !hasText) {
    return modelFailure(
      blocks,
      responseId,
      "LanguageModelV4 returned neither text nor a tool call"
    );
  }

  frames.push({
    type: "response.completed",
    response: { id: responseId, end_turn: toolCallCount === 0 }
  });
  return { type: "model", frames };
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

function blocksToFrames(blocks: StreamBlock[]): KernelJson[] {
  const frames: KernelJson[] = [];
  // Text blocks are joined before trimming so whitespace at block boundaries
  // ("Hello " + "world") is preserved as one assistant message.
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
    if (block.type === "text") continue;
    if (!block.complete) continue;
    frames.push({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: block.input
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
  responseId: string,
  message: string
): KernelEffectResult {
  return {
    type: "model",
    frames: [
      ...blocksToFrames(blocks),
      {
        type: "response.failed",
        response: { id: responseId, error: { message } }
      }
    ]
  };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter(isRecord)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function modelText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
