import { TraceAttribute } from "../genai/attributes";
import type { TraceAttributes } from "../tracing/tracer";

// Two payload attributes plus scalar metadata stay under workerd's 64 KiB cap.
const MAX_ATTRIBUTE_BYTES = 28 * 1024;
const PROTECTED_HEAD_MESSAGES = 2;

type GenAIMessagePart = Record<string, unknown>;
type GenAIInputMessage = {
  readonly name?: string;
  readonly parts: GenAIMessagePart[];
  readonly role: string;
};
type GenAIOutputMessage = GenAIInputMessage & {
  readonly finish_reason: string;
};

export function inputMessageAttributes(
  value: unknown,
  enabled: boolean
): TraceAttributes {
  if (!enabled || typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const messages = Array.isArray(record.prompt)
    ? record.prompt
    : Array.isArray(record.messages)
      ? record.messages
      : typeof record.prompt === "string"
        ? [{ role: "user", content: record.prompt }]
        : undefined;
  return {
    [TraceAttribute.GenAI.InputMessages]: serializeMessages(
      messages === undefined ? undefined : formatInputMessages(messages)
    )
  };
}

export function outputMessageAttributes(
  value: unknown,
  enabled: boolean
): TraceAttributes {
  if (!enabled || typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const parts = outputParts(record);
  const finishReason = readFinishReason(record);
  return outputMessageAttributesFrom(
    parts.length > 0 || finishReason !== undefined
      ? [outputMessage(parts, finishReason)]
      : undefined
  );
}

export function outputMessageAttributesFrom(
  messages: readonly unknown[] | undefined
): TraceAttributes {
  return {
    [TraceAttribute.GenAI.OutputMessages]: serializeMessages(messages)
  };
}

export function toolInputAttributes(
  value: unknown,
  enabled: boolean
): TraceAttributes {
  return enabled
    ? { [TraceAttribute.GenAI.ToolCallArguments]: serialize(value) }
    : {};
}

export function toolOutputAttributes(
  value: unknown,
  enabled: boolean
): TraceAttributes {
  return enabled
    ? { [TraceAttribute.GenAI.ToolCallResult]: serialize(value) }
    : {};
}

export function createStreamMessages(): {
  messages(finishReason?: string): unknown[] | undefined;
  observe(chunk: unknown): void;
} {
  let text = "";
  let reasoning = "";
  const toolParts: GenAIMessagePart[] = [];

  return {
    messages(finishReason) {
      const parts = [
        ...(reasoning
          ? [{ type: "reasoning", content: reasoning } as GenAIMessagePart]
          : []),
        ...(text ? [{ type: "text", content: text } as GenAIMessagePart] : []),
        ...toolParts
      ];
      return parts.length > 0 || finishReason !== undefined
        ? [outputMessage(parts, finishReason)]
        : undefined;
    },
    observe(chunk) {
      if (typeof chunk !== "object" || chunk === null) return;
      const record = chunk as Record<string, unknown>;
      const delta = record.text ?? record.delta;
      if (record.type === "text-delta" && typeof delta === "string") {
        text += delta;
      } else if (
        record.type === "reasoning-delta" &&
        typeof delta === "string"
      ) {
        reasoning += delta;
      } else if (record.type === "tool-call" || record.type === "tool-result") {
        const part = formatMessagePart(record);
        if (part !== undefined) toolParts.push(part);
      }
    }
  };
}

function formatInputMessages(
  messages: readonly unknown[]
): GenAIInputMessage[] {
  const formatted: GenAIInputMessage[] = [];
  for (const message of messages) {
    const next = formatInputMessage(message);
    if (next !== undefined) formatted.push(next);
  }
  return formatted;
}

function formatInputMessage(value: unknown): GenAIInputMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.role !== "string") return undefined;

  const rawParts = Array.isArray(record.parts)
    ? record.parts
    : Array.isArray(record.content)
      ? record.content
      : typeof record.content === "string"
        ? [record.content]
        : [];
  const parts = rawParts
    .map(formatMessagePart)
    .filter((part): part is GenAIMessagePart => part !== undefined);
  const name = typeof record.name === "string" ? record.name : undefined;

  return {
    role: record.role,
    parts,
    ...(name !== undefined ? { name } : {})
  };
}

function outputParts(record: Record<string, unknown>): GenAIMessagePart[] {
  if (Array.isArray(record.content)) {
    return record.content
      .map(formatMessagePart)
      .filter((part): part is GenAIMessagePart => part !== undefined);
  }

  const parts: GenAIMessagePart[] = [];
  appendReasoningParts(parts, record.reasoning);
  if (typeof record.text === "string" && record.text.length > 0) {
    parts.push({ type: "text", content: record.text });
  }
  if (Array.isArray(record.toolCalls)) {
    for (const toolCall of record.toolCalls) {
      const part = formatMessagePart(toolCall);
      if (part !== undefined) parts.push(part);
    }
  }
  return parts;
}

function appendReasoningParts(
  parts: GenAIMessagePart[],
  reasoning: unknown
): void {
  if (typeof reasoning === "string" && reasoning.length > 0) {
    parts.push({ type: "reasoning", content: reasoning });
    return;
  }
  if (!Array.isArray(reasoning)) return;

  for (const entry of reasoning) {
    if (typeof entry !== "object" || entry === null) continue;
    const text = (entry as Record<string, unknown>).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push({ type: "reasoning", content: text });
    }
  }
}

function formatMessagePart(value: unknown): GenAIMessagePart | undefined {
  if (typeof value === "string") {
    return { type: "text", content: value };
  }
  if (typeof value !== "object" || value === null) return undefined;

  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") return undefined;

  switch (record.type) {
    case "text":
    case "reasoning": {
      const content = record.content ?? record.text;
      return typeof content === "string"
        ? { type: record.type, content }
        : undefined;
    }
    case "tool-call":
    case "tool_call":
      return formatToolCall(record);
    case "tool-result":
    case "tool_result":
    case "tool_call_response":
      return formatToolCallResponse(record);
    default:
      // The OTel schema permits extensible generic parts. Keep their type but
      // do not leak AI SDK-native property names into known semantic parts.
      return { type: record.type.replaceAll("-", "_") };
  }
}

function formatToolCall(
  record: Record<string, unknown>
): GenAIMessagePart | undefined {
  const name = record.name ?? record.toolName;
  if (typeof name !== "string") return undefined;
  const id = record.id ?? record.toolCallId;
  const args = record.arguments ?? record.input;

  return {
    type: "tool_call",
    ...(typeof id === "string" ? { id } : {}),
    name,
    ...(args !== undefined ? { arguments: parseJson(args) } : {})
  };
}

function formatToolCallResponse(
  record: Record<string, unknown>
): GenAIMessagePart {
  const id = record.id ?? record.toolCallId;
  const rawResponse = record.response ?? record.output ?? record.result ?? null;

  return {
    type: "tool_call_response",
    ...(typeof id === "string" ? { id } : {}),
    response: toolResponse(rawResponse)
  };
}

function toolResponse(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "text":
    case "error-text":
    case "json":
    case "error-json":
    case "content":
      return record.value ?? null;
    case "execution-denied":
      return {
        denied: true,
        ...(typeof record.reason === "string" ? { reason: record.reason } : {})
      };
    default:
      return value;
  }
}

function outputMessage(
  parts: GenAIMessagePart[],
  finishReason: string | undefined
): GenAIOutputMessage {
  return {
    role: "assistant",
    parts,
    // AI SDK normally always reports this. Keep the schema valid if a custom
    // provider omits it rather than emitting an output message without the
    // required field.
    finish_reason: normalizeFinishReason(finishReason ?? "unknown")
  };
}

function readFinishReason(record: Record<string, unknown>): string | undefined {
  const value = record.finishReason ?? record.finish_reason;
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const unified = (value as Record<string, unknown>).unified;
  return typeof unified === "string" ? unified : undefined;
}

function normalizeFinishReason(value: string): string {
  switch (value) {
    case "content-filter":
      return "content_filter";
    case "tool-calls":
    case "tool_calls":
      return "tool_call";
    case "other":
    case "unknown":
      return "stop";
    default:
      return value;
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function serializeMessages(
  messages: readonly unknown[] | undefined
): string | undefined {
  if (messages === undefined) return undefined;

  const kept = [...messages];
  while (true) {
    const json = stringify(kept);
    if (json === undefined) return undefined;
    if (byteLength(json) <= MAX_ATTRIBUTE_BYTES) return json;
    if (kept.length <= PROTECTED_HEAD_MESSAGES) return undefined;
    kept.splice(PROTECTED_HEAD_MESSAGES, 1);
  }
}

function serialize(value: unknown): string | undefined {
  const json = stringify(value);
  return json !== undefined && byteLength(json) <= MAX_ATTRIBUTE_BYTES
    ? json
    : undefined;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
