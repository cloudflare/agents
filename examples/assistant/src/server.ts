/**
 * Assistant — app server entry.
 *
 * The agent architecture lives under `agents/assistant`. This Worker
 * entry owns only the GitHub OAuth flow and the authenticated `/chat*`
 * gate that forwards each user to their `AssistantDirectory`.
 */

import { getAgentByName } from "agents";
import {
  createUnauthorizedResponse,
  getGitHubUserFromRequest,
  handleGitHubCallback,
  handleGitHubLogin,
  handleLogout
} from "./auth";
import type { GitHubUser } from "./auth";
import type { AssistantDirectory } from "../agents/assistant/agent";

/**
 * Local-dev escape hatch: set `DEV_USER=yourname` in `.env.local` (gitignored)
 * to skip GitHub OAuth entirely and act as that user. Defaults to "" (disabled)
 * via `vars` in wrangler.jsonc. Never set this in production.
 */
function getDevUser(env: Env): GitHubUser | null {
  if (!env.DEV_USER) return null;
  return { id: 0, login: env.DEV_USER, name: env.DEV_USER, avatarUrl: "" };
}

type ThinkAppContext = {
  router: {
    routeSubAgent(
      request: Request,
      parent: { fetch(request: Request): Promise<Response> },
      options: { parent: string }
    ): Promise<Response>;
  };
};

function createJsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
    think?: ThinkAppContext
  ) {
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

        if (!think?.router) {
          return new Response(
            "Assistant chat routing requires the Think generated Worker entry. " +
              'Make sure wrangler.jsonc uses "main": "virtual:think/entry", ' +
              "rebuild @cloudflare/think after framework changes, and restart the dev server.",
            { status: 500 }
          );
        }

        const directory = await getAgentByName(
          env.AssistantDirectory as DurableObjectNamespace<AssistantDirectory>,
          user.login
        );
        return think.router.routeSubAgent(request, directory, {
          parent: "assistant"
        });
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
};
