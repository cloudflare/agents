import { Agent, run } from "@openai/agents";
import { Agent as CFAgent, routeAgentRequest } from "agents";

// // uncomment to use workers-ai-provider
// import { env } from "cloudflare:workers";
// import { aisdk } from "@openai/agents-extensions";
// import { createWorkersAI } from "workers-ai-provider";
// const model = aisdk(
//   createWorkersAI({ binding: env.AI })("@cf/meta/llama-3.2-3b-instruct")
// );

export class MyAgent extends CFAgent<Env> {
  async onRequest() {
    const agent = new Agent({
      instructions: "You are a helpful assistant.",
      name: "Assistant"
      // // uncomment to use workers-ai-provider
      // model
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
  }
};
