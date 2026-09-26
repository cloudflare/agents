import type {
  MachineCommitParticipant,
  MachineCommitTransaction
} from "./types";

type CommitBlock = (transaction: MachineCommitTransaction) => void;

const participants = new WeakMap<object, CommitBlock>();

/** @internal Create a branded participant for one synchronous machine commit. */
export function createMachineCommitParticipant(
  commit: CommitBlock
): MachineCommitParticipant {
  const participant = Object.freeze({
    __brand: "MachineCommitParticipant" as const
  });
  participants.set(participant, commit);
  return participant;
}

export function applyMachineCommitParticipant(
  participant: MachineCommitParticipant,
  transaction: MachineCommitTransaction
): void {
  const commit = participants.get(participant);
  if (!commit) throw new Error("Invalid Machine commit participant");
  commit(transaction);
}
