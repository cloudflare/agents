import { Task } from "@a2a-js/sdk";
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { CoordinatorAgent, SpecialistAgent } from "./context-do";
import {
  continueSpecialistConversation,
  startSpecialistConversation
} from "./a2a-client";
import { handleWorkerRequest } from "./router";
import { requireBearerToken } from "./runtime";
import {
  normalizeA2AWorkflowParams,
  textArtifact,
  type A2AWorkflowParams
} from "./runtime/index";

/** Coordinates a deterministic draft and a two-turn A2A specialist review. */
export class CoordinatorWorkflow extends AgentWorkflow<
  CoordinatorAgent,
  A2AWorkflowParams
> {
  async run(
    event: AgentWorkflowEvent<A2AWorkflowParams>,
    step: AgentWorkflowStep
  ): Promise<void> {
    const params = normalizeA2AWorkflowParams(event.payload);
    try {
      if (params.turn !== 1) {
        throw new Error("The coordinator accepts one external turn per task.");
      }
      const draft = await step.do("draft coordinator response", async () =>
        deterministicDraft(params.prompt)
      );
      await step.do("publish coordinator draft", async () => {
        await this.agent.publishTaskArtifact(
          params.taskId,
          textArtifact(
            "coordinator-draft",
            "Coordinator draft",
            "The deterministic first pass before specialist review.",
            draft
          ),
          params.turn,
          "coordinator-draft"
        );
      });

      const specialistOptions = {
        cardUrl: "https://a2a.internal/specialist/.well-known/agent-card.json",
        contextId: params.contextId,
        draft,
        parentTaskId: params.taskId,
        prompt: params.prompt,
        token: requireBearerToken(this.env)
      };
      const dependencies = {
        fetcher: (input: RequestInfo | URL, init?: RequestInit) =>
          handleWorkerRequest(new Request(input, init), this.env),
        onTransition: async ({
          key,
          message
        }: {
          key: string;
          message: string;
        }) => {
          await this.agent.publishTaskArtifact(
            params.taskId,
            textArtifact(
              "specialist-progress",
              "Specialist progress",
              "Latest state observed over the internal A2A stream.",
              message
            ),
            params.turn,
            key
          );
        }
      };
      const startJson = await step.do(
        "start specialist A2A conversation",
        {
          retries: { limit: 2, delay: "1 second", backoff: "constant" },
          timeout: "1 minute"
        },
        async () =>
          startSpecialistConversation(specialistOptions, dependencies).then(
            (start) =>
              JSON.stringify({
                endpoint: start.endpoint,
                question: start.question,
                task: Task.toJSON(start.task)
              })
          )
      );
      const start = JSON.parse(startJson) as {
        endpoint: string;
        question: string;
        task: unknown;
      };
      const exchangeJson = await step.do(
        "continue specialist A2A conversation",
        {
          retries: { limit: 2, delay: "1 second", backoff: "constant" },
          timeout: "1 minute"
        },
        async () =>
          JSON.stringify(
            await continueSpecialistConversation(
              {
                endpoint: start.endpoint,
                parentTaskId: params.taskId,
                question: start.question,
                task: Task.fromJSON(start.task),
                token: specialistOptions.token
              },
              dependencies
            )
          )
      );
      const exchange = JSON.parse(exchangeJson) as {
        answer: string;
        continuationResponse: string;
        contextId: string;
        question: string;
        taskId: string;
      };
      const response = `Coordinator and Specialist joint answer:\n\n${exchange.answer}`;

      await step.do("complete coordinator task", async () => {
        await this.agent.completeTask(
          params.taskId,
          response,
          [
            textArtifact(
              "joint-response",
              "Joint response",
              "The final deterministic output after specialist continuation.",
              response
            )
          ],
          {
            specialistContextId: exchange.contextId,
            specialistContinuationResponse: exchange.continuationResponse,
            specialistQuestion: exchange.question,
            specialistTaskId: exchange.taskId
          },
          params.turn
        );
      });
      await step.reportComplete({ taskId: params.taskId });
    } catch (error) {
      await step.do("fail coordinator task", async () => {
        await this.agent.failTask(
          params.taskId,
          error instanceof Error ? error.message : "UnknownError",
          params.turn
        );
      });
      await step.reportError(
        error instanceof Error ? error : new Error("UnknownError")
      );
      throw error;
    }
  }
}

/** Requires one continuation, then completes the same specialist task. */
export class SpecialistWorkflow extends AgentWorkflow<
  SpecialistAgent,
  A2AWorkflowParams
> {
  async run(
    event: AgentWorkflowEvent<A2AWorkflowParams>,
    step: AgentWorkflowStep
  ): Promise<void> {
    const params = normalizeA2AWorkflowParams(event.payload);
    try {
      if (params.turn === 1) {
        await step.do("request specialist input", async () => {
          await this.agent.requireInput(
            params.taskId,
            "Which constraint should the final answer prioritize?",
            params.turn
          );
        });
        await step.reportComplete({
          state: "input-required",
          taskId: params.taskId
        });
        return;
      }
      if (params.turn !== 2) {
        throw new Error(
          `The specialist expected turn 2, received ${params.turn}.`
        );
      }
      const response = await step.do("compose specialist answer", async () => {
        const followUp = params.conversation.at(-1)?.text ?? "";
        return [
          "Validate the core assumption first and make correctness measurable.",
          `Apply the coordinator's request with this priority: ${followUp}`,
          "Optimize only after evidence shows that the trade-off is worthwhile."
        ].join(" ");
      });
      await step.do("complete specialist task", async () => {
        await this.agent.completeTask(
          params.taskId,
          response,
          [
            textArtifact(
              "joint-response",
              "Specialist joint response",
              "The specialist's result after receiving follow-up input.",
              response
            )
          ],
          { conversationTurns: params.turn },
          params.turn
        );
      });
      await step.reportComplete({ taskId: params.taskId });
    } catch (error) {
      await step.do(`fail specialist turn ${params.turn}`, async () => {
        await this.agent.failTask(
          params.taskId,
          error instanceof Error ? error.message : "UnknownError",
          params.turn
        );
      });
      await step.reportError(
        error instanceof Error ? error : new Error("UnknownError")
      );
      throw error;
    }
  }
}

function deterministicDraft(prompt: string): string {
  return `Draft: answer "${prompt.slice(0, 240)}" directly, state assumptions, and choose the simplest verifiable approach.`;
}
