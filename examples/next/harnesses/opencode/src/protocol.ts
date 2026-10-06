import type {
  OpenCodeEvent,
  OpenCodeMessage,
  OpenCodePendingOperation,
  OpenCodeSessionId,
  OpenCodeSessionInfo,
  OpenCodeWhenBusy
} from "agents/harness/opencode";

/**
 * This app's WebSocket protocol, served by `sockets.ts`. The harness knows
 * nothing about it: it is one way to put a session's transcript, its live
 * events and `session.submit()` on a socket.
 */

/** Client → server. Commands with an `id` get a `result` or `error` back. */
export type ClientMessage =
  | {
      readonly type: "submit";
      readonly id?: string;
      readonly text: string;
      readonly whenBusy?: OpenCodeWhenBusy;
    }
  | { readonly type: "abort"; readonly id?: string }
  | { readonly type: "create"; readonly id?: string }
  | { readonly type: "resync"; readonly id?: string };

/** One session's state: what a client renders. */
export type SessionSnapshot = {
  readonly session: OpenCodeSessionId;
  /** The whole transcript, compacted messages included. */
  readonly messages: readonly OpenCodeMessage[];
  readonly busy: boolean;
  readonly pending: readonly OpenCodePendingOperation[];
};

/** Server → client. */
export type ServerMessage =
  | { readonly type: "hello"; readonly session: OpenCodeSessionId }
  | {
      readonly type: "sessions";
      readonly sessions: readonly OpenCodeSessionInfo[];
    }
  /** Replaces the client's state for the session. */
  | ({ readonly type: "snapshot" } & SessionSnapshot)
  /** OpenCode's own events for the session, live deltas included. */
  | { readonly type: "event"; readonly event: OpenCodeEvent }
  | { readonly type: "result"; readonly id: string; readonly result: unknown }
  | {
      readonly type: "error";
      readonly id?: string;
      readonly message: string;
      /** Set when the socket's session does not exist; the socket closes. */
      readonly code?: "unknown_session";
    };
