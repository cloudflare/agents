import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type DurableObjectCapability } from "../lifecycle";
import {
  Fibers,
  NonRetryableError,
  type Fiber,
  type FiberReceipt,
  type FiberRunSnapshot,
  type FiberStep,
  type FiberValue
} from "../fibers";

class ReportObject extends DurableObject {
  readonly fibers = new Fibers({
    definitions: {
      report: async (input: { topic: string }, step: FiberStep) => {
        // Input and step are typed at the definition site.
        input.topic satisfies string;
        const size = await step.do("measure", () => input.topic.length);
        size satisfies number;
        await step.sleep("cool-off", "10 seconds");
        return { key: `report-${size}` };
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.fibers);
}

declare const object: ReportObject;
object.fibers satisfies DurableObjectCapability;

// Declared definitions type both the name and the input where runs start.
object.fibers.run("report", { topic: "chips" }) satisfies Promise<FiberReceipt>;
object.fibers.run(
  "report",
  { topic: "chips" },
  { idempotencyKey: "report:1", retain: false }
) satisfies Promise<FiberReceipt>;
// @ts-expect-error the input shape is checked against the declared handler.
object.fibers.run("report", { subject: "chips" });
// @ts-expect-error missingDefinition is not a declared definition.
object.fibers.run("missingDefinition", {});

// A handle is a typed lens scoped to one declared definition.
const report = object.fibers.handle("report");
report satisfies Fiber<{ topic: string }, { key: string }>;
report.run({ topic: "chips" }) satisfies Promise<FiberReceipt>;
report.get("fiber_x") satisfies Promise<FiberRunSnapshot<{
  key: string;
}> | null>;
// @ts-expect-error unknownDefinition is not a declared definition.
object.fibers.handle("unknownDefinition");

// Manager-level reads span definitions and widen the output.
object.fibers.get(
  "fiber_x"
) satisfies Promise<FiberRunSnapshot<FiberValue> | null>;
object.fibers.cancel("fiber_x", "done") satisfies Promise<boolean>;

// A Fibers constructed without definitions is string-typed: any name
// compiles, and names resolve at runtime against the declared map or a
// composition-root resolver.
const untypedFibers = new Fibers();
untypedFibers.run("anyDefinitionName", {
  free: true
}) satisfies Promise<FiberReceipt>;

// Step typing stands alone.
declare const step: FiberStep;
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
