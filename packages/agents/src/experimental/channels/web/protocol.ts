import type {
  ClientTool,
  ConversationInfo,
  ConversationOperation,
  ConversationSnapshot,
  InboundEvent,
  Json,
  JsonObject,
  Participant,
  ResponseChunk,
  TranscriptMessage,
  TurnStatus
} from "../protocol";

/** Who a connection is: set by the gateway, read by the Web Channel. */
export type WebIdentity = {
  /** The route that picked the agent. */
  route: string;
  /** The conversation to follow. Default: the agent's default for the route. */
  conversationId?: string;
  participant: Participant;
};

/**
 * The header carrying a connection's WebIdentity from the gateway to the
 * agent. The gateway always sets it, so a client cannot supply its own; an
 * agent must not take WebSocket upgrades from any other route.
 */
export const WEB_IDENTITY_HEADER = "x-channels-identity";

// Frames between Channels and a connected client. Each connection follows
// one conversation at a time, and every server frame names it, so a client
// can drop frames for a conversation it no longer follows. Payloads are the
// shared protocol types, unchanged.

export type ClientFrame =
  | { type: "channels:event"; event: InboundEvent }
  | { type: "channels:subscribe"; responseId: string; from?: number }
  /** Ask for the agent's conversations; answered by `channels:conversations`. */
  | { type: "channels:list-conversations"; requestId: string };

export type ServerFrame = { conversationId: string } &
  /**
   * On connect, after a reset (empty), and when the connection follows
   * another conversation. `you` is this connection's participant;
   * `operations` are the conversation operations it may send.
   */
  (
    | ({
        type: "channels:snapshot";
        you: Participant;
        operations: ConversationOperation[];
      } & ConversationSnapshot)
    | { type: "channels:turn"; turn: TurnStatus }
    /** Upserts by id; an unknown id appends. */
    | { type: "channels:messages"; messages: TranscriptMessage[] }
    | {
        type: "channels:chunks";
        responseId: string;
        /** Seq of the first chunk. */
        from: number;
        chunks: ResponseChunk[];
      }
    /** Everything before this was replay; what follows is live. */
    | { type: "channels:caught-up"; responseId: string; cursor: number }
    | {
        type: "channels:end";
        responseId: string;
        state: "ended" | "interrupted" | "not-found";
      }
    /**
     * The agent's conversations: the answer to a list request, carrying its
     * `requestId`, or pushed when one is created or forked.
     */
    | {
        type: "channels:conversations";
        requestId?: string;
        conversations?: ConversationInfo[];
        error?: string;
      }
    /** `conversationId` is the one a create or fork started, when it did. */
    | { type: "channels:ack"; eventId: string; error?: string }
  );

/** A frame that names a Channels type but is malformed. */
export type InvalidClientFrame = { invalid: string; eventId?: string };

/**
 * Parse a text frame. Returns undefined for anything that is not a Channels
 * frame, so the socket's other protocols keep working.
 */
export function parseClientFrame(
  text: string
): ClientFrame | InvalidClientFrame | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(frame) || typeof frame.type !== "string") return undefined;
  if (frame.type === "channels:subscribe") {
    const { responseId, from } = frame;
    if (typeof responseId !== "string") return { invalid: "responseId" };
    if (from !== undefined && !Number.isInteger(from)) {
      return { invalid: "from" };
    }
    return {
      type: "channels:subscribe",
      responseId,
      ...(typeof from === "number" && { from })
    };
  }
  if (frame.type === "channels:list-conversations") {
    return isId(frame.requestId)
      ? { type: "channels:list-conversations", requestId: frame.requestId }
      : { invalid: "requestId" };
  }
  if (frame.type !== "channels:event") return undefined;
  const event = frame.event;
  const eventId = isObject(event) ? event.eventId : undefined;
  if (!isObject(event) || !isId(eventId)) return { invalid: "eventId" };
  const parsed = parseEvent(event, eventId);
  return typeof parsed === "string"
    ? { invalid: parsed, eventId }
    : { type: "channels:event", event: parsed };
}

type JsonRecord = { readonly [key: string]: Json | undefined };

// Parsed JSON is JSON, so narrowing to an object is enough to read it.
function isObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** The event, or the name of the first invalid field. */
function parseEvent(event: JsonRecord, eventId: string): InboundEvent | string {
  switch (event.type) {
    case "message": {
      const message = event.message;
      if (!isObject(message) || !isId(message.id)) return "message.id";
      if (message.role !== "user") return "message.role";
      const parts = message.parts;
      if (!Array.isArray(parts) || !parts.every(isPart)) return "message.parts";
      return {
        type: "message",
        eventId,
        message: {
          id: message.id,
          role: "user",
          // SAFETY: each part is an object with a string type; the agent
          // decides which part types it accepts.
          parts: parts as unknown as TranscriptMessage["parts"],
          ...(isObject(message.metadata) && {
            metadata: message.metadata as JsonObject
          })
        },
        ...clientTools(event.clientTools)
      };
    }
    case "tool-result": {
      const { turnId, toolCallId, result } = event;
      if (!isId(turnId)) return "turnId";
      if (!isId(toolCallId)) return "toolCallId";
      if (!isObject(result) || typeof result.ok !== "boolean") return "result";
      return {
        type: "tool-result",
        eventId,
        turnId,
        toolCallId,
        result: result.ok
          ? { ok: true, output: result.output ?? null }
          : {
              ok: false,
              ...(typeof result.errorText === "string" && {
                errorText: result.errorText
              })
            },
        ...clientTools(event.clientTools)
      };
    }
    case "approval-response": {
      const { turnId, approvalId, approved, reason } = event;
      if (!isId(turnId)) return "turnId";
      if (!isId(approvalId)) return "approvalId";
      if (typeof approved !== "boolean") return "approved";
      return {
        type: "approval-response",
        eventId,
        turnId,
        approvalId,
        approved,
        ...(typeof reason === "string" && { reason })
      };
    }
    case "cancel":
      return isId(event.turnId)
        ? { type: "cancel", eventId, turnId: event.turnId }
        : "turnId";
    case "conversation-create":
    case "conversation-fork":
      return { type: event.type, eventId };
    case "conversation-reset":
      if (event.handoff !== undefined && typeof event.handoff !== "string") {
        return "handoff";
      }
      return {
        type: "conversation-reset",
        eventId,
        ...(event.handoff && { handoff: event.handoff })
      };
    default:
      return "type";
  }
}

function isPart(part: Json): boolean {
  return isObject(part) && typeof part.type === "string";
}

/** Keeps tools with a name, dropping a schema that is not an object. */
function clientTools(value: Json | undefined): { clientTools?: ClientTool[] } {
  if (!Array.isArray(value)) return {};
  const tools: ClientTool[] = [];
  for (const tool of value) {
    if (!isObject(tool) || !isId(tool.name)) continue;
    tools.push({
      name: tool.name,
      ...(typeof tool.description === "string" && {
        description: tool.description
      }),
      ...(isObject(tool.inputSchema) && {
        inputSchema: tool.inputSchema as JsonObject
      })
    });
  }
  return { clientTools: tools };
}
