import type {
  OpenCodeEvent,
  OpenCodeJson,
  OpenCodeSessionId,
  OpenCodeWhenBusy
} from "agents/harness/opencode";
import type { ToolInfo } from "./workspace";

/**
 * This app's WebSocket protocol, served by `sockets.ts`. The harness knows
 * nothing about it: it is one way to put `session.events()` and
 * `session.submit()` on a socket. It is the Pi example's protocol, with
 * OpenCode's events in place of pi's.
 */

/** Client → server. Commands with an `id` get a `result` or `error` back. */
export type OpenCodeClientMessage =
  | {
      readonly type: "submit";
      readonly id?: string;
      readonly input: string;
      readonly whenBusy?: OpenCodeWhenBusy;
      readonly operationId?: string;
    }
  | { readonly type: "abort"; readonly id?: string }
  /** Ask for a fresh snapshot. */
  | { readonly type: "resync"; readonly id?: string };

/** Server → client. */
export type OpenCodeServerMessage =
  | {
      readonly type: "hello";
      /** OpenCode's own id for the session, which the CLI takes. */
      readonly session: OpenCodeSessionId;
      readonly tools: readonly ToolInfo[];
    }
  /**
   * The session's events. The first batch of a watch, and any batch after
   * the server lost its watch, starts with a `snapshot` event that replaces
   * the client's state.
   */
  | {
      readonly type: "events";
      readonly session: OpenCodeSessionId;
      readonly events: readonly OpenCodeEvent[];
    }
  | {
      readonly type: "result";
      readonly id: string;
      readonly result: OpenCodeJson;
    }
  | { readonly type: "error"; readonly id?: string; readonly message: string };

export type {
  OpenCodeClientMessage as ClientMessage,
  OpenCodeServerMessage as ServerMessage
};
export type { ToolInfo } from "./workspace";
export type {
  OpenCodeTranscriptMessage as TranscriptMessage,
  OpenCodeMessagePart as TranscriptPart
} from "./transcript";
export type { OpenCodeSessionView as SessionView } from "./view";
