/**
 * The compiler from a Workflows-shaped function definition onto the state
 * machine engine, plus the naming rules the two forms share: the
 * turn-scoped idempotency key, the `base@vN` definition name, and the
 * mailbox key a child's settlement note takes in its parent's mailbox.
 *
 * A function definition is not a second engine. It is a machine with one
 * phase whose handler replays the function and settles on its return, and
 * whose checkpoint is a singleton persisted as SQL `NULL` — so its
 * `checkpoint_turn` is 0 forever, its journal keys are today's keys, and
 * its idempotency keys are byte-identical to the ones Tasks has shipped.
 *
 * Everything here is pure: no storage, no clock, no capability.
 */

import type {
  TaskDefinition,
  TaskMachine,
  TaskStep,
  TaskTerminal,
  TaskValue
} from "./types";

/** The one phase every compiled function definition has. */
export const COMPILED_PHASE = "run";

/** The checkpoint of a compiled function definition: a singleton. */
export type TaskFnState = { phase: typeof COMPILED_PHASE };

/**
 * The singleton itself. The engine recognises it and writes `checkpoint =
 * NULL`, which is what the v2 to v3 migration leaves untouched on existing
 * rows and what keeps a function definition's turn at 0.
 */
export const COMPILED_CHECKPOINT: TaskFnState = Object.freeze({
  phase: COMPILED_PHASE
});

/** True when a checkpoint is the compiled function definition's singleton. */
export function isCompiledCheckpoint(checkpoint: unknown): boolean {
  return checkpoint === COMPILED_CHECKPOINT;
}

/** How a terminal was produced, which is what decides the run's state. */
export type TaskTerminalKind = "complete" | "fail" | "aborted";

/**
 * @internal The runtime carrier behind {@link TaskTerminal}. The public type
 * is branded with an unexported symbol, so only `ctx.complete` / `fail` /
 * `aborted` can produce one and a forged `{ done: true }` fails to compile.
 */
export class TaskTerminalSignal {
  readonly kind: TaskTerminalKind;
  readonly result: TaskValue;
  readonly error: unknown;
  readonly reason: string | undefined;

  private constructor(
    kind: TaskTerminalKind,
    parts: { result?: TaskValue; error?: unknown; reason?: string }
  ) {
    this.kind = kind;
    this.result = parts.result;
    this.error = parts.error;
    this.reason = parts.reason;
  }

  static complete(result: TaskValue): TaskTerminalSignal {
    return new TaskTerminalSignal("complete", { result });
  }

  static fail(error: unknown): TaskTerminalSignal {
    return new TaskTerminalSignal("fail", { error });
  }

  static aborted(reason?: string): TaskTerminalSignal {
    return new TaskTerminalSignal("aborted", { reason });
  }
}

/** The terminal a transition returned, or undefined when it returned state. */
export function readTaskTerminal(
  returned: unknown
): TaskTerminalSignal | undefined {
  return returned instanceof TaskTerminalSignal ? returned : undefined;
}

/** Brand one terminal signal as the opaque {@link TaskTerminal} it is. */
export function asTaskTerminal<Result extends TaskValue>(
  signal: TaskTerminalSignal
): TaskTerminal<Result> {
  // SAFETY: `TaskTerminal` is a phantom brand with no runtime shape; the
  // signal is the only value the engine ever reads back out of it.
  return signal as unknown as TaskTerminal<Result>;
}

/**
 * A machine as the engine reads one: `any`-parameterised for the same
 * reason `TaskDefinition`'s machine arm is — every narrower constraint
 * rejects every concrete machine, because a handler's state parameter is
 * contravariant and its return is the state union.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type AnyTaskMachine = TaskMachine<any, any, any, any>;

/** True when a definition is a machine rather than a durable function. */
export function isTaskMachine(
  definition: TaskDefinition
): definition is AnyTaskMachine {
  return (
    typeof definition === "object" &&
    definition !== null &&
    "phases" in definition
  );
}

/**
 * What the compiled phase touches on its runtime: the step surface, the run
 * seed, and one terminal. Naming it keeps the compiled path castless — a
 * `TaskContext` is assignable to it, so the compiled machine still satisfies
 * `TaskMachine`, and the engine can hand the phase the same `ReplayStep` the
 * function itself receives.
 */
export type CompiledTaskContext = TaskStep & {
  readonly input: unknown;
  complete(result: TaskValue): TaskTerminal<TaskValue>;
};

/** The compiled form of a function definition. Satisfies `TaskMachine`. */
export type CompiledTaskFunction = {
  readonly initial: TaskFnState;
  readonly phases: {
    readonly [COMPILED_PHASE]: (
      state: TaskFnState,
      ctx: CompiledTaskContext
    ) => Promise<TaskTerminal<TaskValue>>;
  };
};

/** Compiled machines, keyed by the function they wrap. */
const compiled = new WeakMap<object, CompiledTaskFunction>();

/**
 * Compile one function definition into the single-phase machine the engine
 * runs. The handler is `ctx.complete(await f(ctx.input, ctx))` — `ctx` IS
 * the `step` the function receives, so there is one journal, one claim path
 * and one abort protocol.
 */
export function compileTaskFunction(
  fn: (input: never, step: TaskStep) => TaskValue | Promise<TaskValue>
): CompiledTaskFunction {
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

/**
 * The stable external deduplication key for one named step.
 *
 * A function definition is a single-checkpoint machine whose turn is always
 * 0, and its key form omits the turn segment so it is byte-identical to the
 * key Tasks has always produced. A machine's `do("charge")` in turn 1 and in
 * turn 7 are two engine-intended executions, so their keys differ; a machine
 * that genuinely wants one key across turns asks for `scope: "run"` and gets
 * the string the function form would have produced.
 */
export function taskIdempotencyKey(
  runId: string,
  name: string,
  options: {
    readonly turn: number;
    readonly compiled: boolean;
    readonly scope?: "turn" | "run";
  }
): string {
  if (options.compiled || options.scope === "run") return `${runId}:${name}`;
  return `${runId}:t${options.turn}:${name}`;
}

/** The mailbox `kind` a child's settlement note carries to its parent. */
export const CHILD_MAILBOX_KIND = "child";

/**
 * The mailbox key one child's settlement note takes in its parent's
 * mailbox. Keyed by the child rather than by arrival order, so a child that
 * settles twice — a retried notify, a re-delivered route — collapses onto
 * one row through the mailbox's `ON CONFLICT (run_id, key) DO NOTHING`, and
 * so the delete cascade can find and remove that one row by primary key
 * when the child is deleted.
 */
export function childMailboxKey(childRunId: string): string {
  return `${CHILD_MAILBOX_KIND}:${childRunId}`;
}

/** A definition name split into its base and its version. */
export type TaskDefinitionName = {
  /** The name with any `@vN` suffix removed. */
  readonly base: string;
  /** The version, or 0 when the name carries none. */
  readonly version: number;
};

const VERSIONED_NAME = /^(.+)@v(\d+)$/;

/**
 * Split a definition name into `base` and version. The split is on the LAST
 * `@v` followed only by digits, and only for a positive version — anything
 * else is part of the base, so a name is never accidentally versioned.
 */
export function parseDefinitionName(name: string): TaskDefinitionName {
  const match = VERSIONED_NAME.exec(name);
  if (!match) return { base: name, version: 0 };
  const [, base = "", digits = ""] = match;
  const version = Number(digits);
  if (!Number.isSafeInteger(version) || version <= 0) {
    return { base: name, version: 0 };
  }
  return { base, version };
}
