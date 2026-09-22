import type { MachineCommitParticipant } from "./types";

type PreparedCommit = {
  readonly apply: () => void;
  readonly committed?: () => void;
};

const participants = new WeakMap<object, PreparedCommit>();

/** @internal Create a branded participant for one synchronous machine commit. */
export function createMachineCommitParticipant(
  apply: () => void,
  committed?: () => void
): MachineCommitParticipant {
  const participant = Object.freeze({
    __brand: "MachineCommitParticipant" as const
  });
  participants.set(participant, { apply, committed });
  return participant;
}

export function applyMachineCommitParticipant(
  participant: MachineCommitParticipant
): void {
  const prepared = participants.get(participant);
  if (!prepared) throw new Error("Invalid Machine commit participant");
  prepared.apply();
}

export function publishMachineCommitParticipant(
  participant: MachineCommitParticipant
): void {
  participants.get(participant)?.committed?.();
}
