import type {
  OpenCodeEvent,
  OpenCodeJson,
  OpenCodeSessionId,
  OpenCodeWhenBusy
} from "agents/harness/opencode";
import type { ToolInfo } from "./workspace";

export type OpenCodeClientMessage =
  | {
      readonly type: "submit";
      readonly id?: string;
      readonly input: string;
      readonly whenBusy?: OpenCodeWhenBusy;
      readonly operationId?: string;
    }
  | { readonly type: "abort"; readonly id?: string }
  | { readonly type: "resync"; readonly id?: string };

export type OpenCodeServerMessage =
  | {
      readonly type: "hello";
      readonly session: OpenCodeSessionId;
      readonly tools: readonly ToolInfo[];
    }
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
