import type { MachineDefinition, MachinePhased, MachineValue } from "./types";

/** Preserve a definition's inferred input, state, and output types. */
export function defineMachine<
  State extends MachinePhased,
  Result extends MachineValue = void,
  Input extends MachineValue = undefined
>(
  definition: MachineDefinition<State, Result, Input>
): MachineDefinition<State, Result, Input> {
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new Error("Machine definition versions must be integers >= 1");
  }
  return definition;
}
