/**
 * The vocabulary the browser shares with the self-modifying harness: the
 * `HarnessProtocol` that types its events, submissions and results, and the
 * snapshot its HTTP inspection route returns. This module has no runtime
 * imports, so the client bundle carries none of the server.
 */
import type { HarnessRevision, JournalRecord } from "./store";

export type { JsonObject, JsonValue } from "./json";
export type { HarnessRevision, JournalRecord } from "./store";

/** One file of the active revision's source snapshot. */
export type HarnessSourceFile = {
  readonly path: string;
  readonly size: number;
  readonly content: string;
};

/** What `GET /agents/self-modifying-harness/<name>/snapshot` returns. */
export type SelfModifyingSnapshot = {
  readonly active: HarnessRevision;
  /** The active revision's exact source, sorted by path. */
  readonly files: readonly HarnessSourceFile[];
  /** Activation history, newest first. */
  readonly revisions: readonly HarnessRevision[];
  /** Trusted journal, newest first. */
  readonly journal: readonly JournalRecord[];
};

/** Model progress the pinned turn reports beside its core frames. */
export type SelfModifyingTurnEvent =
  | { readonly type: "model_started"; readonly round: number }
  | {
      readonly type: "model_completed";
      readonly round: number;
      readonly finishReason: string;
      readonly toolCalls: number;
    };

/** Every runtime-specific event body, carried as `{ type: "extension", body }`. */
export type SelfModifyingEvent =
  | SelfModifyingTurnEvent
  | { readonly type: "journal"; readonly record: JournalRecord };

/** Durable source operations, admitted through `session.submit()`. */
export type SelfModifyingSubmission =
  | { readonly kind: "activate"; readonly payload: { readonly note: string } }
  | {
      readonly kind: "restore";
      readonly payload: { readonly revisionId: number };
    }
  | {
      readonly kind: "write_source";
      readonly payload: { readonly path: string; readonly content: string };
    };

/** The terminal record of each operation, as `HarnessResult.raw`. */
export type SelfModifyingResult =
  | { readonly revisionId: number; readonly output?: string }
  | { readonly revision: HarnessRevision }
  | { readonly path: string };

/** The protocol `Harness<SelfModifyingProtocol>` is typed with. */
export type SelfModifyingProtocol = {
  event: SelfModifyingEvent;
  submit: SelfModifyingSubmission;
  result: SelfModifyingResult;
};

/** The phase an activation failed in, reported as `HarnessResult.error.code`. */
export type SelfModifyingErrorCode = "source" | "bundle" | "check" | "turn";
