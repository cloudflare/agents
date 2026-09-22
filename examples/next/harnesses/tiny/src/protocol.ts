import type { AGUIEvent } from "@ag-ui/core";

/**
 * Wire types shared between the harness and its surfaces.
 *
 * Everything here is JSON: a turn snapshot crosses Workers RPC, a turn event
 * is a Streams chunk, and both are rendered by the browser client.
 */

/**
 * JSON, structurally.
 *
 * `agents/tasks` (`TaskJson`) and `agents/streams` (`StreamJson`) both
 * require this exact shape at their durable boundaries, and both reject
 * `unknown` and `readonly` arrays. Declaring it once here — and using it for
 * every field that crosses a boundary — is what makes a turn replayable: a
 * value the compiler accepts here is a value that survives a restart.
 */
export type JSON =
  | string
  | number
  | boolean
  | null
  | JSON[]
  | { [key: string]: JSON };

/** Which model and tool set an agent instance runs with. */
export type HarnessRole = "lead" | "explorer";

/** Lifecycle of one turn, mirroring the Tasks run that drives it. */
export type TurnStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "cancelled";

/** Receipt proving a turn was durably accepted. */
export type TurnReceipt = {
  readonly turnId: string;
  readonly streamId: string;
  /** `false` when this call joined an existing turn instead of creating one. */
  readonly accepted: boolean;
};

/** Point-in-time view of one turn, without its transcript. */
export type TurnSnapshot = {
  readonly turnId: string;
  readonly streamId: string;
  readonly status: TurnStatus;
  readonly role: HarnessRole;
  /** The prompt, or its first kilobytes. `promptMessageId` holds it all. */
  readonly prompt: string;
  readonly promptMessageId: string;
  readonly rounds: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly text?: string;
  readonly error?: string;
  /** Set while `status === "awaiting-approval"`. */
  readonly pendingApproval?: PendingApproval;
};

/**
 * A tool call parked on a human decision.
 *
 * Mutable and JSON-shaped because it is persisted, streamed, and synced to
 * connections through the State capability.
 */
export type PendingApproval = {
  approvalId: string;
  turnId: string;
  toolName: string;
  input: JSON;
  requestedAt: number;
};

/** A human's answer to a pending approval. */
export type ApprovalDecision = {
  approved: boolean;
  /** Replacement arguments for an approved call. Rejection never edits. */
  editedArgs?: JSON;
  note?: string;
};

/** One schema-valid AG-UI 1.0 event in a turn's durable stream. */
export type TurnEvent = AGUIEvent;

/** Everything a connecting client needs to render without replaying. */
export type SessionSnapshot = {
  readonly name: string;
  readonly role: HarnessRole;
  readonly turns: readonly TurnSnapshot[];
  readonly files: readonly string[];
};

/** State the harness syncs to connections through the State capability. */
export type HarnessState = {
  readonly busy: boolean;
  readonly activeTurnId: string | null;
  readonly status: string;
  readonly pendingApproval: PendingApproval | null;
};

/** A plan item tracked by the `todo` tool. */
export type Todo = {
  readonly id: string;
  readonly text: string;
  readonly state: "pending" | "in-progress" | "done";
};
