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
  readonly fibers = new Fibers(this);

  readonly report = this.fibers.create<{ topic: string }, { key: string }>(
    "report",
    async (input, step) => {
      // Input and step are typed at the definition site.
      input.topic satisfies string;
      const size = await step.do("measure", () => input.topic.length);
      size satisfies number;
      await step.sleep("cool-off", "10 seconds");
      return { key: `report-${size}` };
    }
  );

  readonly lifecycle = Lifecycle.install(this).use(this.fibers);
}

declare const object: ReportObject;
object.fibers satisfies DurableObjectCapability;
object.report satisfies Fiber<{ topic: string }, { key: string }>;

// The handle types run input and snapshot output.
object.report.run({ topic: "chips" }) satisfies Promise<FiberReceipt>;
object.report.run(
  { topic: "chips" },
  { idempotencyKey: "report:1", retain: false }
) satisfies Promise<FiberReceipt>;
object.report.get("fiber_x") satisfies Promise<FiberRunSnapshot<{
  key: string;
}> | null>;
// @ts-expect-error the input shape is checked at the handle.
object.report.run({ subject: "chips" });

// Manager-level reads span definitions and widen the output.
object.fibers.get(
  "fiber_x"
) satisfies Promise<FiberRunSnapshot<FiberValue> | null>;
object.fibers.cancel("fiber_x", "done") satisfies Promise<boolean>;

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
