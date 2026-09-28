import type { UIMessage } from "ai";

type Part = UIMessage["parts"][number];

/** A tool part as the AI SDK writes it into a UI message. */
export type ToolPart = {
  readonly type: string;
  readonly toolCallId: string;
  readonly state: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly errorText?: string;
  readonly toolName?: string;
  readonly approval?: {
    readonly id: string;
    readonly approved?: boolean;
    readonly reason?: string;
  };
  readonly [key: string]: unknown;
};

/** The part as a {@link ToolPart}, or undefined when it is not one. */
export function asToolPart(part: Part): ToolPart | undefined {
  if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") {
    return undefined;
  }
  const candidate = part as unknown as Partial<ToolPart>;
  return typeof candidate.toolCallId === "string" &&
    typeof candidate.state === "string"
    ? (candidate as ToolPart)
    : undefined;
}

export function isToolPart(part: Part): boolean {
  return asToolPart(part) !== undefined;
}

export function toolNameOf(part: ToolPart): string {
  return part.type === "dynamic-tool"
    ? (part.toolName ?? "")
    : part.type.slice("tool-".length);
}

/** Tool parts whose call has a result the model can read. */
const SETTLED = new Set(["output-available", "output-error", "output-denied"]);

/**
 * What a turn does next, read from its assistant message.
 *
 * - `model`: call the model (first step, or every tool call of the last
 *   step has a result).
 * - `finished`: the last model step made no tool calls.
 * - `await-approval` / `await-client`: park until someone answers.
 * - `run-tool` / `deny-tool` / `interrupted-input`: settle one tool part.
 */
export type NextAction =
  | { readonly kind: "model" }
  | { readonly kind: "finished" }
  | { readonly kind: "await-approval"; readonly part: ToolPart }
  | { readonly kind: "await-client"; readonly part: ToolPart }
  | { readonly kind: "run-tool"; readonly part: ToolPart }
  | { readonly kind: "deny-tool"; readonly part: ToolPart }
  | { readonly kind: "interrupted-input"; readonly part: ToolPart };

export function nextAction(
  message: UIMessage | undefined,
  hasExecute: (toolName: string) => boolean
): NextAction {
  if (!message) return { kind: "model" };

  for (const candidate of message.parts) {
    const part = asToolPart(candidate);
    if (!part || SETTLED.has(part.state)) continue;
    switch (part.state) {
      case "approval-requested":
        return { kind: "await-approval", part };
      case "approval-responded":
        return part.approval?.approved === false
          ? { kind: "deny-tool", part }
          : { kind: "run-tool", part };
      case "input-available":
        return hasExecute(toolNameOf(part))
          ? { kind: "run-tool", part }
          : { kind: "await-client", part };
      default:
        // `input-streaming`: the step that wrote it was cut off mid-call.
        return { kind: "interrupted-input", part };
    }
  }

  return lastStep(message).some(isToolPart)
    ? { kind: "model" }
    : { kind: "finished" };
}

/** The parts written by the message's most recent model step. */
export function lastStep(message: UIMessage): Part[] {
  const parts = message.parts;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index].type === "step-start") return parts.slice(index + 1);
  }
  return parts;
}

/** Tool parts that have no result yet. */
export function openToolParts(message: UIMessage): ToolPart[] {
  return message.parts
    .map(asToolPart)
    .filter((part): part is ToolPart => !!part && !SETTLED.has(part.state));
}

export function updateToolPart(
  message: UIMessage,
  toolCallId: string,
  update: (part: ToolPart) => ToolPart
): UIMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const tool = asToolPart(part);
      return tool?.toolCallId === toolCallId ? update(tool) : part;
    }) as UIMessage["parts"]
  };
}

export function findToolPart(
  message: UIMessage,
  toolCallId: string
): ToolPart | undefined {
  return message.parts
    .map(asToolPart)
    .find((part) => part?.toolCallId === toolCallId);
}
