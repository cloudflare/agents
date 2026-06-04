import { routeAgentRequest } from "agents";
import { browserSession, BrowserSession } from "./server/browser-session";
import { errorResponse, notFoundResponse } from "./server/http";
import { project, Project } from "./server/project";
import type { Env, JsonValue } from "./server/types";

export { BrowserSession, Project };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const runStart = Date.now();
    const url = new URL(request.url);

    try {
      const agentResponse = await routeAgentRequest(request, env);
      if (agentResponse) return agentResponse;

      if (request.method === "GET" && url.pathname === "/api/sessions") {
        return Response.json({
          sessions: await (await project(env)).listSessions()
        });
      }

      if (request.method === "POST" && url.pathname === "/api/sessions") {
        const session = await (await project(env)).createSession();
        return Response.json({ session });
      }

      if (request.method === "GET" && url.pathname === "/api/debug/sessions") {
        return Response.json({
          sessions: await (await project(env)).listSessions()
        });
      }

      const debugSessionMatch = url.pathname.match(
        /^\/api\/debug\/sessions\/([^/]+)$/
      );
      if (request.method === "GET" && debugSessionMatch) {
        return Response.json(
          await browserSession(env, debugSessionMatch[1]).debug()
        );
      }

      const forceUnlockMatch = url.pathname.match(
        /^\/api\/debug\/sessions\/([^/]+)\/unlock$/
      );
      if (request.method === "POST" && forceUnlockMatch) {
        await browserSession(env, forceUnlockMatch[1]).forceUnlock();
        return Response.json(
          await browserSession(env, forceUnlockMatch[1]).debug()
        );
      }

      const runMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/run$/);
      if (request.method === "POST" && runMatch) {
        const scriptCode = await request.text();
        const projectAgent = (await project(env)) as unknown as ProjectRunStub;
        return Response.json(
          await projectAgent.runScript(runMatch[1], scriptCode)
        );
      }

      const targetMatch = url.pathname.match(
        /^\/api\/sessions\/([^/]+)\/targets$/
      );
      if (request.method === "GET" && targetMatch) {
        return Response.json({
          targets: await (await project(env)).refreshTargets(targetMatch[1])
        });
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (request.method === "DELETE" && sessionMatch) {
        return Response.json({
          sessions: await (await project(env)).closeSession(sessionMatch[1])
        });
      }

      return notFoundResponse(runStart);
    } catch (error) {
      return errorResponse(error, runStart);
    }
  }
} satisfies ExportedHandler<Env>;

type ProjectRunStub = {
  runScript(
    sessionId: string,
    scriptCode: string
  ): Promise<{ run: JsonValue; sessionId: string | null }>;
};
