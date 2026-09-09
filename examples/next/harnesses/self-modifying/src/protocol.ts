/**
 * Wire contract between the browser and the self-modifying harness. Both the
 * client and the Durable Object import this module, so it must stay free of
 * runtime imports.
 */
import type { JsonObject } from "./json";
import type { HarnessRevision, HarnessTurn, JournalRecord } from "./store";

export type { JsonObject, JsonValue } from "./json";
export type { HarnessRevision, HarnessTurn, JournalRecord } from "./store";

/** One file of the active revision's source snapshot. */
export type HarnessSourceFile = {
  readonly path: string;
  readonly size: number;
  readonly content: string;
};

/** Everything the client needs to render an object on connect. */
export type HarnessSnapshot = {
  readonly active: HarnessRevision;
  readonly files: readonly HarnessSourceFile[];
  readonly revisions: readonly HarnessRevision[];
  /** Turns oldest first. */
  readonly turns: readonly HarnessTurn[];
  /** Journal newest first. */
  readonly journal: readonly JournalRecord[];
};

/** Receipt returned once a turn and its Tasks wake are durable. */
export type HarnessTurnReceipt = {
  readonly turnId: string;
  readonly streamId: string;
  readonly revisionId: number;
  readonly accepted: boolean;
};

/** Messages a browser sends over the WebSockets capability. */
export type HarnessClientMessage =
  | { readonly type: "snapshot"; readonly id: string }
  | { readonly type: "submit"; readonly id: string; readonly prompt: string }
  | {
      /** Replay a turn's durable event stream from `from`, then tail it. */
      readonly type: "subscribe";
      readonly turnId: string;
      readonly from?: number;
    }
  | {
      readonly type: "write_source";
      readonly id: string;
      readonly path: string;
      readonly content: string;
    }
  | { readonly type: "activate"; readonly id: string; readonly note: string }
  | {
      readonly type: "restore";
      readonly id: string;
      readonly revisionId: number;
    };

/** Messages the Durable Object sends to a browser. */
export type HarnessServerMessage =
  | { readonly type: "snapshot"; readonly snapshot: HarnessSnapshot }
  | { readonly type: "turn"; readonly turn: HarnessTurn }
  | {
      readonly type: "events";
      readonly turnId: string;
      readonly seq: number;
      readonly lastSeq: number;
      readonly events: readonly JsonObject[];
    }
  | { readonly type: "stream_end"; readonly turnId: string }
  | {
      readonly type: "result";
      readonly id: string;
      readonly result: JsonObject;
    }
  | {
      readonly type: "error";
      readonly id?: string;
      readonly message: string;
      /** Activation phase that failed, when a build was rejected. */
      readonly phase?: "source" | "bundle" | "check";
    };
