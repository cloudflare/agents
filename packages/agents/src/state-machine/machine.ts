/**
 * The naming rules every definition shares — the turn-scoped idempotency
 * key, the `base@vN` definition name, the mailbox key a child's settlement
 * note takes in its parent's mailbox — plus the terminal signal a
 * transition returns and the single-turn checkpoint sentinel.
 *
 * A durable function (`agents/tasks`) is not a second engine. It compiles to
 * a machine with one phase whose handler replays the function and settles
 * on its return, and whose checkpoint is the sentinel below, persisted as
 * SQL `NULL` — so its `checkpoint_turn` is 0 forever, its journal keys are
 * today's keys, and its idempotency keys are byte-identical to the ones
 * Tasks has shipped. The compiler itself lives beside `Tasks`; the engine
 * only recognises the sentinel.
 *
 * Everything here is pure: no storage, no clock, no capability.
 */

import type {
  StateMachinePhased,
  StateMachineTerminal,
  StateMachineTimedOut,
  StateMachineValue
} from "./types";

/**
 * The one value every `within` wait returns on expiry. A unique symbol at
 * runtime — never JSON, so it cannot leak into a checkpoint — carried as
 * the phantom unit type the context declares.
 */
// SAFETY: the type is a phantom `unique symbol`; this is its runtime carrier.
export const TIMED_OUT: StateMachineTimedOut = Symbol(
  "agents:state-machine:timed-out"
) as unknown as StateMachineTimedOut;

/**
 * The phase a checkpoint names. Every machine checkpoint is an object with
 * a string `phase`; anything else is a definition bug, reported as the
 * application error it is rather than dispatched as a phase named
 * `undefined`.
 */
export function phaseOf(checkpoint: unknown): string {
  if (
    typeof checkpoint === "object" &&
    checkpoint !== null &&
    typeof (checkpoint as Partial<StateMachinePhased>).phase === "string"
  ) {
    return (checkpoint as StateMachinePhased).phase;
  }
  throw new Error(
    "A state machine checkpoint must be an object with a string `phase`"
  );
}

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
 * @internal The runtime carrier behind {@link StateMachineTerminal}. The public type
 * is branded with an unexported symbol, so only `ctx.complete` / `fail` /
 * `aborted` can produce one and a forged `{ done: true }` fails to compile.
 */
export class TaskTerminalSignal {
  readonly kind: TaskTerminalKind;
  readonly result: StateMachineValue;
  readonly error: unknown;
  readonly reason: string | undefined;

  private constructor(
    kind: TaskTerminalKind,
    parts: { result?: StateMachineValue; error?: unknown; reason?: string }
  ) {
    this.kind = kind;
    this.result = parts.result;
    this.error = parts.error;
    this.reason = parts.reason;
  }

  static complete(result: StateMachineValue): TaskTerminalSignal {
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

/** Brand one terminal signal as the opaque {@link StateMachineTerminal} it is. */
export function asTaskTerminal<Result extends StateMachineValue>(
  signal: TaskTerminalSignal
): StateMachineTerminal<Result> {
  // SAFETY: `StateMachineTerminal` is a phantom brand with no runtime shape; the
  // signal is the only value the engine ever reads back out of it.
  return signal as unknown as StateMachineTerminal<Result>;
}

/**
 * The stable external deduplication key for one named step.
 *
 * A function definition is a single-checkpoint machine whose turn is always
 * 0, and its key form omits the turn segment so it is byte-identical to the
 * key StateMachine has always produced. A machine's `do("charge")` in turn 1 and in
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
