/**
 * Structured workflow turns. A workflow `step.prompt` turn that asks for an
 * output schema ends by calling a synthetic final-answer tool; its arguments
 * are the structured result.
 */

import type { UIMessage } from "ai";

/**
 * Reserved name for the synthetic tool a workflow `step.prompt` turn uses to
 * deliver its structured final answer. The agent runs a full multi-step,
 * tool-using turn and ends it by calling this tool with arguments matching the
 * requested schema — exactly the way a sub-agent returns a result.
 *
 * Why a tool instead of the AI SDK `output`/`response_format` path: streaming a
 * JSON Schema `response_format` is rejected by some providers (Workers AI
 * returns `AiError 5023: JSON Schema mode is not supported with stream mode`),
 * whereas plain tool-calling streams on every provider. Capturing the tool
 * call's INPUT as the result keeps Think's single streaming engine intact
 * (persistence, recovery, resumable streams) and works uniformly across
 * Workers AI, OpenAI, and Anthropic.
 *
 * The name is namespaced to avoid clashing with user tools; if a user tool
 * already uses it, the turn picks a suffixed variant (see `_handleTurn`).
 *
 * @internal
 */
export const THINK_FINAL_ANSWER_TOOL_NAME = "think_final_answer";

/**
 * Whether `name` is (or is a collision-suffixed variant of) the reserved
 * structured-output final-answer tool. Used to strip the internal tool's parts
 * from persisted assistant messages regardless of which per-turn name was used.
 *
 * @internal
 */
export function isThinkFinalAnswerToolName(name: string): boolean {
  return (
    name === THINK_FINAL_ANSWER_TOOL_NAME ||
    name.startsWith(`${THINK_FINAL_ANSWER_TOOL_NAME}_`)
  );
}

/**
 * Build the system-prompt instruction that tells the model to terminate a
 * structured workflow turn by calling the given final-answer tool.
 *
 * @internal
 */
export function thinkFinalAnswerInstruction(toolName: string): string {
  return (
    "When you have everything you need to answer, you MUST call the " +
    `\`${toolName}\` tool exactly once with arguments that match the required ` +
    "schema. Do not write the final answer as plain text — the " +
    `\`${toolName}\` tool call IS the answer and ends the task.`
  );
}

/**
 * `message` without the parts of the internal final-answer tool, which a
 * structured workflow turn uses as plumbing and never stores.
 *
 * @internal
 */
export function withoutFinalAnswerParts(message: UIMessage): UIMessage {
  const parts = message.parts.filter((part) => {
    const candidate = part as { type?: string; toolName?: string };
    if (
      typeof candidate.type === "string" &&
      candidate.type.startsWith("tool-") &&
      isThinkFinalAnswerToolName(candidate.type.slice("tool-".length))
    ) {
      return false;
    }
    if (
      candidate.type === "dynamic-tool" &&
      typeof candidate.toolName === "string" &&
      isThinkFinalAnswerToolName(candidate.toolName)
    ) {
      return false;
    }
    return true;
  });
  return parts.length === message.parts.length
    ? message
    : { ...message, parts };
}
