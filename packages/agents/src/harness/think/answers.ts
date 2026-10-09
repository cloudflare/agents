import type { UIMessage } from "ai";
import type { InboundEvent } from "../../experimental/channels/protocol";

type UIPart = UIMessage["parts"][number];
type UIToolPart = Extract<UIPart, { toolCallId: string }>;

/** A tool result or approval response, as an inbound event carries it. */
export type ToolCallAnswer =
  | Pick<
      Extract<InboundEvent, { type: "tool-result" }>,
      "type" | "toolCallId" | "result"
    >
  | Pick<
      Extract<InboundEvent, { type: "approval-response" }>,
      "type" | "approvalId" | "approved" | "reason"
    >;

/**
 * Record a tool result or approval response on the tool call it answers.
 * Returns the updated message, or undefined when no call is waiting for it,
 * so the first answer wins.
 */
export function answerToolCall(
  messages: readonly UIMessage[],
  event: ToolCallAnswer
): UIMessage | undefined {
  for (const message of messages) {
    const index = message.parts.findIndex((part) => answers(part, event));
    if (index === -1) continue;
    const parts = [...message.parts];
    const part = parts[index] as UIToolPart;
    // SAFETY: the new state is set with exactly the fields it requires.
    parts[index] = (
      event.type === "approval-response"
        ? {
            ...part,
            // As the AI SDK records them: a rejection ends the call.
            state: event.approved ? "approval-responded" : "output-denied",
            approval: {
              id: event.approvalId,
              approved: event.approved,
              ...(event.reason !== undefined && { reason: event.reason })
            }
          }
        : event.type === "tool-result" && event.result.ok
          ? { ...part, state: "output-available", output: event.result.output }
          : {
              ...part,
              state: "output-error",
              errorText:
                event.type === "tool-result" && !event.result.ok
                  ? (event.result.errorText ?? "")
                  : ""
            }
    ) as UIPart;
    return { ...message, parts };
  }
  return undefined;
}

function answers(part: UIPart, event: ToolCallAnswer): boolean {
  if (!("toolCallId" in part)) return false;
  if (event.type === "tool-result") {
    return (
      part.toolCallId === event.toolCallId &&
      // An approved client tool is answered after its approval.
      (part.state === "input-available" || part.state === "approval-responded")
    );
  }
  return (
    event.type === "approval-response" &&
    part.state === "approval-requested" &&
    part.approval.id === event.approvalId
  );
}
