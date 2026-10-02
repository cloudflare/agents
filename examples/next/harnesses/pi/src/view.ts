import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  EntryRecord,
  MessageChange
} from "@earendil-works/pi-durable";
import {
  projectEntries,
  projectEntry,
  projectMessage,
  type PiMessage,
  type PiMessagePart
} from "./transcript";

/** A tool call running now, with its streamed output. */
export type PiRunningTool = {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
};

/**
 * Everything a UI shows for one session, derived from pi's agent events by
 * `reduceView` on either side of the wire.
 */
export type PiSessionView = {
  readonly messages: readonly PiMessage[];
  /** The assistant message being streamed, or null. */
  readonly live: PiMessage | null;
  readonly running: boolean;
  readonly tools: readonly PiRunningTool[];
  /** Submissions queued in pi's inbox behind the running work. */
  readonly queued: number;
  /** Retry backoff pi is waiting out, if any. */
  readonly retry: { readonly at: number; readonly error: string } | null;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
  } | null;
  readonly error: string | null;
};

/**
 * Folds pi's agent events into what a UI shows. Pure, so the browser and
 * the tests run the same code: pi's events are the wire format, and this is
 * the only place that interprets them. App glue, not part of the harness.
 */
export const EMPTY_VIEW: PiSessionView = {
  messages: [],
  live: null,
  running: false,
  tools: [],
  queued: 0,
  retry: null,
  model: null,
  error: null
};

const LIVE_ID = "live";

function append(view: PiSessionView, entry: EntryRecord): PiSessionView {
  const message = projectEntry(entry);
  if (!message) return view;
  // A reset starts a new context; the snapshot shows only the active one.
  if (entry.kind === "pi.reset") return { ...view, messages: [message] };
  if (view.messages.some((known) => known.id === message.id)) return view;
  return { ...view, messages: [...view.messages, message] };
}

function blockPart(block: AssistantMessage["content"][number]): PiMessagePart {
  const [part] = projectMessage(
    {
      role: "assistant",
      content: [block],
      api: "",
      provider: "",
      model: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "stop",
      timestamp: 0
    } as AssistantMessage,
    LIVE_ID
  ).parts;
  return part;
}

function applyChanges(
  live: PiMessage | null,
  changes: readonly MessageChange[]
): PiMessage | null {
  let message = live;
  for (const change of changes) {
    if (change.type === "message") {
      message = projectMessage(change.message, LIVE_ID);
      continue;
    }
    if (!message) continue;
    const parts = [...message.parts];
    const previous = parts[change.contentIndex];
    switch (change.type) {
      case "text_start":
      case "thinking_start":
      case "toolcall_start":
      case "block":
        parts[change.contentIndex] = blockPart(change.block);
        break;
      case "text_delta":
        parts[change.contentIndex] = {
          type: "text",
          text: (previous?.type === "text" ? previous.text : "") + change.delta
        };
        break;
      case "thinking_delta":
        parts[change.contentIndex] = {
          type: "thinking",
          text:
            (previous?.type === "thinking" ? previous.text : "") + change.delta
        };
        break;
      case "toolcall_delta":
        // Partial argument JSON; the call renders once its block completes.
        break;
    }
    message = { ...message, parts };
  }
  return message;
}

export function reduceView(
  view: PiSessionView,
  event: AgentEvent
): PiSessionView {
  switch (event.type) {
    case "snapshot": {
      const partial = event.generation?.message;
      return {
        messages: projectEntries(event.entries),
        live: partial ? projectMessage(partial, LIVE_ID) : null,
        running: event.run !== undefined,
        tools: event.tools
          .filter((slot) => slot.status === "running")
          .map((slot) => ({
            callId: slot.callId,
            name: slot.name,
            output: slot.output ?? ""
          })),
        queued: event.inbox.length,
        retry: event.generation?.retry ?? null,
        model: event.agent.model ?? null,
        error: null
      };
    }
    case "run_start":
      return { ...view, running: true, error: null };
    case "run_end":
      return { ...view, running: false, live: null, tools: [], retry: null };
    case "message_start":
      return event.message.role === "assistant"
        ? { ...view, live: projectMessage(event.message, LIVE_ID) }
        : view;
    case "message_update":
      return { ...view, live: applyChanges(view.live, event.changes) };
    case "message_end": {
      const next = append(view, event.entry);
      return event.entry.model?.[0]?.role === "assistant"
        ? { ...next, live: null }
        : next;
    }
    case "entry_appended":
      return append(view, event.entry);
    case "tool_execution_start":
      return {
        ...view,
        tools: [
          ...view.tools.filter((tool) => tool.callId !== event.toolCallId),
          { callId: event.toolCallId, name: event.toolName, output: "" }
        ]
      };
    case "tool_execution_update": {
      const output = event.output;
      if (!output) return view;
      return {
        ...view,
        tools: view.tools.map((tool) => {
          if (tool.callId !== event.toolCallId) return tool;
          if ("set" in output) return { ...tool, output: output.set };
          return {
            ...tool,
            output:
              tool.output.slice(output.trimStart ?? 0) + (output.append ?? "")
          };
        })
      };
    }
    case "tool_execution_end":
      return {
        ...view,
        tools: view.tools.filter((tool) => tool.callId !== event.toolCallId)
      };
    case "inbox_update":
      return { ...view, queued: event.items.length };
    case "auto_retry_start":
      return { ...view, retry: { at: event.at, error: event.errorMessage } };
    case "auto_retry_end":
      return { ...view, retry: null };
    case "agent_changed":
      return { ...view, model: event.agent.model ?? null };
    case "task_failed":
      return { ...view, error: event.message };
    case "submission":
      return event.record.status === "unanswered" &&
        event.record.reason !== "aborted" &&
        event.record.reason !== "withdrawn"
        ? { ...view, error: `Not answered: ${event.record.reason}` }
        : view;
    default:
      return view;
  }
}

export function reduceEvents(
  view: PiSessionView,
  events: readonly AgentEvent[]
): PiSessionView {
  return events.reduce(reduceView, view);
}
