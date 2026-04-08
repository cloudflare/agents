import type { UIMessage } from "ai";
import type {
  Event as OpenCodeEvent,
  Part,
  ToolPart,
  Pty,
  SessionStatus,
  EventSessionError
} from "@opencode-ai/sdk/v2";
import type {
  OpenCodeRunOutput,
  FileChange,
  FileDiff,
  Diagnostic,
  ProcessInfo,
  Todo
} from "./types";

/**
 * Re-export the SDK's `Event` union as `OpenCodeSSEEvent` for external
 * consumers who need to type raw SSE payloads.
 */
export type OpenCodeSSEEvent = OpenCodeEvent;

/**
 * Local type for the dynamic-tool message parts we push into UIMessage.
 *
 * The AI SDK's UIMessage part union doesn't include all the fields we
 * need for dynamic-tool parts (toolName, toolCallId, output, errorText,
 * title).  Rather than casting to `any`, we define this interface and
 * push it via a widening cast to `UIMessage["parts"][number]`.
 *
 * Modelled as a discriminated union on `state` so each variant only
 * carries the fields that are meaningful for that lifecycle stage.
 */
type DynamicToolPart =
  | {
      type: "dynamic-tool";
      toolName: string;
      toolCallId: string;
      state: "input-available";
      input: Record<string, unknown>;
      title?: string;
    }
  | {
      type: "dynamic-tool";
      toolName: string;
      toolCallId: string;
      state: "output-available";
      input: Record<string, unknown>;
      output: unknown;
      title?: string;
    }
  | {
      type: "dynamic-tool";
      toolName: string;
      toolCallId: string;
      state: "output-error";
      input: Record<string, unknown>;
      errorText: string;
      title?: string;
    };

/**
 * Translates OpenCode SSE events into AI SDK `UIMessage[]` state.
 *
 * Maintains a mutable messages array that grows as events arrive.
 * Call `processEvent()` for each SSE event, then `getSnapshot()` to
 * get a deep-copied `OpenCodeRunOutput` suitable for yielding.
 *
 * Handles the full set of OpenCode event types defined in the SDK's
 * `Event` union, including:
 *
 *   message.part.updated   — tool calls, text, reasoning parts
 *   message.part.delta     — incremental text deltas (streaming)
 *   message.part.removed   — parts removed (compaction)
 *   message.updated        — full message updates (errors)
 *   message.removed        — messages pruned
 *   session.idle           — run completed
 *   session.status         — idle / busy / retry status changes
 *   session.error          — typed error union from the SDK
 *   session.compacted      — session was compacted (info only)
 *   session.diff           — file-level diffs at end of run
 *   permission.asked       — permission request (surfaced as error)
 *   question.asked         — interactive question (surfaced as error)
 *   file.edited            — file explicitly edited by the agent
 *   file.watcher.updated   — inotify file change
 *   lsp.client.diagnostics — LSP diagnostics
 *   pty.created            — shell process spawned
 *   pty.updated            — shell process info updated
 *   pty.exited             — shell process exited
 *   pty.deleted            — shell process removed
 *   todo.updated           — todo list updated
 *
 * Events not relevant to the sub-conversation (tui.*, project.*,
 * installation.*, server.*, mcp.*, vcs.*, workspace.*, worktree.*)
 * are silently ignored.
 */
export class OpenCodeStreamAccumulator {
  private messages: UIMessage[] = [];
  private sessionId: string;
  private _status: "working" | "complete" | "error" = "working";
  private _error: string | null = null;
  private _responseText = "";
  private _reasoningText = "";
  /** Track whether state changed since last snapshot. */
  private _dirty = false;

  /** Map from SSE partID to the part type it belongs to. */
  private _partTypes = new Map<string, "text" | "reasoning">();

  /** Counter for generating unique IDs within this accumulator. */
  private _idCounter = 0;

  /** Map from OpenCode tool identifier to the toolCallId we assigned. */
  private _toolCallIds = new Map<string, string>();

  /** Files explicitly edited by the agent (from file.edited events). */
  private _filesEdited: string[] = [];

  /** File system changes observed (from file.watcher.updated events). */
  private _fileChanges: FileChange[] = [];

  /** Session diffs (from session.diff events). */
  private _diffs: FileDiff[] = [];

  /** LSP diagnostics (from lsp.client.diagnostics events). */
  private _diagnostics: Diagnostic[] = [];

  /** Shell processes spawned by the agent (from pty.* events). */
  private _processes = new Map<string, ProcessInfo>();

  /** Todos tracked by the agent (from todo.updated events). */
  private _todos: Todo[] = [];

  /** Model ID used by the agent (from message.updated events). */
  private _modelID: string | null = null;

  /**
   * Whether non-text parts have been appended since the last text
   * update.  When true, the next text update starts a fresh text part
   * at the end of the parts array instead of overwriting the existing
   * one, preserving chronological interleaving of text and tool calls.
   */
  private _toolPartsSinceText = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Inject a user message representing the prompt sent to the opencode
   * agent. Call this before processing SSE events so the sub-conversation
   * shows the prompt that kicked off the run.
   */
  addUserPrompt(prompt: string): void {
    this.messages.push({
      id: this.nextId("msg"),
      role: "user",
      parts: [{ type: "text", text: prompt }]
    });
    this._dirty = true;
  }

  get status(): "working" | "complete" | "error" {
    return this._status;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  /** Generate a unique ID for message parts. */
  private nextId(prefix = "oc"): string {
    return `${prefix}-${this.sessionId.slice(0, 8)}-${++this._idCounter}`;
  }

  /** Get or create the current assistant message. */
  private currentMessage(): UIMessage {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === "assistant") return last;
    const msg: UIMessage = {
      id: this.nextId("msg"),
      role: "assistant",
      parts: []
    };
    this.messages.push(msg);
    return msg;
  }

  /**
   * Push a DynamicToolPart into a UIMessage's parts array.
   * Uses a widening cast since DynamicToolPart isn't in the AI SDK's
   * UIMessage part union.
   */
  private pushDynamicPart(msg: UIMessage, part: DynamicToolPart): void {
    msg.parts.push(part as unknown as UIMessage["parts"][number]);
  }

  /**
   * Find an existing tool part by toolCallId, or undefined.
   */
  private findToolPart(
    msg: UIMessage,
    toolCallId: string
  ):
    | (Extract<UIMessage["parts"][number], { type: "dynamic-tool" }> & {
        toolCallId: string;
      })
    | undefined {
    return msg.parts.find(
      (p) =>
        p.type === "dynamic-tool" &&
        "toolCallId" in p &&
        p.toolCallId === toolCallId
    ) as
      | (Extract<UIMessage["parts"][number], { type: "dynamic-tool" }> & {
          toolCallId: string;
        })
      | undefined;
  }

  /**
   * Replace an existing dynamic-tool part in-place by splicing in a new
   * DynamicToolPart. Avoids unsafe mutation through `Record<string, unknown>` casts.
   */
  private replaceDynamicPart(
    msg: UIMessage,
    toolCallId: string,
    replacement: DynamicToolPart
  ): boolean {
    const idx = msg.parts.findIndex(
      (p) =>
        p.type === "dynamic-tool" &&
        "toolCallId" in p &&
        p.toolCallId === toolCallId
    );
    if (idx < 0) return false;
    msg.parts[idx] = replacement as unknown as UIMessage["parts"][number];
    return true;
  }

  /**
   * Get or create a stable toolCallId for an OpenCode tool invocation.
   * Uses the SDK's `callID` as a stable key so that pending → running →
   * completed events for the same invocation always resolve to the same ID.
   */
  private getToolCallId(toolName: string, callID: string): string {
    const key = `${toolName}:${callID}`;
    let id = this._toolCallIds.get(key);
    if (!id) {
      id = this.nextId("tool");
      this._toolCallIds.set(key, id);
    }
    return id;
  }

  /**
   * Process a single OpenCode SSE event and update internal state.
   * Accepts the SDK's `Event` union type directly.
   * Returns true if the event caused a state change (dirty).
   */
  processEvent(ev: {
    type: string;
    properties?: Record<string, unknown>;
  }): boolean {
    switch (ev.type) {
      case "message.part.updated":
        return this.handlePartUpdated(ev.properties);

      case "message.part.delta":
        return this.handlePartDelta(ev.properties);

      case "message.part.removed":
        return this.handlePartRemoved(ev.properties);

      case "message.updated":
        return this.handleMessageUpdated(ev.properties);

      case "message.removed":
        return this.handleMessageRemoved(ev.properties);

      case "session.idle": {
        const idleSessionId = (ev.properties as { sessionID?: string })
          ?.sessionID;
        if (idleSessionId === this.sessionId) {
          this._status = "complete";
          this._dirty = true;
          return true;
        }
        return false;
      }

      case "session.status":
        return this.handleSessionStatus(ev.properties);

      case "session.error":
        return this.handleSessionError(ev.properties);

      case "session.compacted": {
        // Session was compacted — messages may have been pruned.
        // We don't need to act on this since we maintain our own
        // message array, but mark dirty in case the UI wants to know.
        const compactedSessionId = (ev.properties as { sessionID?: string })
          ?.sessionID;
        if (compactedSessionId === this.sessionId) {
          this._dirty = true;
          return true;
        }
        return false;
      }

      case "session.diff":
        return this.handleSessionDiff(ev.properties);

      case "permission.asked":
        return this.handlePermissionAsked(ev.properties);

      case "question.asked":
        return this.handleQuestionAsked(ev.properties);

      case "file.edited":
        return this.handleFileEdited(ev.properties);

      case "file.watcher.updated":
        return this.handleFileWatcherUpdated(ev.properties);

      case "lsp.client.diagnostics":
        return this.handleLspDiagnostics(ev.properties);

      case "pty.created":
        return this.handlePtyCreated(ev.properties);

      case "pty.updated":
        return this.handlePtyUpdated(ev.properties);

      case "pty.exited":
        return this.handlePtyExited(ev.properties);

      case "pty.deleted":
        return this.handlePtyDeleted(ev.properties);

      case "todo.updated":
        return this.handleTodoUpdated(ev.properties);

      default:
        // Silently ignore events we don't care about:
        // tui.*, project.*, installation.*, server.*, mcp.*,
        // vcs.*, workspace.*, worktree.*, lsp.updated, etc.
        return false;
    }
  }

  private handlePartUpdated(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const part = properties.part as Part | undefined;
    if (!part) return false;

    if (part.sessionID && part.sessionID !== this.sessionId) return false;
    // Register the part's type so handlePartDelta can route deltas
    // to the correct handler based on partID.
    const partId = (part as { id?: string }).id;
    if (partId && (part.type === "text" || part.type === "reasoning")) {
      this._partTypes.set(partId, part.type);
    }

    if (part.type === "text" && "text" in part) {
      return this.handleTextPart(part.text);
    }

    if (part.type === "reasoning" && "text" in part) {
      return this.handleReasoningPart(part.text);
    }

    if (part.type === "tool" && "state" in part) {
      return this.handleToolPart(part as ToolPart);
    }

    return false;
  }

  /**
   * Handle incremental deltas from `message.part.delta` events.
   * Routes to the correct handler based on the partID → type mapping
   * registered in handlePartUpdated.
   */
  private handlePartDelta(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { sessionID, partID, field, delta } = properties as {
      sessionID?: string;
      partID?: string;
      field?: string;
      delta?: string;
    };
    if (sessionID && sessionID !== this.sessionId) return false;
    if (field !== "text" || typeof delta !== "string") return false;

    // Check whether this delta belongs to a reasoning part.
    const partType = partID ? this._partTypes.get(partID) : undefined;

    if (partType === "reasoning") {
      this._reasoningText += delta;
      const msg = this.currentMessage();
      const existing = msg.parts.find((p) => p.type === "reasoning");
      if (existing && existing.type === "reasoning") {
        existing.text = this._reasoningText;
      } else {
        msg.parts.push({ type: "reasoning", text: this._reasoningText });
      }
      this._dirty = true;
      return true;
    }

    // Default: treat as text delta.
    this._responseText += delta;
    const msg = this.currentMessage();

    // Find the last text part.
    let lastTextIdx = -1;
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      if (msg.parts[i].type === "text") {
        lastTextIdx = i;
        break;
      }
    }

    if (lastTextIdx >= 0 && !this._toolPartsSinceText) {
      const existing = msg.parts[lastTextIdx];
      if (existing.type === "text") {
        existing.text = this._responseText;
      }
    } else {
      // Starting a new text segment after tool parts — reset the
      // running delta so the new part only contains fresh text.
      this._responseText = delta;
      msg.parts.push({ type: "text", text: this._responseText });
      this._toolPartsSinceText = false;
    }

    this._dirty = true;
    return true;
  }

  /**
   * Handle `message.part.removed` — a part was pruned (e.g. during
   * compaction). We remove the corresponding part from our messages.
   */
  private handlePartRemoved(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { sessionID, messageID, partID } = properties as {
      sessionID?: string;
      messageID?: string;
      partID?: string;
    };
    if (sessionID && sessionID !== this.sessionId) return false;
    if (!messageID || !partID) return false;

    const msg = this.messages.find((m) => m.id === messageID);
    if (!msg) return false;

    const idx = msg.parts.findIndex(
      (p) => "id" in p && (p as Record<string, unknown>).id === partID
    );
    if (idx >= 0) {
      msg.parts.splice(idx, 1);
      this._dirty = true;
      return true;
    }
    return false;
  }

  /**
   * Handle `message.removed` — an entire message was pruned.
   */
  private handleMessageRemoved(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { sessionID, messageID } = properties as {
      sessionID?: string;
      messageID?: string;
    };
    if (sessionID && sessionID !== this.sessionId) return false;
    if (!messageID) return false;

    const idx = this.messages.findIndex((m) => m.id === messageID);
    if (idx >= 0) {
      this.messages.splice(idx, 1);
      this._dirty = true;
      return true;
    }
    return false;
  }

  /**
   * Handle `session.status` — tracks idle/busy/retry state.
   * A `retry` status with an error message is surfaced to the user.
   */
  private handleSessionStatus(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { sessionID, status } = properties as {
      sessionID?: string;
      status?: SessionStatus;
    };
    if (sessionID !== this.sessionId || !status) return false;

    if (status.type === "idle") {
      this._status = "complete";
      this._dirty = true;
      return true;
    }

    if (status.type === "retry") {
      const msg = this.currentMessage();
      msg.parts.push({
        type: "text",
        text: `⏳ Retrying (attempt ${status.attempt}): ${status.message}`
      });
      this._dirty = true;
      return true;
    }

    return false;
  }

  /**
   * Handle `session.error` — the SDK provides a typed error union:
   * ProviderAuthError | UnknownError | MessageOutputLengthError |
   * MessageAbortedError | StructuredOutputError | ContextOverflowError |
   * ApiError
   */
  private handleSessionError(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { sessionID, error } = properties as {
      sessionID?: string;
      error?: EventSessionError["properties"]["error"];
    };
    if (sessionID && sessionID !== this.sessionId) return false;

    if (error) {
      const errorName = error.name;
      const errorData = error.data;
      const message =
        "message" in errorData
          ? (errorData as { message: string }).message
          : `${errorName}`;
      this._error = `${errorName}: ${message}`;
    } else {
      this._error = "Session error";
    }

    this._status = "error";
    this._dirty = true;

    const msg = this.currentMessage();
    msg.parts.push({ type: "text", text: `⚠️ ${this._error}` });
    return true;
  }

  private handleTextPart(text: string): boolean {
    this._responseText = text;
    const msg = this.currentMessage();

    // Find the last text part in the message.
    let lastTextIdx = -1;
    for (let i = msg.parts.length - 1; i >= 0; i--) {
      if (msg.parts[i].type === "text") {
        lastTextIdx = i;
        break;
      }
    }

    if (lastTextIdx >= 0 && !this._toolPartsSinceText) {
      // No tool parts were added since the last text update — overwrite
      // the existing text part in place (streaming the same step).
      const existing = msg.parts[lastTextIdx];
      if (existing.type === "text") {
        existing.text = text;
      }
    } else {
      // Either there's no text part yet, or tool parts were added since
      // the last text update.  Append a new text part so the rendering
      // interleaves text and tool calls chronologically.
      msg.parts.push({ type: "text", text });
    }

    this._toolPartsSinceText = false;
    this._dirty = true;
    return true;
  }

  /**
   * Handle a reasoning/thinking part from the sub-agent.
   * Rendered as a collapsible "Thinking" block in the UI.
   */
  private handleReasoningPart(text: string): boolean {
    // Reset the delta accumulator — the full text from
    // message.part.updated supersedes any prior deltas.
    this._reasoningText = text;
    const msg = this.currentMessage();

    // Find the last reasoning part and update it in place.
    const existing = msg.parts.find((p) => p.type === "reasoning");
    if (existing && existing.type === "reasoning") {
      existing.text = text;
    } else {
      msg.parts.push({ type: "reasoning", text });
    }

    this._dirty = true;
    return true;
  }

  private handleToolPart(part: ToolPart): boolean {
    const toolName = part.tool;
    const state = part.state;
    const msg = this.currentMessage();

    // Use the SDK's stable callID to track each tool invocation.
    // Previously we derived an ID from the count of existing parts with
    // the same tool name, but that counter drifted whenever a completed
    // part's entry was removed from the map, causing every subsequent
    // event for the *same* invocation to mint a fresh ID and push a
    // duplicate "running" card.
    const toolCallId = this.getToolCallId(toolName, part.callID);
    const existingPart = this.findToolPart(msg, toolCallId);

    if (state.status === "pending" || state.status === "running") {
      if (!existingPart) {
        const title = "title" in state ? state.title : undefined;
        this.pushDynamicPart(msg, {
          type: "dynamic-tool",
          toolName,
          toolCallId,
          state: "input-available",
          input: state.input ?? {},
          title
        });
        this._toolPartsSinceText = true;
      }
      this._dirty = true;
      return true;
    }

    if (state.status === "completed") {
      if (existingPart) {
        this.replaceDynamicPart(msg, toolCallId, {
          type: "dynamic-tool",
          toolName,
          toolCallId,
          state: "output-available",
          input: state.input ?? {},
          output: state.output ?? state.title ?? "Done",
          title: state.title
        });
      } else {
        this.pushDynamicPart(msg, {
          type: "dynamic-tool",
          toolName,
          toolCallId,
          state: "output-available",
          input: state.input ?? {},
          output: state.output ?? state.title ?? "Done",
          title: state.title
        });
        this._toolPartsSinceText = true;
      }
      this._toolCallIds.delete(`${toolName}:${part.callID}`);
      this._dirty = true;
      return true;
    }

    if (state.status === "error") {
      if (existingPart) {
        this.replaceDynamicPart(msg, toolCallId, {
          type: "dynamic-tool",
          toolName,
          toolCallId,
          state: "output-error",
          input: state.input ?? {},
          errorText: state.error ?? `${toolName} failed`
        });
      } else {
        this.pushDynamicPart(msg, {
          type: "dynamic-tool",
          toolName,
          toolCallId,
          state: "output-error",
          input: state.input ?? {},
          errorText: state.error ?? `${toolName} failed`,
          title: undefined
        });
        this._toolPartsSinceText = true;
      }
      this._dirty = true;
      return true;
    }

    return false;
  }

  private handleMessageUpdated(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;

    // The SDK's EventMessageUpdated has { sessionID, info: Message }
    // where Message (AssistantMessage) may have an error field.
    const info = properties.info as
      | {
          role?: string;
          modelID?: string;
          error?: {
            name: string;
            data: { message?: string; statusCode?: number };
          };
        }
      | undefined;

    // Extract modelID from assistant messages
    if (info?.role === "assistant" && info.modelID) {
      this._modelID = info.modelID;
      this._dirty = true;
    }

    if (info?.error) {
      const statusCode = info.error.data?.statusCode ?? "unknown";
      const errorText =
        info.error.data?.message ?? info.error.name ?? "Unknown provider error";
      this._error = `OpenCode provider error (${statusCode}): ${errorText}`;

      const msg = this.currentMessage();
      msg.parts.push({
        type: "text",
        text: `⚠️ ${this._error}`
      });

      this._dirty = true;
      return true;
    }
    return this._dirty;
  }

  private handlePermissionAsked(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    // SDK type: EventPermissionAsked → PermissionRequest
    const { permission, metadata } = properties as {
      permission?: string;
      metadata?: Record<string, unknown>;
    };
    const tool = permission ?? "unknown";
    const input = metadata ? JSON.stringify(metadata) : "";
    this._error = `Permission requested for "${tool}" (input: ${input}). This should not happen — check that permission is set to "allow" in the OpenCode config.`;
    this._status = "error";
    this._dirty = true;

    const msg = this.currentMessage();
    msg.parts.push({ type: "text", text: `⚠️ ${this._error}` });
    return true;
  }

  private handleQuestionAsked(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    // SDK type: EventQuestionAsked → QuestionRequest
    const questions = (
      properties as { questions?: Array<{ question?: string }> }
    ).questions;
    const questionText = questions?.[0]?.question ?? "unknown question";
    this._error = `Agent asked a question that cannot be answered non-interactively: "${questionText}". Consider making the prompt more specific.`;
    this._status = "error";
    this._dirty = true;
    const msg = this.currentMessage();
    msg.parts.push({ type: "text", text: `⚠️ ${this._error}` });
    return true;
  }

  private handleSessionDiff(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { diff } = properties as { diff?: FileDiff[] };
    if (diff && Array.isArray(diff)) {
      this._diffs = diff;
      this._dirty = true;
      return true;
    }
    return false;
  }

  private handleFileEdited(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const file = (properties as { file?: string }).file;
    if (file && !this._filesEdited.includes(file)) {
      this._filesEdited.push(file);
      this._dirty = true;
      return true;
    }
    return false;
  }

  private handleFileWatcherUpdated(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { file, event } = properties as {
      file?: string;
      event?: string;
    };
    if (file && event) {
      this._fileChanges.push({ file, event: event as FileChange["event"] });
      this._dirty = true;
      return true;
    }
    return false;
  }

  private handleLspDiagnostics(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { serverID, path } = properties as {
      serverID?: string;
      path?: string;
    };
    if (serverID && path) {
      this._diagnostics.push({ serverID, path });
      this._dirty = true;
      return true;
    }
    return false;
  }

  private handlePtyCreated(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const info = (properties as { info?: Pty }).info;
    if (info?.id) {
      this._processes.set(info.id, {
        id: info.id,
        command: info.command,
        args: info.args,
        status: "running"
      });
      this._dirty = true;
      return true;
    }
    return false;
  }

  /**
   * Handle `pty.updated` — the SDK defines this with the full `Pty` info.
   * Useful for tracking title changes or status updates mid-run.
   */
  private handlePtyUpdated(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const info = (properties as { info?: Pty }).info;
    if (info?.id && this._processes.has(info.id)) {
      const existing = this._processes.get(info.id)!;
      existing.command = info.command;
      existing.args = info.args;
      existing.status = info.status;
      this._dirty = true;
      return true;
    }
    return false;
  }

  private handlePtyExited(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { id, exitCode } = properties as {
      id?: string;
      exitCode?: number;
    };
    if (id && this._processes.has(id)) {
      const proc = this._processes.get(id)!;
      proc.status = "exited";
      proc.exitCode = exitCode;
      this._dirty = true;
      return true;
    }
    return false;
  }

  /**
   * Handle `pty.deleted` — process entry removed. Clean up our tracking.
   */
  private handlePtyDeleted(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { id } = properties as { id?: string };
    if (id && this._processes.has(id)) {
      this._processes.delete(id);
      this._dirty = true;
      return true;
    }
    return false;
  }

  private handleTodoUpdated(
    properties: Record<string, unknown> | undefined
  ): boolean {
    if (!properties) return false;
    const { todos } = properties as { todos?: Todo[] };
    if (todos && Array.isArray(todos)) {
      this._todos = todos;
      this._dirty = true;
      return true;
    }
    return false;
  }

  /**
   * Get a snapshot of the current state for yielding as a preliminary
   * tool result. Returns a deep copy so mutations don't affect yielded values.
   */
  getSnapshot(): OpenCodeRunOutput {
    this._dirty = false;
    return {
      status: this._status,
      sessionId: this.sessionId,
      messages: structuredClone(this.messages),
      filesEdited: [...this._filesEdited],
      fileChanges: structuredClone(this._fileChanges),
      diffs: structuredClone(this._diffs),
      diagnostics: structuredClone(this._diagnostics),
      processes: [...this._processes.values()].map((p) => ({ ...p })),
      todos: structuredClone(this._todos),
      ...(this._modelID && { modelID: this._modelID }),
      ...(this._status === "complete" && {
        summary: this._responseText || "Coding task completed."
      }),
      ...(this._status === "error" && {
        error: this._error ?? "Unknown error"
      })
    };
  }
}
