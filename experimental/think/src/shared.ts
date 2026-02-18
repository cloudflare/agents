/**
 * Message sync protocol types.
 *
 * The sync layer is generic over any message shape that has an `id`.
 * Consumers define their own concrete message type (with role, content,
 * parts, etc.) and pass it as a type parameter.
 */

export type BaseMessage = { id: string };

/**
 * Concrete message type used by the Think coding agent.
 * Swap for AI SDK's UIMessage when the agent loop lands.
 */
export type ThinkMessage = BaseMessage & {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};

export type ThreadInfo = {
  id: string;
  name: string;
  createdAt: string;
  lastActiveAt: string;
};

// ── WebSocket protocol (ThinkAgent ↔ browser) ───────────────────────

export enum MessageType {
  /** Server → Client: messages for a thread */
  SYNC = "sync",
  /** Server → Client: thread was cleared */
  CLEAR = "clear",
  /** Server → Client: full thread list */
  THREADS = "threads",

  /** Client → Server: add a message to a thread */
  ADD = "add",
  /** Client → Server: delete a message from a thread */
  DELETE = "delete",
  /** Client → Server: clear a thread */
  CLEAR_REQUEST = "clear_request",

  /** Client → Server: create a new thread */
  CREATE_THREAD = "create_thread",
  /** Client → Server: delete a thread */
  DELETE_THREAD = "delete_thread",
  /** Client → Server: rename a thread */
  RENAME_THREAD = "rename_thread",

  /** Client → Server: request messages for a thread */
  GET_MESSAGES = "get_messages"
}

export type ServerMessage<M extends BaseMessage = BaseMessage> =
  | { type: MessageType.SYNC; threadId: string; messages: M[] }
  | { type: MessageType.CLEAR; threadId: string }
  | { type: MessageType.THREADS; threads: ThreadInfo[] };

export type ClientMessage<M extends BaseMessage = BaseMessage> =
  | { type: MessageType.ADD; threadId: string; message: M }
  | { type: MessageType.DELETE; threadId: string; id: string }
  | { type: MessageType.CLEAR_REQUEST; threadId: string }
  | { type: MessageType.CREATE_THREAD; name?: string }
  | { type: MessageType.DELETE_THREAD; threadId: string }
  | { type: MessageType.RENAME_THREAD; threadId: string; name: string }
  | { type: MessageType.GET_MESSAGES; threadId: string };
