import type { RunWorkflowOptions } from "../workflows";

const stringRetention = {
  retention: {
    successRetention: "1 day",
    errorRetention: "2 weeks"
  }
} satisfies RunWorkflowOptions;

const numericRetention = {
  retention: {
    successRetention: 60_000,
    errorRetention: "1 month"
  }
} satisfies RunWorkflowOptions;

void stringRetention;
void numericRetention;

const invalidRetention = {
  retention: {
    // @ts-expect-error Workflow retention uses WorkflowSleepDuration units.
    successRetention: "1 fortnight"
  }
} satisfies RunWorkflowOptions;

void invalidRetention;
