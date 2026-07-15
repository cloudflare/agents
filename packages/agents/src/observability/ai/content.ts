import { TraceAttribute } from "../genai/attributes";
import type { TraceAttributes } from "../tracing/tracer";

// Two payload attributes plus scalar metadata stay under workerd's 64 KiB cap.
const MAX_ATTRIBUTE_BYTES = 28 * 1024;
const PROTECTED_HEAD_MESSAGES = 2;

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
      : undefined;
  return {
    [TraceAttribute.GenAI.InputMessages]: serializeMessages(messages)
  };
}

export function outputMessageAttributes(
  value: unknown,
  enabled: boolean
): TraceAttributes {
  if (!enabled || typeof value !== "object" || value === null) return {};
  const content = (value as Record<string, unknown>).content;
  return outputMessageAttributesFrom(
    Array.isArray(content) && content.length > 0
      ? [{ role: "assistant", content }]
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
  messages(): unknown[] | undefined;
  observe(chunk: unknown): void;
} {
  let text = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];

  return {
    messages() {
      const content = [
        ...(reasoning ? [{ type: "reasoning", text: reasoning }] : []),
        ...(text ? [{ type: "text", text }] : []),
        ...toolCalls
      ];
      return content.length > 0 ? [{ role: "assistant", content }] : undefined;
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
      } else if (record.type === "tool-call") {
        toolCalls.push(chunk);
      }
    }
  };
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
