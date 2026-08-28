import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  Tasks,
  NonRetryableError,
  type Task,
  type TaskInterruption,
  type TaskReceipt,
  type TaskRecoveryDecision,
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

// A definition may pair its handler with a recovery callback; input and
// output stay typed through the object form.
const guarded = new Tasks({
  definitions: {
    payment: {
      run: async (input: { orderId: string }, step: TaskStep) => {
        const captured = await step.do("capture", ({ checkpoint }) => {
          checkpoint({ phase: "submitted" });
          return input.orderId.length;
        });
        return { captured };
      },
      recover: async (
        interruption: TaskInterruption<{ orderId: string }>
      ): Promise<TaskRecoveryDecision<{ captured: number }>> => {
        interruption.input.orderId satisfies string;
        interruption.interruptedStep?.checkpoint satisfies TaskValue;
        interruption.interruptedStep?.idempotencyKey satisfies
          | string
          | undefined;
        if (interruption.interruptedStep === null) {
          return { action: "replay" };
        }
        return { action: "complete", result: { captured: 1 } };
      }
    }
  }
});
guarded.run("payment", { orderId: "o-1" }) satisfies Promise<TaskReceipt>;
guarded.handle("payment") satisfies Task<
  { orderId: string },
  { captured: number }
>;
// @ts-expect-error the object form checks the input shape too.
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
