import type {
  MachineDefinition,
  MachineEvent,
  MachinePhased,
  MachineValue
} from "./types";

/** Preserve a definition's inferred input, state, output, and event types. */
export function defineMachine<
  State extends MachinePhased,
  Result extends MachineValue = void,
  Input extends MachineValue = undefined,
  Event extends MachineEvent = MachineEvent
>(
  definition: MachineDefinition<State, Result, Input, Event>
): MachineDefinition<State, Result, Input, Event> {
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new Error("Machine definition versions must be integers >= 1");
  }
  return definition;
}

/** Define a typed, correlated gate kind. */
export function defineGate<
  Payload extends import("./types").MachineJson,
  Answer extends import("./types").MachineJson
>(name: string): import("./types").GateKind<Payload, Answer> {
  if (name.length === 0) throw new Error("Gate kind names must be non-empty");
  return Object.freeze({ name });
}
