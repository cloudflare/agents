import { routeAgentRequest } from "agents";
import { HttpChatAgent } from "./http-chat-agent.js";

export type Env = {
  HttpChatAgent: DurableObjectNamespace<HttpChatAgent>;
  OPENAI_API_KEY: string;
};

export { HttpChatAgent };

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
