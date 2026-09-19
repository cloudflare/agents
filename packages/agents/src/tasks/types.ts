/**
 * The `agents/tasks` vocabulary: every engine type under the `Task` name it
 * shipped with, plus the durable-function form only this layer knows.
 * `agents/state-machine` is the engine; a task run and a state-machine run
 * are the same row.
 *
 * @experimental The whole `agents/tasks` surface may change before
 * stabilizing.
 */

import type {
  StateMachineDeleteOptions,
  StateMachineListOptions
} from "../state-machine/state-machine";
import type {
  StateMachineDurationString,
  StateMachineDurationUnit
} from "../state-machine/duration";
import type {
  StateMachineEventType,
  StateMachineFailedRun,
  StateMachineOptions
} from "../state-machine/options";
import type {
  AnyStateMachineDefinition,
  StateMachineAbortMark,
  StateMachineAnswerReceipt,
  StateMachineAskOptions,
  StateMachineAskRecord,
  StateMachineAskState,
  StateMachineChange,
  StateMachineChangeType,
  StateMachineChildRef,
  StateMachineChildResult,
  StateMachineContext,
  StateMachineDefinition,
  StateMachineError,
  StateMachineHandle,
  StateMachineInput,
  StateMachineInternalHandle,
  StateMachineJson,
  StateMachineMailbox,
  StateMachineMailboxFilter,
  StateMachineMailboxItem,
  StateMachineOutput,
  StateMachinePhased,
  StateMachineReceipt,
  StateMachineRetryConfig,
  StateMachineRunHandle,
  StateMachineRunOptions,
  StateMachineRunOutcome,
  StateMachineRunSnapshot,
  StateMachineRunState,
  StateMachineRunView,
  StateMachineSendOptions,
  StateMachineSendReceipt,
  StateMachineSpawnOptions,
  StateMachineStartMode,
  StateMachineState,
  StateMachineStep,
  StateMachineStepAttempt,
  StateMachineStepConfig,
  StateMachineStepEvent,
  StateMachineStreamOptions,
  StateMachineTerminal,
  StateMachineTimedOut,
  StateMachineValue,
  StateMachineWaitReason
} from "../state-machine/types";

export type { AskKind, AssertJson, Pending } from "../state-machine/types";

// ── Values ────────────────────────────────────────────────────────────────

export type TaskJson = StateMachineJson;
export type TaskValue = StateMachineValue;
export type TaskPhased = StateMachinePhased;
export type TaskTerminal<Result extends TaskValue> =
  StateMachineTerminal<Result>;
export type TaskTimedOut = StateMachineTimedOut;
export type TaskDurationUnit = StateMachineDurationUnit;
export type TaskDurationString = StateMachineDurationString;

// ── Definitions ───────────────────────────────────────────────────────────

/**
 * Today's Workflows-shaped durable function. The input parameter is `never`
 * so any concretely-typed definition satisfies the constraint under
 * contravariance; each definition's real input type is recovered with
 * {@link TaskInput}.
 */
export type TaskFunction = (
  input: never,
  step: TaskStep
) => TaskValue | Promise<TaskValue>;

/** The machine form, as declared with `satisfies TaskMachine<...>`. */
export type TaskMachine<
  State extends TaskPhased,
  Mailbox = never,
  Result extends TaskValue = void,
  Seed = void
> = StateMachineDefinition<State, Mailbox, Result, Seed>;

/**
 * One named, versioned durable program: either a durable function or a
 * durable state machine. Both run on one engine.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskDefinition = TaskFunction | AnyStateMachineDefinition;

/**
 * Constraint for a Tasks definitions map. The map is the registry, rebuilt
 * on every Durable Object wake, so in-flight runs always resolve their
 * persisted definition names.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskDefinitions = Record<string, TaskDefinition>;

/**
 * Back-compat alias: the function-only constraint Tasks shipped with. Named
 * handlers invoked from the beginning on every execution attempt, with
 * completed steps returning journaled results instead of running again. An
 * unclean interruption — process loss mid-attempt — replays the handler the
 * same way; durable progress lives in the step journal and in whatever
 * durable state the handler wrote, so handlers resume from evidence instead
 * of receiving a recovery callback.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskHandlers = Record<string, TaskFunction>;

/**
 * Default definitions surface for a Tasks constructed without a typed map:
 * any name compiles with an untyped input. At runtime a name must be
 * declared in the constructor map or supplied by a composition-root
 * resolver; a bare Tasks rejects it otherwise.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TaskCallbacks = Record<
  string,
  (input: unknown, step: TaskStep) => TaskValue | Promise<TaskValue>
>;

export type TaskInput<Definition> = StateMachineInput<Definition>;
export type TaskState<Definition> = StateMachineState<Definition>;
export type TaskOutput<Definition> = StateMachineOutput<Definition>;
export type TaskMailbox<Definition> = StateMachineMailbox<Definition>;

// ── The per-handler runtime ───────────────────────────────────────────────

export type TaskStep = StateMachineStep;
export type TaskStepConfig = StateMachineStepConfig;
export type TaskRetryConfig = StateMachineRetryConfig;
export type TaskStepAttempt = StateMachineStepAttempt;
export type TaskStepEvent<Payload> = StateMachineStepEvent<Payload>;
export type TaskContext<
  State extends TaskPhased,
  Mailbox = never,
  Result extends TaskValue = void,
  Seed = void
> = StateMachineContext<State, Mailbox, Result, Seed>;
export type TaskAbortMark = StateMachineAbortMark;
export type TaskMailboxItem<Payload = TaskJson> =
  StateMachineMailboxItem<Payload>;
export type TaskMailboxFilter = StateMachineMailboxFilter;
export type TaskChildRef = StateMachineChildRef;
export type TaskChildResult<Output extends TaskValue> =
  StateMachineChildResult<Output>;
export type TaskStreamOptions = StateMachineStreamOptions;
export type TaskAskState = StateMachineAskState;
export type TaskAskOptions = StateMachineAskOptions;
export type TaskAskRecord = StateMachineAskRecord;

// ── Runs ──────────────────────────────────────────────────────────────────

export type TaskRunState = StateMachineRunState;
export type TaskRunOutcome = StateMachineRunOutcome;
export type TaskWaitReason = StateMachineWaitReason;
export type TaskError = StateMachineError;
export type TaskStartMode = StateMachineStartMode;
export type TaskRunOptions = StateMachineRunOptions;
export type TaskSpawnOptions = StateMachineSpawnOptions;
export type TaskReceipt = StateMachineReceipt;
export type TaskRunSnapshot<Output extends TaskValue> =
  StateMachineRunSnapshot<Output>;
export type TaskRunView<
  Output extends TaskValue,
  State = unknown
> = StateMachineRunView<Output, State>;
export type TaskChangeType = StateMachineChangeType;
export type TaskChange<State = unknown> = StateMachineChange<State>;
export type TaskSendOptions = StateMachineSendOptions;
export type TaskSendReceipt = StateMachineSendReceipt;
export type TaskAnswerReceipt = StateMachineAnswerReceipt;
export type TaskEventType = StateMachineEventType;
export type TaskFailedRun = StateMachineFailedRun;
export type TaskListOptions = StateMachineListOptions;
export type TaskDeleteOptions = StateMachineDeleteOptions;

// ── Handles ───────────────────────────────────────────────────────────────

export type TaskHandle<
  Definition,
  Input,
  State,
  Output extends TaskValue
> = StateMachineHandle<Definition, Input, State, Output>;

/**
 * Back-compat alias for the lens shape Tasks shipped with: an untyped
 * definition, so the three machine verbs read `never` on it — the honest
 * answer for a lens that does not know its definition's shape.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type Task<Input, Output extends TaskValue> = TaskHandle<
  unknown,
  Input,
  unknown,
  Output
>;

export type TaskRunHandle<Definition> = StateMachineRunHandle<Definition>;
export type TaskInternalHandle = StateMachineInternalHandle;

/**
 * Definitions and policy for a Tasks capability: the engine's options with
 * a definitions map that may hold durable functions as well as machines.
 *
 * @experimental The API surface may change before stabilizing.
 */
export type TasksOptions<Definitions extends TaskDefinitions = TaskCallbacks> =
  Omit<StateMachineOptions<Definitions>, "definitions"> & {
    readonly definitions?: Definitions;
  };
