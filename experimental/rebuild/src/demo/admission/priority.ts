/**
 * DEMO MODULE — AdmissionPolicy, the practical one.
 *
 * Priority lanes: admission is source-aware, which no per-channel config
 * could express. A message from the pager channel preempts whatever is
 * running; ordinary users queue politely; parked turns resume when their
 * settlement or approval verdict lands. The whole policy is one pure
 * decide() — the runtime enforces it.
 */

import type { AdmissionPolicy, MessagePayload } from "../../contract.js";

export interface PriorityOptions {
  /** Channel instances whose messages abort the active turn (latest-wins). */
  readonly preempt?: readonly string[];
}

export function priorityLanes(opts: PriorityOptions = {}): AdmissionPolicy {
  const preempt = new Set(opts.preempt ?? []);
  return {
    triggers: {
      kinds: ["message", "effect/settled", "tools/approval-verdict"]
    },
    decide({ entry, active }) {
      const kind = entry.payload.kind;

      // A settlement or verdict stamped with the parked turn's id wakes it.
      if (kind === "effect/settled" || kind === "tools/approval-verdict") {
        if (active?.status === "parked" && entry.turn === active.turnId) {
          return { action: "resume", turn: active.turnId };
        }
        return { action: "ignore" };
      }

      // Only externally-originated user messages start work.
      const message = entry.payload as MessagePayload;
      if (message.role !== "user" || entry.origin.module === "harness") {
        return { action: "ignore" };
      }
      if (active === undefined) return { action: "start" };
      if (
        entry.origin.instance !== undefined &&
        preempt.has(entry.origin.instance)
      ) {
        return { action: "preempt" };
      }
      return { action: "queue" };
    }
  };
}
