/**
 * Default AdmissionPolicy:
 * - a user message starts a turn, or queues behind the active one;
 * - an effect settlement or approval verdict stamped with a parked turn's id
 *   resumes that turn (auto-continuation as an admission decision);
 * - everything else is ignored.
 *
 * Pure and re-runnable: same inputs, same answer.
 */

import type {
  AdmissionDecision,
  AdmissionInput,
  AdmissionPolicy,
  MessagePayload
} from "../contract";

const TRIGGER_KINDS = [
  "message",
  "effect/settled",
  "tools/approval-verdict"
] as const;

export function defaultAdmission(): AdmissionPolicy {
  return {
    triggers: { kinds: [...TRIGGER_KINDS] },
    decide(input: AdmissionInput): AdmissionDecision {
      const { entry, active } = input;
      const kind = entry.payload.kind;

      if (kind === "message") {
        const payload = entry.payload as MessagePayload;
        // Only externally-originated user messages are triggers; the
        // harness's own tool-result carrier messages are bookkeeping.
        if (payload.role !== "user" || entry.origin.module === "harness") {
          return { action: "ignore" };
        }
        if (active === undefined) return { action: "start" };
        return { action: "queue" };
      }

      // Settlements and verdicts wake the parked turn they belong to.
      if (kind === "effect/settled" || kind === "tools/approval-verdict") {
        if (
          active !== undefined &&
          active.status === "parked" &&
          entry.turn === active.turnId
        ) {
          return { action: "resume", turn: active.turnId };
        }
        return { action: "ignore" };
      }

      return { action: "ignore" };
    }
  };
}
