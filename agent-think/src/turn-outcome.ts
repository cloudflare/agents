export const AGENT_THINK_MAX_STEPS = 250;

export type TurnOutcomeReason =
  | "completed"
  | "max_steps"
  | "stream_error"
  | "aborted";

export interface ClassifiedTurnOutcome {
  outcome: "done" | "error";
  reason: TurnOutcomeReason;
  error?: string;
  steps: number;
  assistantChars: number;
  finalStepHasToolCall: boolean;
}

interface TurnResultLike {
  status: "completed" | "error" | "aborted";
  error?: string;
  message: {
    parts: ReadonlyArray<{ type: string; text?: unknown }>;
  };
}

export function classifyTurnOutcome(
  result: TurnResultLike,
  maxSteps: number
): ClassifiedTurnOutcome {
  let steps = 0;
  let assistantChars = 0;
  let finalStepHasToolCall = false;

  for (const part of result.message.parts) {
    if (part.type === "step-start") {
      steps += 1;
      finalStepHasToolCall = false;
    } else if (part.type === "text" && typeof part.text === "string") {
      assistantChars += part.text.length;
    } else if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      finalStepHasToolCall = true;
    }
  }

  const stats = { steps, assistantChars, finalStepHasToolCall };

  if (result.status === "error") {
    return {
      outcome: "error",
      reason: "stream_error",
      error: result.error ?? "Turn failed while streaming.",
      ...stats
    };
  }

  if (result.status === "aborted") {
    return {
      outcome: "error",
      reason: "aborted",
      error: "Turn was aborted before completion.",
      ...stats
    };
  }

  if (steps >= maxSteps && finalStepHasToolCall) {
    return {
      outcome: "error",
      reason: "max_steps",
      error:
        `Stopped at the ${maxSteps}-step safety limit after a tool call; ` +
        "no final response was produced. Inspect the final tool output before " +
        "retrying because side effects may have completed.",
      ...stats
    };
  }

  return { outcome: "done", reason: "completed", ...stats };
}
