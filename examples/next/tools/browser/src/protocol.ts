import type { Op } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  ConversationView,
  Cursor,
  EntryId,
  EntryQuery,
  EntryRecord,
  Page,
  UserInput
} from "@earendil-works/pi-durable";
import type { PiSessionId, PiWhenBusy } from "agents/harness/pi";

/**
 * This app's WebSocket protocol, served by `sockets.ts`. The harness knows
 * nothing about it: it is one way to put `session.watch()`,
 * `session.entries()`, and `session.submit()` on a socket.
 */

export type PiToolInfo = {
  readonly name: string;
  readonly description: string;
};

/** A page of the session's entries, as `session.entries()` returns it. */
export type PiEntriesPage = Page<EntryRecord, Cursor>;

/** What a command's `result` carries. */
export type PiCommandResult = JsonValue | PiEntriesPage;

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
  /**
   * Watch the session: the server answers with a `view`, then `ops`. Sent
   * each time the socket opens. `from` resumes a transcript the client
   * already has: the window starts right after its newest entry
   * (`ConversationTranscript.resume`).
   */
  | { readonly type: "watch"; readonly id?: string; readonly from?: EntryId }
  /**
   * A page of the session's entries, for `ConversationTranscript` to load
   * earlier entries and fill gaps. The `result` is a `PiEntriesPage`.
   */
  | {
      readonly type: "entries";
      readonly id: string;
      readonly query: Omit<EntryQuery, "conversationId">;
      readonly limit: number;
    };

/** Server → client. */
export type PiServerMessage =
  | {
      readonly type: "hello";
      readonly session: PiSessionId;
      readonly tools: readonly PiToolInfo[];
    }
  /**
   * pi's conversation view for the connection's session, from
   * `session.watch()`: sent whole when a watch starts, after a `watch`,
   * after the object restarts, and after pi reopens. Its window is a few
   * dozen entries; the client merges it into its transcript, and the
   * following `ops` apply to it.
   */
  | {
      readonly type: "view";
      readonly session: PiSessionId;
      readonly view: ConversationView;
    }
  /** pi's operations for one change of the view, to apply to the last one. */
  | {
      readonly type: "ops";
      readonly session: PiSessionId;
      readonly ops: readonly Op[];
    }
  | {
      readonly type: "result";
      readonly id: string;
      readonly result: PiCommandResult;
    }
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
export type { PiSessionView as SessionView } from "./view";
