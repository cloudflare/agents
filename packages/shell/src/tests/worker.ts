import { getAgentByName, routeAgentRequest } from "agents";
import { TestWorkspaceAgent } from "./agents/workspace";
import { TestGitAgent } from "./agents/git";

export { TestWorkspaceAgent, TestGitAgent };

export interface Env {
  TestWorkspaceAgent: DurableObjectNamespace;
  TestGitAgent: DurableObjectNamespace;
  LOADER: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};

export { getAgentByName };
