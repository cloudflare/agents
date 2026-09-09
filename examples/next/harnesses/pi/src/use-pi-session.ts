import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientMessage,
  ExtensionUiRequest,
  ExtensionUiResponse,
  MessageDelta,
  ServerMessage,
  SlashCommand,
  TranscriptEvent,
  TranscriptMessage,
  TranscriptPart,
  ToolInfo
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** A dialog waiting on the user: the four request methods that get answers. */
export type UiDialog = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

/** A transient message from an extension, a status slot, or a failed handler. */
export type Notice = {
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  /** The hook, event or extension that produced an error notice. */
  readonly source?: string;
};

/** One extension status slot, keyed by the extension's own key. */
export type StatusSlot = { readonly key: string; readonly text: string };

/** One extension widget: lines rendered above or below the editor. */
export type Widget = {
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: "aboveEditor" | "belowEditor";
};

export type PiSessionOptions = {
  /**
   * Answer extension dialogs headlessly. When set, dialogs never reach the
   * `dialog` state — this handler owns every answer.
   */
  readonly onExtensionUi?: (
    request: UiDialog
  ) => Promise<ExtensionUiResponse> | ExtensionUiResponse;
};

const DIALOG_METHODS = ["select", "confirm", "input", "editor"] as const;

function isDialog(request: ExtensionUiRequest): request is UiDialog {
  return (DIALOG_METHODS as readonly string[]).includes(request.method);
}

type State = {
  readonly status: ConnectionStatus;
  readonly messages: readonly TranscriptMessage[];
  /** The assistant message currently being streamed, or null when idle. */
  readonly live: TranscriptMessage | null;
  readonly running: boolean;
  readonly runningTools: readonly string[];
  readonly tools: readonly ToolInfo[];
  readonly error: string | undefined;
  /** Dialogs in arrival order; the head is the one on screen. */
  readonly dialogs: readonly UiDialog[];
  readonly commands: readonly SlashCommand[];
  readonly flags: Readonly<Record<string, boolean | string>>;
  readonly notices: readonly Notice[];
  readonly statuses: readonly StatusSlot[];
  readonly widgets: readonly Widget[];
  /** The last title an extension asked the client to show. */
  readonly title: string | undefined;
  /** Text an extension pushed into the editor; clear it once consumed. */
  readonly editorText: string | undefined;
};

const INITIAL_STATE: State = {
  status: "connecting",
  messages: [],
  live: null,
  running: false,
  runningTools: [],
  tools: [],
  error: undefined,
  dialogs: [],
  commands: [],
  flags: {},
  notices: [],
  statuses: [],
  widgets: [],
  title: undefined,
  editorText: undefined
};

const MAX_NOTICES = 4;

function withNotice(state: State, notice: Notice): State {
  return { ...state, notices: [...state.notices, notice].slice(-MAX_NOTICES) };
}

/** Apply one fire-and-forget UI update to the client's own view state. */
function applyView(state: State, request: ExtensionUiRequest): State {
  switch (request.method) {
    case "notify":
      return withNotice(state, {
        id: request.requestId,
        level: request.level ?? "info",
        message: request.message
      });
    case "set_status": {
      const rest = state.statuses.filter((slot) => slot.key !== request.key);
      return {
        ...state,
        statuses:
          request.text === undefined
            ? rest
            : [...rest, { key: request.key, text: request.text }]
      };
    }
    case "set_widget": {
      const rest = state.widgets.filter((widget) => widget.key !== request.key);
      return {
        ...state,
        widgets:
          request.lines === undefined
            ? rest
            : [
                ...rest,
                {
                  key: request.key,
                  lines: request.lines,
                  placement: request.placement ?? "aboveEditor"
                }
              ]
      };
    }
    case "set_title":
      return { ...state, title: request.title };
    case "set_editor_text":
      return { ...state, editorText: request.text };
    default:
      return state;
  }
}

function applyDelta(
  message: TranscriptMessage,
  delta: MessageDelta
): TranscriptMessage {
  if (delta.type === "start") return delta.message;
  const parts: TranscriptPart[] = [...message.parts];
  const previous = parts[delta.index];
  switch (delta.type) {
    case "text_start":
    case "text_end":
      parts[delta.index] = { type: "text", text: delta.text };
      break;
    case "text_delta":
      parts[delta.index] = {
        type: "text",
        text: (previous?.type === "text" ? previous.text : "") + delta.delta
      };
      break;
    case "thinking_start":
    case "thinking_end":
      parts[delta.index] = { type: "thinking", text: delta.text };
      break;
    case "thinking_delta":
      parts[delta.index] = {
        type: "thinking",
        text: (previous?.type === "thinking" ? previous.text : "") + delta.delta
      };
      break;
    case "toolcall_start":
    case "toolcall_end":
      parts[delta.index] = {
        type: "tool-call",
        id: delta.id,
        name: delta.name,
        arguments: delta.arguments
      };
      break;
    case "toolcall_checkpoint":
    case "toolcall_delta":
      // Partial tool-call JSON; the demo renders arguments once complete.
      break;
  }
  return { ...message, parts };
}

function reduce(state: State, event: TranscriptEvent): State {
  switch (event.type) {
    case "operation_start":
      return { ...state, running: true, error: undefined };
    case "operation_end":
      return {
        ...state,
        running: false,
        live: null,
        runningTools: [],
        ...(event.status === "failed" && event.error
          ? { error: event.error.message }
          : {})
      };
    case "message_start":
      return { ...state, live: event.message };
    case "message_delta":
      return state.live
        ? { ...state, live: applyDelta(state.live, event.delta) }
        : state;
    case "message":
      if (state.messages.some((known) => known.id === event.message.id)) {
        return state;
      }
      return {
        ...state,
        messages: [...state.messages, event.message],
        live:
          event.message.role === "assistant" && state.live ? null : state.live
      };
    case "tool_start":
      return {
        ...state,
        runningTools: [...state.runningTools, event.toolName]
      };
    case "tool_end": {
      const next = [...state.runningTools];
      const index = next.indexOf(event.toolName);
      if (index >= 0) next.splice(index, 1);
      return { ...state, runningTools: next };
    }
    case "fault":
      return { ...state, error: event.message };
    default:
      return state;
  }
}

/**
 * A live pi lane over the harness's WebSocket protocol, connected with
 * `useAgent`: a durable transcript plus a token-by-token streaming view of
 * the operation in flight. Replays from the server's own durable stream on
 * connect and on reconnect, so a refresh mid-turn resumes exactly where the
 * last chunk left off.
 */
export function usePiSession(
  session: string,
  lane = "main",
  options: PiSessionOptions = {}
) {
  const [state, setState] = useState<State>(INITIAL_STATE);
  /** Last chunk sequence seen per stream, so a resubscribe resumes exactly. */
  const lastSeq = useRef(new Map<string, number>());
  /** Dialog ids still owed an answer, so unmount can cancel every one. */
  const owed = useRef(new Set<string>());
  const handler = useRef(options.onExtensionUi);
  handler.current = options.onExtensionUi;

  const agent = useAgent({
    agent: "pi-agent",
    name: session,
    query: { lane },
    onOpen: () => {
      setState((current) => ({ ...current, status: "open" }));
      agent.send(
        JSON.stringify({
          type: "get_commands",
          id: crypto.randomUUID()
        } satisfies ClientMessage)
      );
    },
    onClose: () => setState((current) => ({ ...current, status: "closed" })),
    onMessage: (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case "snapshot":
          setState((current) => ({
            ...current,
            messages: message.snapshot.messages,
            running: message.snapshot.operation !== null,
            runningTools:
              message.snapshot.operation?.runningTools.map(
                (tool) => tool.toolName
              ) ?? [],
            live: message.snapshot.operation?.streaming ?? null,
            tools: message.snapshot.tools
          }));
          if (message.snapshot.stream && message.snapshot.stream.cursor > 0) {
            const resume: ClientMessage = {
              type: "subscribe",
              streamId: message.snapshot.stream.streamId,
              from: message.snapshot.stream.cursor
            };
            agent.send(JSON.stringify(resume));
          }
          return;
        case "stream_start":
          // A stream opened (or reopened after the server woke) on this lane:
          // subscribe from wherever this client last saw it.
          agent.send(
            JSON.stringify({
              type: "subscribe",
              streamId: message.streamId,
              from: lastSeq.current.get(message.streamId) ?? 0
            } satisfies ClientMessage)
          );
          return;
        case "events":
          lastSeq.current.set(message.streamId, message.lastSeq + 1);
          setState((current) =>
            message.events.reduce((next, event) => reduce(next, event), current)
          );
          // The durable transcript is authoritative at operation boundaries:
          // the user's prompt entry and the settled messages come from it.
          if (
            message.events.some(
              (event) =>
                event.type === "operation_start" ||
                event.type === "operation_end"
            )
          ) {
            agent.send(
              JSON.stringify({ type: "snapshot", id: crypto.randomUUID() })
            );
          }
          return;
        case "extension_ui_request": {
          const request = message.request;
          if (!isDialog(request)) {
            setState((current) => applyView(current, request));
            return;
          }
          owed.current.add(request.requestId);
          const answer = handler.current;
          if (!answer) {
            setState((current) => ({
              ...current,
              dialogs: [...current.dialogs, request]
            }));
            return;
          }
          void Promise.resolve(answer(request))
            .catch((): ExtensionUiResponse => ({ cancelled: true }))
            .then((response) => {
              owed.current.delete(request.requestId);
              agent.send(
                JSON.stringify({
                  type: "extension_ui_response",
                  requestId: request.requestId,
                  response
                } satisfies ClientMessage)
              );
            });
          return;
        }
        case "commands":
          setState((current) => ({ ...current, commands: message.commands }));
          return;
        case "flags":
          setState((current) => ({ ...current, flags: message.flags }));
          return;
        case "handler_error":
          setState((current) =>
            withNotice(current, {
              id: crypto.randomUUID(),
              level: "error",
              message: message.message,
              source: `${message.kind}: ${message.source}`
            })
          );
          return;
        case "error":
          // A host without the extension surface answers `unsupported: …`;
          // that is a missing feature, not a session error.
          if (message.message.startsWith("unsupported:")) return;
          setState((current) => ({ ...current, error: message.message }));
          return;
        default:
          return;
      }
    }
  });

  useEffect(() => {
    setState(INITIAL_STATE);
    lastSeq.current.clear();
    owed.current.clear();
  }, [session]);

  const send = useCallback(
    (message: ClientMessage) => {
      if (agent.readyState === WebSocket.OPEN) {
        agent.send(JSON.stringify(message));
      }
    },
    [agent]
  );

  const submit = useCallback(
    (prompt: string) =>
      send({
        type: "submit",
        id: crypto.randomUUID(),
        request: { kind: "prompt", prompt }
      }),
    [send]
  );

  const abort = useCallback(
    () => send({ type: "abort", id: crypto.randomUUID() }),
    [send]
  );

  const answerUi = useCallback(
    (requestId: string, response: ExtensionUiResponse) => {
      owed.current.delete(requestId);
      setState((current) => ({
        ...current,
        dialogs: current.dialogs.filter(
          (dialog) => dialog.requestId !== requestId
        )
      }));
      send({ type: "extension_ui_response", requestId, response });
    },
    [send]
  );

  const runCommand = useCallback(
    (name: string, args?: string) =>
      send({
        type: "command",
        id: crypto.randomUUID(),
        name,
        ...(args === undefined || args === "" ? {} : { args })
      }),
    [send]
  );

  const setFlag = useCallback(
    (name: string, value: boolean | string) =>
      send({ type: "set_flag", id: crypto.randomUUID(), name, value }),
    [send]
  );

  const refreshCommands = useCallback(
    () => send({ type: "get_commands", id: crypto.randomUUID() }),
    [send]
  );

  const dismissNotice = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      notices: current.notices.filter((notice) => notice.id !== id)
    }));
  }, []);

  const clearEditorText = useCallback(() => {
    setState((current) => ({ ...current, editorText: undefined }));
  }, []);

  // An extension is waiting on a dialog this client owns. Leaving without an
  // answer would hold a hook gate open until the harness's timeout, so cancel.
  useEffect(() => {
    const pending = owed.current;
    return () => {
      for (const requestId of pending) {
        if (agent.readyState !== WebSocket.OPEN) break;
        agent.send(
          JSON.stringify({
            type: "extension_ui_response",
            requestId,
            response: { cancelled: true }
          } satisfies ClientMessage)
        );
      }
      pending.clear();
    };
  }, [agent]);

  return {
    ...state,
    /** The dialog on screen, or null when nothing is waiting. */
    dialog: state.dialogs[0] ?? null,
    submit,
    abort,
    answerUi,
    runCommand,
    setFlag,
    refreshCommands,
    dismissNotice,
    clearEditorText
  };
}
