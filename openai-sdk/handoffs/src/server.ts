import { Agent, run } from "@openai/agents";
import { Agent as CFAgent, routeAgentRequest } from "agents";

export class MyAgent extends CFAgent {
  async onRequest() {
    const historyTutorAgent = new Agent({
      instructions:
        "You provide assistance with historical queries. Explain important events and context clearly.",
      name: "History Tutor"
    });

    const mathTutorAgent = new Agent({
      instructions:
        "You provide help with math problems. Explain your reasoning at each step and include examples",
      name: "Math Tutor"
    });

    const triageAgent = new Agent({
      handoffs: [historyTutorAgent, mathTutorAgent],
      instructions:
        "You determine which agent to use based on the user's homework question",
      name: "Triage Agent"
    });

    const result = await run(triageAgent, "What is the capital of France?");
    console.log(JSON.stringify(result, null, 2));
    return Response.json(result.finalOutput);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
