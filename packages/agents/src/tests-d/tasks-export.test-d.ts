import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  Tasks,
  NonRetryableError,
  type Task,
  type TaskEvent,
  type TaskEventReceipt,
  type TaskReceipt,
  type TaskRunSnapshot,
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
object.tasks.sendEvent(
  "task_x",
  "approval",
  { approved: true },
  { idempotencyKey: "approval:1" }
) satisfies Promise<TaskEventReceipt<{ approved: boolean }>>;
interface NamedEventPayload {
  approved: boolean;
}
declare const namedEventPayload: NamedEventPayload;
object.tasks.sendEvent(
  "task_x",
  "approval",
  namedEventPayload
) satisfies Promise<TaskEventReceipt<NamedEventPayload>>;
const readonlyTuple = ["yes", 1] as const;
object.tasks.sendEvent("task_x", "tuple", readonlyTuple) satisfies Promise<
  TaskEventReceipt<readonly ["yes", 1]>
>;
// @ts-expect-error event payloads must be JSON-serializable.
object.tasks.sendEvent("task_x", "bad", new Date());
declare const eventSymbol: unique symbol;
declare const symbolPayload: { value: string; [eventSymbol]: string };
// @ts-expect-error JSON would silently discard symbol-keyed properties.
object.tasks.sendEvent("task_x", "bad-symbol", symbolPayload);

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
step.waitForEvent<{ approved: boolean }>(
  "approval",
  "approval"
) satisfies Promise<TaskEvent<{ approved: boolean }>>;
const approvalEvent = await step.waitForEvent<NamedEventPayload>(
  "named-approval",
  "approval"
);
approvalEvent.payload satisfies NamedEventPayload;
// @ts-expect-error event envelopes have no arbitrary properties.
approvalEvent.notDeclared;
// @ts-expect-error receive payloads must describe JSON-compatible values.
step.waitForEvent<Date>("bad-date", "approval");
// @ts-expect-error receive payloads must describe JSON-compatible values.
step.takeEvents<() => void>("bad-function", "approval");
step.waitForEvent<{ approved: boolean }>("timed", "approval", {
  timeout: "1 hour"
}) satisfies Promise<TaskEvent<{ approved: boolean }> | null>;
step.takeEvents<{ message: string }>("messages", "message", {
  limit: 20
}) satisfies Promise<TaskEvent<{ message: string }>[]>;
// @ts-expect-error durations use second/minute/hour/day/week units.
step.sleep("bad", "5 parsecs");
// @ts-expect-error step results must be JSON-serializable values.
step.do("function-result", () => () => {});

new NonRetryableError("stop") satisfies Error;
