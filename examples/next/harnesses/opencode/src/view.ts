import type { OpenCodeEvent, OpenCodeModel } from "agents/harness/opencode";
import {
  projectMessages,
  type OpenCodeMessagePart,
  type OpenCodeTranscriptMessage
} from "./transcript";

/** A tool call running now, with its streamed output. */
export type OpenCodeRunningTool = {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
};

/**
 * Everything a UI shows for one session, derived from the harness's events
 * by `reduceView` on either side of the wire. The same shape as the Pi
 * example's view.
 */
export type OpenCodeSessionView = {
  readonly messages: readonly OpenCodeTranscriptMessage[];
  /** The assistant message being streamed, or null. */
  readonly live: OpenCodeTranscriptMessage | null;
  readonly running: boolean;
  readonly tools: readonly OpenCodeRunningTool[];
  /** Prompts queued in OpenCode's inbox behind the running turn. */
  readonly queued: number;
  /** Retry backoff OpenCode is waiting out, if any. */
  readonly retry: { readonly at: number; readonly error: string } | null;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
  } | null;
  readonly error: string | null;
};

/**
 * Folds the harness's events into what a UI shows. Pure, so the browser and
 * the tests run the same code. App glue, not part of the harness.
 */
export const EMPTY_VIEW: OpenCodeSessionView = {
  messages: [],
  live: null,
  running: false,
  tools: [],
  queued: 0,
  retry: null,
  model: null,
  error: null
};

function modelOf(model: OpenCodeModel | null): OpenCodeSessionView["model"] {
  return model ? { provider: model.providerID, modelId: model.id } : null;
}

/** Append a delta to the live message's last part of the same kind. */
function appendDelta(
  view: OpenCodeSessionView,
  messageId: string,
  type: "text" | "thinking",
  delta: string
): OpenCodeSessionView {
  // A delta for a message the transcript already has is late: live events
  // can trail the durable log that settled the turn.
  if (view.messages.some((message) => message.id === messageId)) return view;
  const live =
    view.live?.id === messageId
      ? view.live
      : {
          id: messageId,
          role: "assistant" as const,
          parts: [],
          timestamp: Date.now()
        };
  const parts = [...live.parts];
  const last = parts.at(-1);
  if (last?.type === type) {
    parts[parts.length - 1] = { type, text: last.text + delta };
  } else {
    parts.push({ type, text: delta });
  }
  return { ...view, live: { ...live, parts } };
}

function addPart(
  view: OpenCodeSessionView,
  part: OpenCodeMessagePart
): OpenCodeSessionView {
  if (!view.live) return view;
  return { ...view, live: { ...view.live, parts: [...view.live.parts, part] } };
}

export function reduceView(
  view: OpenCodeSessionView,
  event: OpenCodeEvent
): OpenCodeSessionView {
  switch (event.type) {
    case "snapshot": {
      const messages = projectMessages(event.messages);
      // Keep the message being streamed until the transcript has it.
      const live =
        event.running &&
        view.live &&
        !messages.some((message) => message.id === view.live?.id)
          ? view.live
          : null;
      return {
        ...view,
        messages,
        live,
        running: event.running,
        tools: event.running ? view.tools : [],
        queued: event.pending.filter((item) => item.status === "queued").length,
        model: modelOf(event.model)
      };
    }
    case "operation_start":
      return { ...view, running: true, error: null };
    case "operation_end":
      return {
        ...view,
        running: false,
        live: null,
        tools: [],
        retry: null,
        error:
          event.status === "failed" ||
          (event.status === "declined" && event.error?.code !== "aborted")
            ? `Not answered: ${event.error?.message ?? event.status}`
            : view.error
      };
    case "text_delta":
      return appendDelta(view, event.messageId, "text", event.delta);
    case "reasoning_delta":
      return appendDelta(view, event.messageId, "thinking", event.delta);
    case "message_end": {
      // A step that called tools ends before the next starts: keep it.
      const live = view.live;
      if (!live || live.id !== event.messageId) return view;
      return { ...view, messages: [...view.messages, live], live: null };
    }
    case "tool_start":
      return addPart(
        {
          ...view,
          tools: [
            ...view.tools.filter((tool) => tool.callId !== event.toolCallId),
            { callId: event.toolCallId, name: event.name, output: "" }
          ]
        },
        {
          type: "tool-call",
          id: event.toolCallId,
          name: event.name,
          arguments: event.input
        }
      );
    case "tool_end":
      return {
        ...view,
        tools: view.tools.filter((tool) => tool.callId !== event.toolCallId)
      };
    case "operation_wait":
      return {
        ...view,
        retry: { at: event.notBefore, error: `Waiting: ${event.reason}` }
      };
    case "fault":
      return { ...view, error: event.message };
    default:
      return view;
  }
}

export function reduceEvents(
  view: OpenCodeSessionView,
  events: readonly OpenCodeEvent[]
): OpenCodeSessionView {
  return events.reduce(reduceView, view);
}
