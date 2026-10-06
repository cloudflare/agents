/**
 * What a turn does next, read from durable state alone: the operation's
 * progress fields and its assistant message. The harness asks after every
 * step, and again after an eviction, so a turn picks up exactly where its
 * last durable write left it.
 */
import type { UIMessage } from "ai";

type UIPart = UIMessage["parts"][number];

/** A tool call part of a UI message. */
export type ToolCallPart = Extract<UIPart, { toolCallId: string }>;

/** The next thing a turn does. */
export type TurnAction =
  /** A model call was cut short; rebuild it from its stream. */
  | { readonly _tag: "recover-model" }
  | { readonly _tag: "call-model" }
  /** Run these server tool calls, then call the model again. */
  | { readonly _tag: "run-tools"; readonly calls: readonly ToolCallPart[] }
  /** A client tool result or an approval is needed before going on. */
  | { readonly _tag: "await-input" }
  | { readonly _tag: "end" };

/** The durable progress of a turn. */
export type TurnProgress = {
  readonly streamId: string | undefined;
  readonly pendingModel: boolean;
  readonly steps: number;
};

/** Whether a part is a tool call. */
export function isToolCallPart(part: UIPart): part is ToolCallPart {
  return (
    (part.type.startsWith("tool-") || part.type === "dynamic-tool") &&
    "toolCallId" in part
  );
}

/** The tool name a tool call part carries. */
export function toolNameOf(part: ToolCallPart): string {
  return part.type === "dynamic-tool"
    ? part.toolName
    : part.type.slice("tool-".length);
}

/** The parts of a message's last model step. */
export function lastStep(message: UIMessage): UIPart[] {
  let start = 0;
  message.parts.forEach((part, index) => {
    if (part.type === "step-start") start = index + 1;
  });
  return message.parts.slice(start);
}

/** Whether a tool call has its result, error or denial. */
export function isSettled(part: ToolCallPart): boolean {
  return (
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied"
  );
}

/**
 * Decide the turn's next action.
 *
 * @param progress - The operation's durable progress.
 * @param message - The turn's assistant message, once it has one.
 * @param isServerTool - Whether the harness runs a tool of this name.
 * @param maxSteps - Most model calls one operation makes.
 * @returns What to do next.
 */
export function nextAction(
  progress: TurnProgress,
  message: UIMessage | undefined,
  isServerTool: (name: string) => boolean,
  maxSteps: number
): TurnAction {
  if (progress.streamId !== undefined) return { _tag: "recover-model" };
  if (message === undefined) {
    return progress.pendingModel ? { _tag: "call-model" } : { _tag: "end" };
  }
  const runnable: ToolCallPart[] = [];
  let awaiting = false;
  for (const part of lastStep(message)) {
    if (!isToolCallPart(part) || isSettled(part) || part.providerExecuted) {
      continue;
    }
    const server = isServerTool(toolNameOf(part));
    switch (part.state) {
      case "input-available":
        if (server) runnable.push(part);
        else awaiting = true;
        break;
      case "approval-responded":
        if (server && part.approval.approved) runnable.push(part);
        else awaiting = true;
        break;
      case "approval-requested":
        awaiting = true;
        break;
      case "input-streaming":
        // Only an interrupted model call leaves one, and recovery drops it.
        break;
    }
  }
  if (runnable.length > 0) return { _tag: "run-tools", calls: runnable };
  if (awaiting) return { _tag: "await-input" };
  if (progress.pendingModel && progress.steps < maxSteps) {
    return { _tag: "call-model" };
  }
  return { _tag: "end" };
}

/** The text of a message's text parts. */
export function textOf(message: UIMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/**
 * The partial message an interrupted model call leaves, made safe to keep:
 * tool calls whose input never finished streaming are dropped, since the
 * model never committed to them.
 */
export function settledPartial(message: UIMessage): UIMessage {
  return {
    ...message,
    parts: message.parts.filter(
      (part) => !(isToolCallPart(part) && part.state === "input-streaming")
    )
  };
}

/** Whether a message has anything besides step markers. */
export function hasContent(message: UIMessage): boolean {
  return message.parts.some((part) => part.type !== "step-start");
}
