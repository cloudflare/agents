import { routeAgentRequest } from "agents";

export { ThinkAgent, Chat } from "../src/server";

type Env = {
  ThinkAgent: DurableObjectNamespace<import("../src/server").ThinkAgent>;
};

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
