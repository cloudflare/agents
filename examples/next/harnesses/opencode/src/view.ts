import type { OpenCodeEvent, OpenCodeModel } from "agents/harness/opencode";
import {
  projectMessages,
  type OpenCodeMessagePart,
  type OpenCodeTranscriptMessage
} from "./transcript";

export type OpenCodeRunningTool = {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
};

export type OpenCodeSessionView = {
  readonly messages: readonly OpenCodeTranscriptMessage[];
  readonly live: OpenCodeTranscriptMessage | null;
  readonly running: boolean;
  readonly tools: readonly OpenCodeRunningTool[];
  readonly queued: number;
  readonly retry: { readonly at: number; readonly error: string } | null;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
  } | null;
  readonly error: string | null;
};

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

function appendDelta(
  view: OpenCodeSessionView,
  messageId: string,
  type: "text" | "thinking",
  delta: string
): OpenCodeSessionView {
  // The live stream can trail the durable log; never reopen a finalized
  // message because a late delta arrived.
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
