/**
 * The compiler from a Workflows-shaped durable function onto the state
 * machine engine. A function definition is not a second engine: it is a
 * machine with one phase whose handler replays the function and settles on
 * its return, and whose checkpoint is the engine's single-turn sentinel —
 * persisted as SQL `NULL`, so its `checkpoint_turn` is 0 forever, its
 * journal keys are today's keys, and its idempotency keys are byte-identical
 * to the ones Tasks has shipped.
 *
 * Everything here is pure: no storage, no clock, no capability.
 */

import {
  COMPILED_CHECKPOINT,
  COMPILED_PHASE,
  type TaskFnState
} from "../state-machine/machine";
import type {
  AnyStateMachineDefinition,
  StateMachineDefinitions,
  StateMachineStep,
  StateMachineTerminal,
  StateMachineValue
} from "../state-machine/types";
import type { TaskDefinition, TaskDefinitions, TaskFunction } from "./types";

/**
 * What the compiled phase touches on its runtime: the step surface, the run
 * seed, and one terminal. Naming it keeps the compiled path castless — a
 * `StateMachineContext` is assignable to it, so the compiled machine still
 * satisfies `StateMachineDefinition`, and the engine can hand the phase the
 * same context the function itself receives as `step`.
 */
export type CompiledTaskContext = StateMachineStep & {
  readonly input: unknown;
  complete(result: StateMachineValue): StateMachineTerminal<StateMachineValue>;
};

/** The compiled form of a function definition. Satisfies `StateMachineDefinition`. */
export type CompiledTaskFunction = {
  readonly initial: TaskFnState;
  readonly phases: {
    readonly [COMPILED_PHASE]: (
      state: TaskFnState,
      ctx: CompiledTaskContext
    ) => Promise<StateMachineTerminal<StateMachineValue>>;
  };
};

/** Compiled machines, keyed by the function they wrap. */
const compiled = new WeakMap<object, CompiledTaskFunction>();

/** True when a definition is a durable function rather than a machine. */
export function isTaskFunction(
  definition: TaskDefinition
): definition is TaskFunction {
  return typeof definition === "function";
}

/**
 * Compile one function definition into the single-phase machine the engine
 * runs. The handler is `ctx.complete(await f(ctx.input, ctx))` — `ctx` IS
 * the `step` the function receives, so there is one journal, one claim path
 * and one abort protocol. Compiling the same function twice yields the same
 * machine, so a definition map rebuilt on every wake resolves identically.
 */
export function compileTaskFunction(fn: TaskFunction): CompiledTaskFunction {
  const existing = compiled.get(fn);
  if (existing) return existing;
  const machine: CompiledTaskFunction = {
    initial: COMPILED_CHECKPOINT,
    phases: {
      [COMPILED_PHASE]: async (_state, ctx) =>
        // SAFETY: the function's declared input is erased to `never` by the
        // definitions constraint so concrete definitions satisfy it under
        // contravariance; the value came from the row this definition's own
        // name was persisted with.
        ctx.complete(await fn(ctx.input as never, ctx))
    }
    // No `onCancel`: a function definition gets the inline default cancel,
    // which is what keeps `cancel()` settling synchronously.
    // No `migrate`: a function definition's checkpoint carries no shape.
  };
  compiled.set(fn, machine);
  return machine;
}

/** The machine the engine runs for one Tasks definition of either form. */
export function toStateMachineDefinition(
  definition: TaskDefinition
): AnyStateMachineDefinition {
  return isTaskFunction(definition)
    ? compileTaskFunction(definition)
    : definition;
}

/** Compile a Tasks definitions map into the engine's machine-only map. */
export function compileTaskDefinitions(
  definitions: TaskDefinitions | undefined
): StateMachineDefinitions {
  const machines: Record<string, AnyStateMachineDefinition> = {};
  for (const [name, definition] of Object.entries(definitions ?? {})) {
    machines[name] = toStateMachineDefinition(definition);
  }
  return machines;
}
