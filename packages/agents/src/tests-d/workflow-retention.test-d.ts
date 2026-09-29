import { expectTypeOf } from "vitest";
import type { RunWorkflowOptions } from "../workflows";

expectTypeOf<RunWorkflowOptions["retention"]>().toEqualTypeOf<
  WorkflowInstanceCreateOptions["retention"]
>();

const validRetention = {
  retention: {
    successRetention: "1 day",
    errorRetention: 60_000
  }
} satisfies RunWorkflowOptions;

void validRetention;

const invalidRetention = {
  retention: {
    // @ts-expect-error Workflow retention uses WorkflowSleepDuration units.
    successRetention: "1 fortnight"
  }
} satisfies RunWorkflowOptions;

void invalidRetention;
