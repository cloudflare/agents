import type {
  ContainerEvent,
  ContainerMessage,
  ContainerWhenBusy
} from "./protocol";

/**
 * `ContainerHarness`'s own types: how the harness addresses sessions and
 * reports operations. They mirror `agents/harness/pi` one for one, so code
 * written against one harness reads the same against the other. Transcript
 * messages and events are the wire's types (`ContainerMessage`,
 * `ContainerEvent`), the one format every container adapter produces.
 */

/** A session, addressed by its id. The root is `"root"`. */
export type ContainerSessionId = string;

/** Options for submitting a prompt. */
export type ContainerSubmitOptions = {
  /** Default: the root session. */
  readonly session?: ContainerSessionId;
  /** Idempotency key. Submitting the same id twice returns the same receipt. */
  readonly operationId?: string;
  /**
   * What the submission does when the session is already running.
   *
   * - `followUp` (default): answered after the current run, as its own run.
   * - `steer`: joins the running turn, when the adapter can steer;
   *   otherwise it is queued as a follow-up.
   */
  readonly whenBusy?: ContainerWhenBusy;
};

/** Addresses one session. */
export type ContainerSessionOptions = {
  /** Default: the root session. */
  readonly session?: ContainerSessionId;
};

/** Returned once a submission is durable. It says nothing about the model yet. */
export type ContainerReceipt = {
  readonly operationId: string;
  readonly session: ContainerSessionId;
  /** False when this operation id was already submitted. */
  readonly accepted: boolean;
};

/** How one operation ended. */
export type ContainerOperationResult = {
  readonly operationId: string;
  readonly session: ContainerSessionId;
  /** `done`: answered. `unanswered`: failed, aborted, or lost with its container. */
  readonly status: "done" | "unanswered";
  /**
   * Why an unanswered operation ended: the adapter's reason, `aborted`,
   * `container_lost` (its container stopped mid-run), `not_found`, or
   * `container_unavailable` (no container could be started).
   */
  readonly reason?: string;
  /** The final assistant text, when answered. */
  readonly text?: string;
};

/** What `prompt()` returns: the result and the transcript after it. */
export type ContainerPromptResponse = ContainerOperationResult & {
  /** The session's active transcript after the operation. */
  readonly messages: readonly ContainerMessage[];
};

/** A submission that has not settled yet. */
export type ContainerPendingOperation = {
  readonly operationId: string;
  readonly session: ContainerSessionId;
  /** `queued`, or `running` in the container. */
  readonly status: "queued" | "running";
};

/** One session, as `sessions.list()` reports it. */
export type ContainerSessionInfo = {
  readonly id: ContainerSessionId;
  /** The session this one was forked from. */
  readonly parent?: ContainerSessionId;
  readonly busy: boolean;
};

/** Where the container is, as the harness sees it. */
export type ContainerStatus =
  | "starting"
  | "ready"
  /** The container stopped while it had work; that work is reconciled. */
  | "lost"
  /** The container was stopped after it went idle. */
  | "stopped";

/** One event on a session's stream. */
export type ContainerSessionEvent =
  /** What the adapter reported, tagged with its operation. */
  | (ContainerEvent & { readonly operationId: string | null })
  | { readonly type: "operation-start"; readonly operationId: string }
  | {
      readonly type: "operation-end";
      readonly result: ContainerOperationResult;
    }
  | { readonly type: "container"; readonly status: ContainerStatus };

/** The state of a session when a stream starts. */
export type ContainerSessionSnapshot = {
  readonly session: ContainerSessionId;
  readonly messages: readonly ContainerMessage[];
  readonly pending: readonly ContainerPendingOperation[];
  readonly busy: boolean;
};

/**
 * A session's events: the snapshot taken when the stream was opened, then
 * every event after it, in batches, including any that arrived before
 * `start()`. An event may repeat what the snapshot already shows; messages
 * are keyed by id. Live: events reach listeners in the isolate that runs
 * the harness. Call `stop()` when done, started or not.
 */
export type ContainerEventStream = {
  readonly snapshot: ContainerSessionSnapshot;
  /** Start delivering events. Call once. */
  start(listener: (events: readonly ContainerSessionEvent[]) => void): void;
  /** Stop delivering events. */
  stop(): Promise<void>;
};
