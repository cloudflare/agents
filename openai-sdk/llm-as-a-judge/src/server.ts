import {
  Agent,
  run,
  withTrace,
  type AgentInputItem,
} from "@openai/agents";
import {
  Agent as CFAgent,
  unstable_callable as callable,
  routeAgentRequest,
} from "agents";
import { z } from "zod";

type Env = {
  MyAgent: DurableObjectNamespace<MyAgent>;
};

const EvaluationFeedback = z.object({
  feedback: z.string(),
  score: z.enum(["pass", "needs_improvement", "fail"]),
});

export type Attempt = {
  description: string;
  slogan: string;
  feedback?: string;
  score: "pass" | "needs_improvement" | "fail";
};

export type CFAgentState = {
  chosenSlogan?: string;
  attempts: Attempt[];
};

export class MyAgent extends CFAgent<Env, CFAgentState> {
  initialState: CFAgentState = {
    attempts: [],
  };

  marketingAgent = new Agent({
    name: "Marketer",
    instructions:
      "You are a marketing wizard and you come up with good slogans based on user requests. If there is any feedback, use it to improve the slogan. Return only the slogan.",
  });

  evaluator = new Agent({
    name: "Evaluator",
    instructions:
      "You evaluate marketing slogans. You will provide a score and possible feedback on how it can be improved. Never accept the very first attempt.",
    outputType: EvaluationFeedback,
  });

  @callable()
  async generateSlogan(description: string) {
    console.log(
      `[MyAgent] generateSlogan method called with description: "${description}"`
    );

    await withTrace("LLM as a judge", async () => {
      let inputItems: AgentInputItem[] = [
        { role: "user", content: description },
      ];
      while (this.state.attempts.length <= 5) {
        console.log("[MyAgent] Starting agent run...");
        const sloganResult = await run(this.marketingAgent, inputItems);
        const slogan = sloganResult.finalOutput;
        if (slogan === undefined) {
          console.warn("Failed to return slogan");
          return;
        }
        console.log("[MyAgent] Evaluating slogan:", slogan);
        // Ensure the whole history is present
        inputItems = sloganResult.history;
        const evaluationResult = await run(this.evaluator, inputItems);
        const attempts = this.state.attempts;
        const evaluation = evaluationResult.finalOutput;
        attempts.push({
          description,
          slogan,
          feedback: evaluation?.feedback as string,
          score: evaluation?.score || "fail",
        });
        // Updating state syncs to all connected clients
        this.setState({
          ...this.state,
          attempts,
        });
        if (evaluation?.score === "pass") {
          console.log("[MyAgent] Slogan passed judgment", slogan);

          this.setState({
            ...this.state,
            chosenSlogan: slogan
          })
          return;
        }
        if (evaluation?.feedback) {
          inputItems.push({
            role: "user",
            content: `Feedback: ${evaluation.feedback}`,
          });
        }
      }
    });
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    console.log(`[Server] Handling request: ${request.method} ${request.url}`);

    const response = await routeAgentRequest(request, env);

    if (response) {
      console.log(
        `[Server] Agent request routed successfully, status: ${response.status}`
      );
      return response;
    }
    console.log("[Server] No agent route matched, returning 404");
    return new Response("Not found", { status: 404 });
  },
};
