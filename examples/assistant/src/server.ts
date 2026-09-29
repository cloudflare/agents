/**
 * Assistant — app server entry.
 *
 * The agent architecture lives under `agents/assistant`. This Worker
 * entry owns only the GitHub OAuth flow and the authenticated `/chat*`
 * gate that forwards each user to their `AssistantDirectory`.
 */

import {
  camelCaseToKebabCase,
  getAgentByName,
  routeSubAgentRequest
} from "agents";
import { CodemodeRuntime } from "@cloudflare/codemode";
import { AssistantDirectory } from "../agents/assistant/agent";
import { MyAssistant } from "../agents/assistant/agents/my-assistant/agent";
import {
  createUnauthorizedResponse,
  getGitHubUserFromRequest,
  handleGitHubCallback,
  handleGitHubLogin,
  handleLogout
} from "./auth";
import type { GitHubUser } from "./auth";

export { AssistantDirectory, CodemodeRuntime, MyAssistant };

/**
 * Local-dev escape hatch: set `DEV_USER=yourname` in `.env.local` (gitignored)
 * to skip GitHub OAuth entirely and act as that user. Defaults to "" (disabled)
 * via `vars` in wrangler.jsonc. Never set this in production.
 */
function getDevUser(env: Env): GitHubUser | null {
  if (!env.DEV_USER) return null;
  return { id: 0, login: env.DEV_USER, name: env.DEV_USER, avatarUrl: "" };
}

const SUB_AGENT_SEGMENT = camelCaseToKebabCase(MyAssistant.name);
const SUB_AGENT_PREFIX = `/chat/sub/${SUB_AGENT_SEGMENT}/`;

function createJsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/auth/login") {
        return handleGitHubLogin(request, env);
      }

      if (url.pathname === "/auth/callback") {
        return await handleGitHubCallback(request, env);
      }

      if (url.pathname === "/auth/logout") {
        if (request.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }
        return handleLogout(request);
      }

      if (url.pathname === "/auth/me") {
        const user =
          getDevUser(env) ?? (await getGitHubUserFromRequest(request));
        if (!user) {
          return createUnauthorizedResponse(request);
        }
        return createJsonResponse(user);
      }

      // User-scoped chat routing. The Worker, not the browser, decides
      // which AssistantDirectory DO owns this user's chats. Everything
      // below `/chat` (including sub-agent routing to a specific
      // `MyAssistant` facet) is handled by the directory's built-in
      // `Agent.fetch()` + sub-routing logic.
      if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
        const user =
          getDevUser(env) ?? (await getGitHubUserFromRequest(request));
        if (!user) {
          return createUnauthorizedResponse(request);
        }

        const directory = await getAgentByName(
          env.AssistantDirectory as DurableObjectNamespace<AssistantDirectory>,
          user.login
        );

        // Requests without a child segment belong to the directory itself
        // (including `/chat` and `/chat/mcp-callback`).
        if (url.pathname.startsWith(SUB_AGENT_PREFIX)) {
          const childPath = url.pathname.slice(SUB_AGENT_PREFIX.length);
          return routeSubAgentRequest(request, directory, {
            fromPath: `/sub/${SUB_AGENT_SEGMENT}/${childPath}`
          });
        }

        return directory.fetch(request);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected auth error";
      return createJsonResponse({ error: message }, { status: 500 });
    }

    // Any other path is intentionally unhandled. We do NOT fall back
    // to `routeAgentRequest` — that would let a client reach
    // `/agents/assistant-directory/<login>` or
    // `/agents/my-assistant/<chatId>` without going through the
    // GitHub-authenticated `/chat*` gate.
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
