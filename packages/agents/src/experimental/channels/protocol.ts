import type { ChannelMessageSurface } from "./surface";

// Interfaces keep the recursive arms deferred, so these values can cross
// Workers RPC (see ChannelSurfaceValue).
export type Json = null | boolean | number | string | JsonArray | JsonObject;
export interface JsonArray extends ReadonlyArray<Json> {}
export interface JsonObject {
  readonly [key: string]: Json;
}

// ── Participants ─────────────────────────────────────────────────────────

export type Participant = Readonly<{
  /** Stable within the conversation. What the agent compares for ownership. */
  id: string;
  name?: string;
}>;

// ── Transcript ───────────────────────────────────────────────────────────

export type TranscriptMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  parts: MessagePart[];
  metadata?: JsonObject;
};

export type MessagePart =
  | { type: "text"; text: string; providerMetadata?: JsonObject }
  | { type: "reasoning"; text: string; providerMetadata?: JsonObject }
  | {
      type: "file";
      mediaType: string;
      url: string;
      filename?: string;
      providerMetadata?: JsonObject;
    }
  | {
      type: "source-url";
      sourceId: string;
      url: string;
      title?: string;
      providerMetadata?: JsonObject;
    }
  | {
      type: "source-document";
      sourceId: string;
      mediaType: string;
      title: string;
      filename?: string;
      providerMetadata?: JsonObject;
    }
  | { type: "data"; name: string; id?: string; data: Json }
  | ToolPart;

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export type ToolPart = {
  type: "tool";
  toolCallId: string;
  toolName: string;
  state: ToolState;
  input?: Json;
  output?: Json;
  errorText?: string;
  /** Output so far; a later output replaces it. */
  preliminary?: boolean;
  approval?: { id: string; approved?: boolean; reason?: string };
  /** Id of the participant who may run this client tool call. Absent for server tools. */
  owner?: string;
  providerExecuted?: boolean;
  dynamic?: boolean;
  title?: string;
  providerMetadata?: JsonObject;
};

// ── Responses ────────────────────────────────────────────────────────────
//
// A response has no start or finish chunk: it begins when it is opened and
// ends when its producer closes it. Parts still open at the end are closed.
// Grammar, checked on append: a delta or end needs its part open; a start
// needs its id free within its kind (text and reasoning ids are separate);
// a tool input delta needs its tool input started.

export type ResponseChunk =
  | { type: "text-start"; id: string; providerMetadata?: JsonObject }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string; providerMetadata?: JsonObject }
  | { type: "reasoning-start"; id: string; providerMetadata?: JsonObject }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string; providerMetadata?: JsonObject }
  | {
      type: "tool-input-start";
      toolCallId: string;
      toolName: string;
      owner?: string;
      providerExecuted?: boolean;
      dynamic?: boolean;
      title?: string;
    }
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: Json;
      owner?: string;
      providerExecuted?: boolean;
      dynamic?: boolean;
      title?: string;
      providerMetadata?: JsonObject;
    }
  | {
      type: "tool-input-error";
      toolCallId: string;
      toolName: string;
      input: Json;
      errorText: string;
      providerExecuted?: boolean;
      dynamic?: boolean;
      title?: string;
    }
  | { type: "tool-approval-request"; toolCallId: string; approvalId: string }
  | {
      type: "tool-output-available";
      toolCallId: string;
      output: Json;
      preliminary?: boolean;
      providerExecuted?: boolean;
    }
  | {
      type: "tool-output-error";
      toolCallId: string;
      errorText: string;
      providerExecuted?: boolean;
    }
  | { type: "tool-output-denied"; toolCallId: string }
  | Extract<MessagePart, { type: "file" | "source-url" | "source-document" }>
  | { type: "data"; name: string; id?: string; data: Json; transient?: boolean }
  /** Merged into the metadata of the message this response builds. */
  | { type: "metadata"; metadata: JsonObject };

// ── Turns ────────────────────────────────────────────────────────────────

export type TurnOutcome = "completed" | "failed" | "aborted" | "awaiting-input";

type TurnStatusBase = {
  turnId: string;
  /** Event id of the inbound message that started the turn. */
  startedBy: string;
};

export type TurnStatus = TurnStatusBase &
  (
    | { status: "queued" }
    | {
        status: "running";
        responseId: string;
        /** Saved assistant message the response continues. */
        extends?: string;
      }
    | {
        status: "settled";
        outcome: Exclude<TurnOutcome, "failed">;
        messageIds: string[];
      }
    | {
        status: "settled";
        outcome: "failed";
        messageIds: string[];
        /** Shown to participants. Channels sends a generic message when absent. */
        error?: string;
      }
  );

// ── Snapshots ────────────────────────────────────────────────────────────

export type ConversationSnapshot = {
  messages: TranscriptMessage[];
  /** Every turn that is queued, running or awaiting input. */
  turns: TurnStatus[];
};

// ── Inbound events ───────────────────────────────────────────────────────

/** Tool a participant's client can run, advertised with an inbound event. */
export type ClientTool = {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
};

/** What an interface sends. */
export type InboundEvent = {
  /** Stable across redelivery of the same event. */
  eventId: string;
} & (
  | {
      type: "message";
      /** Save it under this id. */
      message: TranscriptMessage & { role: "user" };
      clientTools?: ClientTool[];
    }
  | {
      type: "tool-result";
      turnId: string;
      toolCallId: string;
      result: { ok: true; output: Json } | { ok: false; errorText?: string };
      clientTools?: ClientTool[];
    }
  | {
      type: "approval-response";
      turnId: string;
      approvalId: string;
      approved: boolean;
      reason?: string;
    }
  | { type: "cancel"; turnId: string }
  /** Start a new, empty conversation. The sending surface follows it. */
  | { type: "conversation-create" }
  /**
   * Start a new conversation with this one's transcript so far. The sending
   * surface follows it; other surfaces stay.
   */
  | { type: "conversation-fork" }
  /**
   * Start this conversation over, keeping its id. The agent may carry a
   * handoff note into the new context.
   */
  | { type: "conversation-reset"; handoff?: string }
);

/** Inbound events that act on a conversation rather than in it. */
export type ConversationOperation = Extract<
  InboundEvent["type"],
  "conversation-create" | "conversation-fork" | "conversation-reset"
>;

/** One of an agent's conversations, as a client lists them. */
export type ConversationInfo = {
  id: string;
  /** The conversation this one was forked from. */
  parent?: string;
  /** True while a turn is running or queued. */
  busy: boolean;
};

/** What an accepted inbound event produced, for the surface that sent it. */
export type DispatchResult = {
  /** The conversation a create or fork started; the sender follows it. */
  conversationId?: string;
};

/** Where an inbound event came from, stamped by Channels, never by the client. */
export type EventOrigin = {
  conversationId: string;
  participant: Participant;
  surface: ChannelMessageSurface;
};

/**
 * Where an inbound event came from, as the gateway knows it: the route that
 * picked the agent, and the conversation when the route named one. Channels
 * resolves an unnamed conversation to the agent's default: the route itself,
 * or a harness's default session.
 */
export type GatewayOrigin = Omit<EventOrigin, "conversationId"> & {
  route: string;
  conversationId?: string;
};
