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
  reasoning?: string;
  createdAt: number;
};

export type ThreadInfo = {
  id: string;
  name: string;
  workspaceId: string | null;
  createdAt: string;
  lastActiveAt: string;
};

export type WorkspaceInfo = {
  id: string;
  name: string;
  createdAt: string;
};

// ── File browser types ────────────────────────────────────────────────────────

/** Minimal file entry shape used in the file browser protocol. */
export type FileEntry = {
  path: string;
  name: string;
  type: "file" | "directory";
  mimeType: string;
  size: number;
};

// ── WebSocket protocol (ThinkAgent ↔ browser) ───────────────────────

export enum MessageType {
  /** Server → Client: messages for a thread */
  SYNC = "sync",
  /** Server → Client: thread was cleared */
  CLEAR = "clear",
  /** Server → Client: full thread list */
  THREADS = "threads",
  /** Server → Client: streaming text delta */
  STREAM_DELTA = "stream_delta",
  /** Server → Client: streaming reasoning/thinking delta */
  REASONING_DELTA = "reasoning_delta",
  /** Server → Client: agent invoked a tool (live progress indicator) */
  TOOL_CALL = "tool_call",
  /** Server → Client: streaming finished */
  STREAM_END = "stream_end",

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
  GET_MESSAGES = "get_messages",

  /** Client → Server: run the agent loop on a thread */
  RUN = "run",

  /** Server → Client: full workspace list */
  WORKSPACES = "workspaces",

  /** Client → Server: create a new workspace */
  CREATE_WORKSPACE = "create_workspace",
  /** Client → Server: delete a workspace */
  DELETE_WORKSPACE = "delete_workspace",
  /** Client → Server: rename a workspace */
  RENAME_WORKSPACE = "rename_workspace",
  /** Client → Server: attach a workspace to a thread */
  ATTACH_WORKSPACE = "attach_workspace",
  /** Client → Server: detach the workspace from a thread */
  DETACH_WORKSPACE = "detach_workspace",

  /** Client → Server: list files in a workspace directory */
  LIST_FILES = "list_files",
  /** Server → Client: directory listing result */
  FILE_LIST = "file_list",
  /** Client → Server: read a file from a workspace */
  READ_FILE = "read_file",
  /** Server → Client: file content result */
  FILE_CONTENT = "file_content"
}

export type ServerMessage<M extends BaseMessage = BaseMessage> =
  | { type: MessageType.SYNC; threadId: string; messages: M[] }
  | { type: MessageType.CLEAR; threadId: string }
  | { type: MessageType.THREADS; threads: ThreadInfo[] }
  | { type: MessageType.STREAM_DELTA; threadId: string; delta: string }
  | { type: MessageType.REASONING_DELTA; threadId: string; delta: string }
  | {
      type: MessageType.TOOL_CALL;
      threadId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: MessageType.STREAM_END; threadId: string }
  | { type: MessageType.WORKSPACES; workspaces: WorkspaceInfo[] }
  | {
      type: MessageType.FILE_LIST;
      workspaceId: string;
      dir: string;
      entries: FileEntry[];
    }
  | {
      type: MessageType.FILE_CONTENT;
      workspaceId: string;
      path: string;
      content: string | null;
    };

export type ClientMessage<M extends BaseMessage = BaseMessage> =
  | { type: MessageType.ADD; threadId: string; message: M }
  | { type: MessageType.DELETE; threadId: string; id: string }
  | { type: MessageType.CLEAR_REQUEST; threadId: string }
  | { type: MessageType.CREATE_THREAD; name?: string }
  | { type: MessageType.DELETE_THREAD; threadId: string }
  | { type: MessageType.RENAME_THREAD; threadId: string; name: string }
  | { type: MessageType.GET_MESSAGES; threadId: string }
  | { type: MessageType.RUN; threadId: string }
  | { type: MessageType.CREATE_WORKSPACE; name?: string }
  | { type: MessageType.DELETE_WORKSPACE; workspaceId: string }
  | { type: MessageType.RENAME_WORKSPACE; workspaceId: string; name: string }
  | {
      type: MessageType.ATTACH_WORKSPACE;
      threadId: string;
      workspaceId: string;
    }
  | { type: MessageType.DETACH_WORKSPACE; threadId: string }
  | { type: MessageType.LIST_FILES; workspaceId: string; dir: string }
  | { type: MessageType.READ_FILE; workspaceId: string; path: string };
