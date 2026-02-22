import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { BasicWorkflowAgent } from "./basic-workflow-agent";

export type ProcessingParams = {
  name: string;
  stepCount: number;
};

export type ProcessingResult = {
  name: string;
  stepsCompleted: number;
  completedAt: string;
};

/**
 * A multi-step processing workflow that demonstrates:
 * - Progress reporting at each step
 * - Durable step execution
 * - Completion reporting back to the agent
 */
export class ProcessingWorkflow extends AgentWorkflow<
  BasicWorkflowAgent,
  ProcessingParams,
  { step: number; total: number; message: string }
> {
  async run(
    event: AgentWorkflowEvent<ProcessingParams>,
    step: AgentWorkflowStep
  ): Promise<ProcessingResult> {
    const { name, stepCount } = event.payload;

    // Report initial progress
    await this.reportProgress({
      step: 0,
      total: stepCount,
      message: `Starting workflow: ${name}`
    });

    // Execute each step
    for (let i = 0; i < stepCount; i++) {
      await step.do(`step-${i + 1}`, async () => {
        // Simulate work with a delay
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 + Math.random() * 1000)
        );
        return { stepNumber: i + 1, completed: true };
      });

      // Report progress after each step
      await this.reportProgress({
        step: i + 1,
        total: stepCount,
        message: `Completed step ${i + 1} of ${stepCount}`
      });
    }

    const result: ProcessingResult = {
      name,
      stepsCompleted: stepCount,
      completedAt: new Date().toISOString()
    };

    // Report completion to the agent
    await step.reportComplete(result);

    return result;
  }
}
