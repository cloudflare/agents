import { getAgentByName, routeAgentRequest } from "agents";
import { runRequestSchema } from "./schema";
import type { Env } from "./schema";
import { TestPlanAgent } from "./test-plan-agent";

export { PlaywrightTestAgent } from "./playwright-test-agent";
export { TestPlanAgent };

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/run") {
      const body = runRequestSchema.parse(await request.json());
      const agent = await getAgentByName(
        env.TestPlanAgent as unknown as DurableObjectNamespace<TestPlanAgent>,
        "default"
      );
      const result = await agent.runTestPlan(body);
      return Response.json(result);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        endpoints: {
          run: "POST /run"
        },
        body: {
          tests: [{ id: "home-page", title: "Home page loads" }],
          baseUrl: "optional target base URL",
          mcpServerUrl: "optional Playwright MCP HTTP/SSE URL"
        }
      });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
