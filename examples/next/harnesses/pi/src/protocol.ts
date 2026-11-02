import type { Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ConversationView, UserInput } from "@earendil-works/pi-durable";
import type { PiConversationId, PiWhenBusy } from "agents/harness/pi";

/**
 * This app's WebSocket protocol, served by `sockets.ts`. The harness knows
 * nothing about it: it is one way to put `conversation.watch()` and
 * `conversation.submit()` on a socket.
 */

export type PiToolInfo = {
  readonly name: string;
  readonly description: string;
};

/** Client → server. Commands with an `id` get a `result` or `error` back. */
export type PiClientMessage =
  | {
      readonly type: "submit";
      readonly id?: string;
      readonly input: UserInput;
      readonly whenBusy?: PiWhenBusy;
      readonly operationId?: string;
    }
  | { readonly type: "abort"; readonly id?: string }
  | { readonly type: "reset"; readonly id?: string; readonly handoff?: string }
  /** Ask for the whole view again. */
  | { readonly type: "resync"; readonly id?: string };

/** Server → client. */
export type PiServerMessage =
  | {
      readonly type: "hello";
      readonly conversation: PiConversationId;
      readonly tools: readonly PiToolInfo[];
    }
  /**
   * pi's conversation view for the connection's conversation, from
   * `conversation.watch()`: sent whole when the watch starts, and again after
   * the server lost its watch. It replaces the client's view.
   */
  | {
      readonly type: "view";
      readonly conversation: PiConversationId;
      readonly view: ConversationView;
    }
  /** pi's operations for one change of the view, to apply to the last one. */
  | {
      readonly type: "ops";
      readonly conversation: PiConversationId;
      readonly ops: readonly Op[];
    }
  | { readonly type: "result"; readonly id: string; readonly result: JsonValue }
  | { readonly type: "error"; readonly id?: string; readonly message: string };

export type {
  PiClientMessage as ClientMessage,
  PiServerMessage as ServerMessage,
  PiToolInfo as ToolInfo
};
export type {
  PiMessage as TranscriptMessage,
  PiMessagePart as TranscriptPart
} from "./transcript";
export type { PiConversationView } from "./view";
