import type { UIMessage } from "ai";
import type { CoderToolOutput } from "./types";

// ── OpenCode SSE event types ────────────────────────────────────────

/** Shape of events from the OpenCode SSE stream. */
export interface OpenCodeSSEEvent {
  type: string;
  properties?: Record<string, unknown>;
}

/** Shape of a message part inside `message.part.updated` events. */
interface OpenCodeMessagePart {
  type: string;
  sessionID?: string;
  tool?: string;
  text?: string;
  state?: {
    status: string;
    title?: string;
    input?: Record<string, unknown>;
    output?: unknown;
    error?: string;
  };
}

/**
 * Local type for the dynamic-tool message parts we push into UIMessage.
 *
 * The AI SDK's UIMessage part union doesn't include all the fields we
 * need for dynamic-tool parts (toolName, toolCallId, output, errorText,
 * title).  Rather than casting to `any`, we define this interface and
 * push it via a widening cast to `UIMessage["parts"][number]`.
 */
interface DynamicToolPart {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: "input-available" | "output-available" | "output-error";
  input: Record<string, unknown>;
  output?: unknown;
  errorText?: string;
  title?: string;
}

// ── Accumulator ─────────────────────────────────────────────────────

/**
 * Translates OpenCode SSE events into AI SDK `UIMessage[]` state.
 *
 * Maintains a mutable messages array that grows as events arrive.
 * Call `processEvent()` for each SSE event, then `getSnapshot()` to
 * get a deep-copied `CoderToolOutput` suitable for yielding.
 */
export class OpenCodeStreamAccumulator {
  private messages: UIMessage[] = [];
  private sessionId: string;
  private _status: "working" | "complete" | "error" = "working";
  private _error: string | null = null;
  private _responseText = "";
  /** Track whether state changed since last snapshot. */
  private _dirty = false;

  /** Counter for generating unique IDs within this accumulator. */
  private _idCounter = 0;

  /** Map from OpenCode tool identifier to the toolCallId we assigned. */
  private _toolCallIds = new Map<string, string>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
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
   * Get or create a stable toolCallId for an OpenCode tool invocation.
   * OpenCode doesn't always provide a unique callId per invocation,
   * so we key by tool name + index.
   */
  private getToolCallId(toolName: string, partIndex?: number): string {
    const key = `${toolName}:${partIndex ?? 0}`;
    let id = this._toolCallIds.get(key);
    if (!id) {
      id = this.nextId("tool");
      this._toolCallIds.set(key, id);
    }
    return id;
  }

  /**
   * Process a single OpenCode SSE event and update internal state.
   * Returns true if the event caused a state change (dirty).
   */
  processEvent(ev: OpenCodeSSEEvent): boolean {
    if (ev.type === "message.part.updated" && ev.properties) {
      const part = ev.properties.part as OpenCodeMessagePart | undefined;
      if (!part) return false;

      // Filter by session
      if (part.sessionID && part.sessionID !== this.sessionId) return false;

      if (part.type === "text" && typeof part.text === "string") {
        return this.handleTextPart(part.text);
      }

      if (part.type === "tool" && part.state) {
        return this.handleToolPart(part);
      }
    }

    if (ev.type === "message.updated" && ev.properties) {
      return this.handleMessageUpdated(ev.properties);
    }

    if (ev.type === "session.idle" && ev.properties) {
      const idleSessionId = (ev.properties as { sessionID?: string }).sessionID;
      if (idleSessionId === this.sessionId) {
        this._status = "complete";
        this._dirty = true;
        return true;
      }
    }

    if (ev.type === "session.error" && ev.properties) {
      const errSessionId = (ev.properties as { sessionID?: string }).sessionID;
      if (errSessionId === this.sessionId) {
        this._error =
          ((ev.properties as { error?: string }).error as string) ??
          "Session error";
        this._status = "error";
        this._dirty = true;
        return true;
      }
    }

    return false;
  }

  private handleTextPart(text: string): boolean {
    this._responseText = text;
    const msg = this.currentMessage();

    // Find existing text part and update, or create new one
    const existing = msg.parts.find((p) => p.type === "text");
    if (existing && existing.type === "text") {
      existing.text = text;
    } else {
      msg.parts.push({ type: "text", text });
    }

    this._dirty = true;
    return true;
  }

  private handleToolPart(part: OpenCodeMessagePart): boolean {
    const toolName = part.tool ?? "unknown";
    const state = part.state!;
    const msg = this.currentMessage();

    // Use a counter based on how many tool parts we've seen for this tool name
    // to create stable IDs
    const existingToolParts = msg.parts.filter(
      (p) =>
        p.type === "dynamic-tool" &&
        "toolName" in p &&
        (p as unknown as DynamicToolPart).toolName === toolName
    );
    const partIndex = existingToolParts.length;

    // For running tools, check if we already have this one
    const toolCallId = this.getToolCallId(
      toolName,
      partIndex > 0 ? partIndex - 1 : 0
    );
    const existingPart = this.findToolPart(msg, toolCallId);

    if (state.status === "running") {
      if (!existingPart) {
        // New tool invocation — add input-available part
        this.pushDynamicPart(msg, {
          type: "dynamic-tool",
          toolName,
          toolCallId,
          state: "input-available",
          input: state.input ?? {},
          title: state.title
        });
      }
      this._dirty = true;
      return true;
    }

    if (state.status === "completed") {
      if (existingPart) {
        // Update existing part to output-available
        const p = existingPart as unknown as DynamicToolPart;
        p.state = "output-available";
        p.output = state.output ?? state.title ?? "Done";
      } else {
        // Tool completed without a prior running event
        this.pushDynamicPart(msg, {
          type: "dynamic-tool",
          toolName,
          toolCallId,
          state: "output-available",
          input: state.input ?? {},
          output: state.output ?? state.title ?? "Done",
          title: state.title
        });
      }
      // Create a new toolCallId slot for the next invocation of the same tool
      this._toolCallIds.delete(
        `${toolName}:${partIndex > 0 ? partIndex - 1 : 0}`
      );
      this._dirty = true;
      return true;
    }

    if (state.status === "error") {
      if (existingPart) {
        const p = existingPart as unknown as DynamicToolPart;
        p.state = "output-error";
        p.errorText = state.error ?? `${toolName} failed`;
      } else {
        this.pushDynamicPart(msg, {
          type: "dynamic-tool",
          toolName,
          toolCallId,
          state: "output-error",
          input: state.input ?? {},
          errorText: state.error ?? `${toolName} failed`,
          title: state.title
        });
      }
      this._dirty = true;
      return true;
    }

    return false;
  }

  private handleMessageUpdated(properties: Record<string, unknown>): boolean {
    const info = properties as {
      error?: {
        name?: string;
        data?: { message?: string; statusCode?: number };
      };
    };
    if (info.error) {
      const statusCode = info.error.data?.statusCode ?? "unknown";
      const errorText =
        info.error.data?.message ?? info.error.name ?? "Unknown provider error";
      this._error = `OpenCode provider error (${statusCode}): ${errorText}`;

      // Add error text to the conversation
      const msg = this.currentMessage();
      msg.parts.push({
        type: "text",
        text: `⚠️ ${this._error}`
      });

      this._dirty = true;
      return true;
    }
    return false;
  }

  /**
   * Get a snapshot of the current state for yielding as a preliminary
   * tool result. Returns a deep copy so mutations don't affect yielded values.
   */
  getSnapshot(): CoderToolOutput {
    this._dirty = false;
    return {
      status: this._status,
      sessionId: this.sessionId,
      messages: structuredClone(this.messages),
      ...(this._status === "complete" && {
        summary: this._responseText || "Coding task completed."
      }),
      ...(this._status === "error" && {
        error: this._error ?? "Unknown error"
      })
    };
  }
}
