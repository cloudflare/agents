/**
 * `Tasks`: the durable-function layer over the state machine engine. A
 * `Tasks` IS a `StateMachine` — same tables, same wake stream, same handles
 * — that additionally accepts today's Workflows-shaped `(input, step) =>
 * result` definitions, compiling each onto the engine as a single-phase
 * machine before it is registered.
 *
 * @experimental The whole `agents/tasks` surface may change before
 * stabilizing.
 */

import type { LifecycleCapability } from "../lifecycle/capability";
import {
  StateMachine,
  setStateMachineDefinitionResolver
} from "../state-machine/state-machine";
import { compileTaskDefinitions, toStateMachineDefinition } from "./compile";
import type { StateMachineDefinitions } from "../state-machine/types";
import type {
  TaskCallbacks,
  TaskDefinition,
  TaskDefinitions,
  TaskInternalHandle,
  TasksOptions
} from "./types";

export { setStateMachineRoutedMemoryLimitHandler as setTaskRoutedMemoryLimitHandler } from "../state-machine/state-machine";
export type { TaskDeleteOptions, TaskListOptions } from "./types";

/** A composition-root hook resolving definition names lazily. */
export type TaskDefinitionResolver = (
  name: string
) => TaskDefinition | undefined;

/**
 * @internal Install a lazy definition resolver on a Tasks instance. The
 * resolver may return either form; a durable function is compiled on the
 * way in, and compiling the same function twice yields the same machine.
 */
export function setTaskDefinitionResolver(
  tasks: LifecycleCapability,
  resolver: TaskDefinitionResolver
): void {
  setStateMachineDefinitionResolver(tasks, (name) => {
    const definition = resolver(name);
    return definition === undefined
      ? undefined
      : toStateMachineDefinition(definition);
  });
}

/**
 * Durable replayable execution for Lifecycle Objects: the state machine
 * engine plus the durable-function form. Declare definitions in the
 * constructor map (or a host's overridable `taskDefinitions` field) and
 * start runs with `run(name, input, options)`.
 *
 * @experimental The API surface may change before stabilizing.
 */
export class Tasks<
  Definitions extends TaskDefinitions = TaskCallbacks
> extends StateMachine<Definitions> {
  constructor(options: TasksOptions<Definitions> = {}) {
    const { definitions, ...engine } = options;
    super({
      ...engine,
      // SAFETY: the compiled map has exactly the declared names, each entry
      // the machine its definition runs as; the shapes the engine types
      // `run()` and the handles by are the declared ones.
      definitions: compileTaskDefinitions(definitions) as Definitions &
        StateMachineDefinitions
    });
  }

  /**
   * @internal Framework aperture: register one reserved (`__cf`-prefixed)
   * definition of either form. See {@link StateMachine.register}.
   */
  override register(
    name: string,
    definition: TaskDefinition
  ): TaskInternalHandle {
    return super.register(name, toStateMachineDefinition(definition));
  }
}
