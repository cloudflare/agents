import type { Streams } from "../streams";
import { createMachineCommitParticipant } from "./commit";
import type { MachineCommitParticipant } from "./types";

/** Settle a live stream in the same transaction as a Machine decision. */
export function settleStreamOnMachineCommit(
  streams: Streams,
  streamId: string,
  state: "completed" | "errored" = "completed",
  reason: string | null = null
): MachineCommitParticipant {
  return createMachineCommitParticipant((transaction) => {
    streams
      .__DO_NOT_USE_WILL_BREAK__sync()
      .settleInTransaction(streamId, state, reason, transaction.afterCommit);
  });
}
