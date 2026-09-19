import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  Tasks,
  defineAsk,
  NonRetryableError,
  TaskCancelCannotParkError,
  TaskCheckpointTooLargeError,
  TaskConcurrentParkError,
  TaskDeadlineExceededError,
  TaskEventTimeoutError,
  TaskInterruptionsExhaustedError,
  TaskMailboxFullError,
  TaskNoProgressError,
  TaskOrphanedDefinitionError,
  TaskSerializationError,
  TaskTransitionBudgetError,
  TaskTurnDeadlineExceededError,
  type AssertJson,
  type Pending,
  type Task,
  type TaskDefinitions,
  type TaskHandle,
  type TaskInput,
  type TaskInternalHandle,
  type TaskMachine,
  type TaskJson,
  type TaskMailbox,
  type TaskOutput,
  type TaskPhased,
  type TaskReceipt,
  type TaskRetryConfig,
  type TaskRunSnapshot,
  type TaskRunView,
  type TaskSendReceipt,
  type TaskState,
  type TaskStep,
  type TaskValue
} from "../tasks";

class ReportObject extends DurableObject {
  readonly tasks = new Tasks({
    definitions: {
      report: async (input: { topic: string }, step: TaskStep) => {
        // Input and step are typed at the definition site.
        input.topic satisfies string;
        const size = await step.do("measure", () => input.topic.length);
        size satisfies number;
        await step.sleep("cool-off", "10 seconds");
        return { key: `report-${size}` };
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.tasks);
}

declare const object: ReportObject;
object.tasks satisfies DurableObjectCapability;

// Declared definitions type both the name and the input where runs start.
object.tasks.run("report", { topic: "chips" }) satisfies Promise<TaskReceipt>;
object.tasks.run(
  "report",
  { topic: "chips" },
  { idempotencyKey: "report:1", retain: false }
) satisfies Promise<TaskReceipt>;
// A run bounds its own interruption replays and its wall-clock lifetime.
object.tasks.run(
  "report",
  { topic: "chips" },
  {
    interruptions: { limit: 3, delay: "30 seconds", backoff: "exponential" },
    deadline: Date.now() + 60_000
  }
) satisfies Promise<TaskReceipt>;
object.tasks.run(
  "report",
  { topic: "chips" },
  { deadline: new Date() }
) satisfies Promise<TaskReceipt>;
object.tasks.run(
  "report",
  { topic: "chips" },
  {
    // @ts-expect-error durations use second/minute/hour/day/week units.
    interruptions: { delay: "5 parsecs" }
  }
);
// One shape spans both sides, so a step config and a run policy cannot
// drift apart.
({ limit: 2, delay: 500, backoff: "linear" }) satisfies TaskRetryConfig;
// @ts-expect-error the input shape is checked against the declared handler.
object.tasks.run("report", { subject: "chips" });
// @ts-expect-error missingDefinition is not a declared definition.
object.tasks.run("missingDefinition", {});

// A handle is a typed lens scoped to one declared definition.
const report = object.tasks.handle("report");
report satisfies Task<{ topic: string }, { key: string }>;
report.run({ topic: "chips" }) satisfies Promise<TaskReceipt>;
report.get("task_x") satisfies Promise<TaskRunSnapshot<{
  key: string;
}> | null>;
// @ts-expect-error unknownDefinition is not a declared definition.
object.tasks.handle("unknownDefinition");

// Manager-level reads span definitions and widen the output.
object.tasks.get("task_x") satisfies Promise<TaskRunSnapshot<TaskValue> | null>;
object.tasks.cancel("task_x", "done") satisfies Promise<boolean>;
// Cancelling can await terminality rather than acceptance.
object.tasks.cancel("task_x", "done", {
  wait: true
}) satisfies Promise<boolean>;
object.tasks
  .at("report", "task_x")
  .cancel("done", { wait: true }) satisfies Promise<boolean>;

// `register()` hands back the one handle that starts a reserved name, and
// that handle is what carries `start` for framework-internal runs.
const internal: TaskInternalHandle = object.tasks.register(
  "__cf_internal_probe",
  async (_input: unknown, innerStep: TaskStep) => {
    await innerStep.sleep("nap", "1 second");
  }
);
internal.name satisfies string;
internal.run(
  { any: "input" },
  {
    start: "attached"
  }
) satisfies Promise<TaskReceipt>;
internal.run() satisfies Promise<TaskReceipt>;

// Handlers with idempotent external writes carry replay safety themselves.
const guarded = new Tasks({
  definitions: {
    payment: async (input: { orderId: string }, step: TaskStep) => {
      const captured = await step.do("capture", ({ idempotencyKey }) => {
        idempotencyKey satisfies string;
        return input.orderId.length;
      });
      return { captured };
    }
  }
});
guarded.run("payment", { orderId: "o-1" }) satisfies Promise<TaskReceipt>;
guarded.handle("payment") satisfies Task<
  { orderId: string },
  { captured: number }
>;
// @ts-expect-error the input shape is checked here too.
guarded.run("payment", { orderId: 1 });

// A Tasks constructed without definitions is string-typed: any name
// compiles, and names resolve at runtime against the declared map or a
// composition-root resolver.
const untypedTasks = new Tasks();
untypedTasks.run("anyDefinitionName", {
  free: true
}) satisfies Promise<TaskReceipt>;

// Step typing stands alone.
declare const step: TaskStep;
step.interrupted satisfies { name: string; attempt: number } | null;
step.attempt satisfies number;
// The attempt-wide signal, distinct from the per-callback one below.
step.signal satisfies AbortSignal;
step.do("typed", () => ({ a: 1 })) satisfies Promise<{ a: number }>;
step.do(
  "configured",
  { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } },
  ({ attempt, idempotencyKey, signal }) => {
    attempt satisfies number;
    idempotencyKey satisfies string;
    signal satisfies AbortSignal;
    return null;
  }
) satisfies Promise<null>;
step.sleep("nap", "5 minutes") satisfies Promise<void>;
step.sleepUntil("deadline", new Date()) satisfies Promise<void>;
// @ts-expect-error durations use second/minute/hour/day/week units.
step.sleep("bad", "5 parsecs");
// @ts-expect-error step results must be JSON-serializable values.
step.do("function-result", () => () => {});

new NonRetryableError("stop") satisfies Error;
new TaskInterruptionsExhaustedError("task_x", 3) satisfies Error;
new TaskInterruptionsExhaustedError("task_x", 3).interruptions satisfies number;
new TaskDeadlineExceededError("task_x", Date.now()) satisfies Error;

// Every error the machine engine can raise, constructed the way the engine
// constructs it: the signatures and the fields a host reads off them are
// public surface, so they are pinned here rather than left to the one
// caller that happens to build each.
const noProgress = new TaskNoProgressError("task_x", "idle", 3);
noProgress satisfies Error;
noProgress.runId satisfies string;
noProgress.phase satisfies string;
noProgress.stallLimit satisfies number;

const budget = new TaskTransitionBudgetError("task_x", 1_000, ["idle", "turn"]);
budget satisfies Error;
budget.transitions satisfies number;
budget.phases satisfies readonly string[];

const turnDeadline = new TaskTurnDeadlineExceededError("task_x", Date.now());
turnDeadline satisfies Error;
turnDeadline.deadline satisfies number;

const cannotPark = new TaskCancelCannotParkError("receive");
cannotPark satisfies Error;
cannotPark.member satisfies string;

const concurrent = new TaskConcurrentParkError("receive", "answers");
concurrent satisfies Error;
concurrent.pending satisfies string;
concurrent.member satisfies string;

const eventTimeout = new TaskEventTimeoutError("await-approval", "approval");
eventTimeout satisfies Error;
eventTimeout.stepName satisfies string;
eventTimeout.eventType satisfies string;

const mailboxFull = new TaskMailboxFullError("task_x", 1_000);
mailboxFull satisfies Error;
mailboxFull.limit satisfies number;

// The subclass relationship is the contract: a host catching the
// serialization error already catches an oversized checkpoint.
const tooLarge = new TaskCheckpointTooLargeError("checkpoint", 1_024, 512);
tooLarge satisfies TaskSerializationError;
tooLarge.bytes satisfies number;
tooLarge.limit satisfies number;

const orphaned = new TaskOrphanedDefinitionError("chat", 2, "not registered");
orphaned satisfies Error;
orphaned.definition satisfies string;
orphaned.version satisfies number;

// ── The machine form ─────────────────────────────────────────────────────

/** Exact type equality: `unknown` is assignable from anything, so a loose
 *  `satisfies` check would pass where an extractor silently widened. */
type Exact<Expected, Actual> =
  (<T>() => T extends Expected ? 1 : 2) extends <T>() => T extends Actual
    ? 1
    : 2
    ? true
    : false;

type ChatSeed = { conversationId: string };
type ChatMessage = { text: string };
type Decision = { approved: boolean; note?: string };

const Approve = defineAsk<{ toolCallId: string }, Decision>("tool-approval");

type Chat =
  | { phase: "idle"; turnSeq: number }
  | { phase: "turn"; input: string; turnSeq: number }
  | { phase: "awaiting"; turnSeq: number; asks: Pending<Decision>[] };

// Probe 4 of the RFC's table: `satisfies` at the definition site gives
// per-phase narrowing, exhaustiveness, and unknown-key rejection.
const chat = {
  initial: (_seed: ChatSeed): Chat => ({ phase: "idle", turnSeq: 0 }),
  phases: {
    idle: async (state, ctx) => {
      // The state parameter narrows to THIS phase.
      state.turnSeq satisfies number;
      // @ts-expect-error `input` belongs to the `turn` phase, not `idle`.
      state.input;
      const message = await ctx.receive({ kind: "message", within: "1 hour" });
      // The timeout arrives as a unit-typed value, and `===` narrows it.
      if (message === ctx.timedOut) return state;
      return {
        phase: "turn",
        input: message.payload.text,
        turnSeq: state.turnSeq + 1
      };
    },
    turn: async (state, ctx) => {
      ctx.id satisfies string;
      ctx.turn satisfies number;
      ctx.input satisfies ChatSeed;
      // `ctx` IS `step`: the inherited journal surface is the same one a
      // function definition receives.
      await ctx.do("charge", () => 1);
      ctx.idempotencyKey("charge", { scope: "run" }) satisfies string;
      return {
        phase: "awaiting",
        turnSeq: state.turnSeq,
        asks: ctx.ask(Approve, [{ toolCallId: state.input }], {
          expiresIn: "7 days"
        })
      };
    },
    awaiting: async (state, ctx) => {
      const decisions = await ctx.answers(state.asks, { within: "7 days" });
      if (decisions === ctx.timedOut) {
        return { phase: "idle", turnSeq: state.turnSeq };
      }
      // The answer type travels with the ask KIND, not with the run; a
      // lapsed ask reads as undefined beside the answers that landed.
      decisions satisfies (Decision | undefined)[];
      return { phase: "turn", input: "again", turnSeq: state.turnSeq + 1 };
    }
  },
  // A machine's only terminal is often the one `onCancel` returns.
  onCancel: async (state, ctx) =>
    state.phase === "idle"
      ? ctx.complete(state.turnSeq)
      : { phase: "idle", turnSeq: 0 }
} satisfies TaskMachine<Chat, ChatMessage, number, ChatSeed>;

// Probes 2 and 3, which are why no `machine()` helper is shipped: every
// constraint narrower than `any` rejects EVERY concrete machine, because a
// handler's state parameter is contravariant and its return is the state
// union. A helper carrying one of these would reject what it exists to help.
// @ts-expect-error probe 2: `never` in the parameter slots rejects it.
const _probe2: TaskMachine<never, never, never, never> = chat;
// @ts-expect-error probe 3: a JSON-shaped state constraint rejects it too.
const _probe3: TaskMachine<
  TaskJson & TaskPhased,
  TaskJson,
  TaskJson,
  TaskJson
> = chat;

// Probe 1: the definitions constraint accepts a concrete machine beside a
// function, in one map.
const machineTasks = new Tasks({
  definitions: {
    "chat@v1": chat,
    report: async (input: { topic: string }, step: TaskStep) =>
      step.do("measure", () => input.topic.length)
  }
});
({ "chat@v1": chat }) satisfies TaskDefinitions;

// The extractors read both definition forms, exactly.
const _chatInput: Exact<TaskInput<typeof chat>, ChatSeed> = true;
const _chatState: Exact<TaskState<typeof chat>, Chat> = true;
// From `onCancel`'s return position, not just `phases`'.
const _chatOutput: Exact<TaskOutput<typeof chat>, number> = true;
const _chatMailbox: Exact<TaskMailbox<typeof chat>, ChatMessage> = true;

type ReportFn = (
  input: { topic: string },
  step: TaskStep
) => Promise<{ key: string }>;
const _fnInput: Exact<TaskInput<ReportFn>, { topic: string }> = true;
const _fnOutput: Exact<TaskOutput<ReportFn>, { key: string }> = true;
// A function definition has no checkpoint and no mailbox.
const _fnState: Exact<TaskState<ReportFn>, unknown> = true;
const _fnMailbox: Exact<TaskMailbox<ReportFn>, never> = true;

// A machine with no terminal anywhere settles nothing, and says so.
const forever = {
  initial: { phase: "loop" } as { phase: "loop" },
  phases: { loop: async (state: { phase: "loop" }) => state }
} satisfies TaskMachine<{ phase: "loop" }>;
const _foreverOutput: Exact<TaskOutput<typeof forever>, void> = true;

// A machine seeded by a value rather than a function takes no input.
const seedless = {
  initial: { phase: "go" } as { phase: "go" },
  phases: { go: async (_state: { phase: "go" }, ctx) => ctx.complete("done") }
} satisfies TaskMachine<{ phase: "go" }, never, string>;
const _seedlessInput: Exact<TaskInput<typeof seedless>, void> = true;
const _seedlessOutput: Exact<TaskOutput<typeof seedless>, string> = true;

// Runs of a machine definition are typed by its seed.
machineTasks.run("chat@v1", {
  conversationId: "c1"
}) satisfies Promise<TaskReceipt>;
// @ts-expect-error the seed shape is checked where runs start.
machineTasks.run("chat@v1", { conversation: "c1" });
machineTasks.run(
  "chat@v1",
  { conversationId: "c1" },
  {
    start: "queued",
    turnTimeout: "1 day",
    background: true
  }
) satisfies Promise<TaskReceipt>;
machineTasks.run(
  "chat@v1",
  { conversationId: "c1" },
  {
    // @ts-expect-error `parent` is owned by ctx.spawn, not by the public surface.
    parent: "run_1"
  }
);

// ── Handles ──────────────────────────────────────────────────────────────

// A per-run handle types its payload from the definition's mailbox.
const conversation = machineTasks.at("chat@v1", "conv:1");
conversation.send({ text: "hi" }) satisfies Promise<TaskSendReceipt>;
// @ts-expect-error the mailbox payload is checked at the call site.
conversation.send({ body: "hi" });
conversation.view() satisfies Promise<TaskRunView<number, Chat> | null>;

// A lens over a machine definition carries the three machine verbs, and it
// is what `handle()` itself returns — not a degraded `Task<Input, Output>`,
// whose unknown definition would type all three `never`.
const machineLens = machineTasks.handle("chat@v1");
const _machineLensShape: Exact<
  typeof machineLens,
  TaskHandle<typeof chat, ChatSeed, Chat, number>
> = true;
machineLens.send("conv:1", { text: "hi" }) satisfies Promise<TaskSendReceipt>;
machineLens.view("conv:1") satisfies Promise<TaskRunView<number, Chat> | null>;
// @ts-expect-error the mailbox payload is checked on the lens too.
machineLens.send("conv:1", { body: "hi" });
// `at()` off the lens is the same typed per-run handle `tasks.at` returns.
machineLens
  .at("conv:1")
  .send({ text: "hi" }) satisfies Promise<TaskSendReceipt>;
// A function definition's lens off the same `Tasks` types all three `never`,
// so `handle("report").send(...)` cannot be called at all.
const reportLens = machineTasks.handle("report");
const _reportLensSend: Exact<typeof reportLens.send, never> = true;
// ...and on a function definition all three are `never`, so uncallable.
declare const functionLens: TaskHandle<
  ReportFn,
  { topic: string },
  unknown,
  { key: string }
>;
const _fnSend: Exact<typeof functionLens.send, never> = true;
const _fnView: Exact<typeof functionLens.view, never> = true;
const _fnWatch: Exact<typeof functionLens.watch, never> = true;
// `Task<Input, Output>` is that same lens over an unknown definition.
const _taskAlias: Exact<
  Task<{ topic: string }, { key: string }>,
  TaskHandle<unknown, { topic: string }, unknown, { key: string }>
> = true;

// ── What must NOT compile ────────────────────────────────────────────────

const rejections = {
  initial: { phase: "a" } as { phase: "a" } | { phase: "b" },
  phases: {
    // @ts-expect-error a forged terminal is missing the unexported brand.
    a: async (_state: { phase: "a" }) => ({ done: true, result: 1 }),
    // @ts-expect-error a forgotten return types the handler as Promise<void>.
    b: async (_state: { phase: "b" }, ctx) => {
      await ctx.do("work", () => 1);
    }
  }
} satisfies TaskMachine<{ phase: "a" } | { phase: "b" }, never, number>;
rejections satisfies object;

const unguarded = {
  initial: { phase: "idle" } as { phase: "idle" },
  phases: {
    idle: async (state: { phase: "idle" }, ctx) => {
      const message = await ctx.receive();
      // @ts-expect-error a wait's timeout must be narrowed before its value.
      message.payload;
      return state;
    }
  }
} satisfies TaskMachine<{ phase: "idle" }, ChatMessage>;
unguarded satisfies object;

const missingPhase = {
  initial: { phase: "a" } as { phase: "a" } | { phase: "b" },
  // @ts-expect-error every phase of the state union needs a handler.
  phases: {
    a: async (state: { phase: "a" }) => state
  }
} satisfies TaskMachine<{ phase: "a" } | { phase: "b" }>;
missingPhase satisfies object;

const unknownPhase = {
  initial: { phase: "a" } as { phase: "a" },
  phases: {
    a: async (state: { phase: "a" }) => state,
    // @ts-expect-error a phase key outside the state union is rejected.
    nope: async (state: { phase: "a" }) => state
  }
} satisfies TaskMachine<{ phase: "a" }>;
unknownPhase satisfies object;

// Probe 5, pinned deliberately: omitting `satisfies` on a map of
// PARAMETERLESS handlers degrades silently — a bogus phase key and a
// missing field both compile clean. That is a typing loss, never a
// correctness loss, and a lint rule requires `satisfies` on every entry.
// This probe exists so a future change making omission loud is reviewed
// rather than accidental.
const unannotated = {
  initial: { phase: "a" },
  phases: {
    a: async () => ({ phase: "b" }),
    bogus: async () => ({ phase: "a" })
  }
};
// The loss itself, pinned: the checkpoint union degrades to the widened
// `{ phase: string }` and the output to `void`, because a parameterless
// handler returns no terminal the extractor can see. Either assertion
// breaks the day the constraint becomes loud.
const _degradedState: Exact<
  TaskState<typeof unannotated>,
  { phase: string }
> = true;
const _degradedOutput: Exact<TaskOutput<typeof unannotated>, void> = true;

// ── Serialisability, asserted structurally and opt-in ────────────────────

interface InterfaceState {
  phase: "idle";
  counters: { turns: number };
  tags: string[];
}
// An `interface`-spelled checkpoint passes: the walk is structural, which
// is why `State` is not constrained to an index signature.
const _jsonOk: Exact<AssertJson<InterfaceState>, InterfaceState> = true;

interface StreamingState {
  phase: "idle";
  body: ReadableStream;
}
const _jsonBad: Exact<
  AssertJson<StreamingState>,
  { CHECKPOINT_NOT_SERIALISABLE: StreamingState }
> = true;

// Keep the assertions live for the compiler.
void [
  _probe2,
  _probe3,
  _chatInput,
  _chatState,
  _chatOutput,
  _chatMailbox,
  _fnInput,
  _fnOutput,
  _fnState,
  _fnMailbox,
  _foreverOutput,
  _seedlessInput,
  _seedlessOutput,
  _fnSend,
  _fnView,
  _fnWatch,
  _machineLensShape,
  _reportLensSend,
  _taskAlias,
  _jsonOk,
  _jsonBad,
  _degradedState,
  _degradedOutput
];
