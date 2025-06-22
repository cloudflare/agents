import { Agent, run } from "@openai/agents";
import { Agent as CFAgent, routeAgentRequest } from "agents";

type Env = {
  MyAgent: DurableObjectNamespace<MyAgent>;
};

export class MyAgent extends CFAgent<Env> {
  async onRequest() {
    const agent = new Agent({
      instructions: "You are a helpful assistant.",
      name: "Assistant",
    });

    const result = await run(
      agent,
      "Write a haiku about recursion in programming."
    );
    return new Response(result.finalOutput);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
};
