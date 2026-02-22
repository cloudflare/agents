import { Agent, type AgentInputItem, run, withTrace } from "@openai/agents";
import { Agent as CFAgent, callable, routeAgentRequest } from "agents";
import { z } from "zod";

const EvaluationFeedback = z.object({
  feedback: z.string(),
  score: z.enum(["pass", "needs_improvement", "fail"])
});

export type Attempt = {
  description: string;
  slogan: string;
  feedback?: string;
  score: "pass" | "needs_improvement" | "fail";
};

export type CFAgentState = {
  chosenSlogan?: string;
  status?: string;
  attempts: Attempt[];
};

export class MyAgent extends CFAgent<Env, CFAgentState> {
  initialState: CFAgentState = {
    attempts: []
  };

  shouldReset = false;

  marketingAgent = new Agent({
    name: "Marketer",
    instructions:
      "You are a marketing wizard and you come up with good slogans based on user requests. If there is any feedback, use it to improve the slogan. Return only the slogan."
  });

  evaluator = new Agent({
    name: "Evaluator",
    instructions:
      "You evaluate marketing slogans. You will provide a score and possible feedback on how it can be improved. Do not directly suggest new slogans, your job is to judge. Never accept the very first attempt.",
    outputType: EvaluationFeedback
  });

  setStatus(status: string) {
    console.log("[MyAgent] Updating status", status);
    this.setState({
      ...this.state,
      status
    });
  }

  @callable()
  async generateSlogan(description: string) {
    console.log(
      `[MyAgent] generateSlogan method called with description: "${description}"`
    );

    await withTrace("LLM as a judge", async () => {
      let inputItems: AgentInputItem[] = [
        { role: "user", content: description }
      ];
      this.shouldReset = false;
      while (this.state.attempts.length <= 15 && !this.shouldReset) {
        console.log("[MyAgent] Starting agent run...");
        this.setStatus("🤔 Generating");
        const sloganResult = await run(this.marketingAgent, inputItems);
        const slogan = sloganResult.finalOutput;
        if (slogan === undefined) {
          console.warn("Failed to return slogan");
          return;
        }
        console.log("[MyAgent] Evaluating slogan:", slogan);
        this.setStatus("🧑‍⚖️ Judging");
        // Ensure the whole history is present
        inputItems = sloganResult.history;
        const evaluationResult = await run(this.evaluator, inputItems);
        const attempts = this.state.attempts;
        const evaluation = evaluationResult.finalOutput as
          | { feedback: string; score: "pass" | "needs_improvement" | "fail" }
          | undefined;
        attempts.push({
          description,
          slogan,
          feedback: evaluation?.feedback || "",
          score: evaluation?.score || "fail"
        });
        // Updating state syncs to all connected clients
        this.setState({
          ...this.state,
          attempts
        });
        if (evaluation?.score === "pass") {
          console.log("[MyAgent] Slogan passed judgment", slogan);
          this.setState({
            ...this.state,
            status: "🏆 We have a winner",
            chosenSlogan: slogan
          });
          return;
        }
        if (evaluation?.feedback) {
          inputItems.push({
            role: "user",
            content: `Feedback: ${evaluation.feedback}`
          });
        }
      }
    });
  }
  @callable()
  async reset() {
    this.setState({ attempts: [] });
    this.shouldReset = true;
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
  }
};
