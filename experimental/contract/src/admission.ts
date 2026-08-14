/**
 * admission — the one policy point between "an entry was committed" and "a
 * turn does work". Replaces the separate entry paths (WS request, RPC chat,
 * turn invocation, submissions drain, scheduled tasks, workflow notices,
 * auto-continuation) with a single question asked once per trigger entry:
 * start a turn, resume one, queue, merge, preempt, or ignore?
 *
 * Auto-continuation stops being a subsystem here: a client tool result or an
 * approval verdict landing on the log is just another trigger entry, and
 * "resume" is the decision to wake the parked turn it correlates with.
 *
 * Pure decision logic — no timers, no storage, no execution. The runtime
 * enforces the decision. decide() may be re-invoked for the same entry after
 * a crash (residue 2); same inputs must give the same answer.
 *
 * Allowed imports: kernel, transcript.
 */

import type { TurnId, TurnInfo } from "./kernel.js";
import type { Entry, Query } from "./transcript.js";

export interface AdmissionInput {
  readonly entry: Entry;
  /** The currently active or parked turn on this branch, if any. */
  readonly active?: TurnInfo;
  readonly queued: readonly TurnInfo[];
}

export type AdmissionDecision =
  /** Begin a new turn triggered by this entry. */
  | { readonly action: "start" }
  /** Wake this parked turn — the entry is the signal it was waiting for. */
  | { readonly action: "resume"; readonly turn: TurnId }
  /** Hold until the active turn reaches quiescence. */
  | { readonly action: "queue" }
  /** Fold into an already-queued turn (message merging). */
  | { readonly action: "merge"; readonly into: TurnId }
  /** Abort the active turn and start over (latest-wins). */
  | { readonly action: "preempt" }
  /** Not a trigger; no turn implications. */
  | { readonly action: "ignore" };

export interface AdmissionPolicy {
  /** Pre-filter: which entry kinds are even trigger candidates. */
  readonly triggers: Pick<Query, "kinds">;
  decide(input: AdmissionInput): AdmissionDecision;
}
