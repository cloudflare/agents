/**
 * Worker entry point — routes requests to:
 * 1. /auth/*  → GitHub OAuth login, callback, logout, current user
 * 2. /chat    → user-scoped agent route resolved server-side
 * 3. /*       → Vite SPA (via wrangler assets config)
 */

import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText } from "ai";
import { getAgentByName } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import {
  createUnauthorizedResponse,
  getGitHubUserFromRequest,
  handleGitHubCallback,
  handleGitHubLogin,
  handleLogout
} from "./auth";

export class ChatAgent extends AIChatAgent<Env> {
  static options = {
    sendIdentityOnConnect: true
  };

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a helpful assistant. The authenticated user's GitHub login is ${this.name}. Address them by their login occasionally.`,
      messages: await convertToModelMessages(this.messages)
    });

    return result.toUIMessageStreamResponse();
  }
}

function createJsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
        const user = await getGitHubUserFromRequest(request);
        if (!user) {
          return createUnauthorizedResponse(request);
        }
        return createJsonResponse(user);
      }

      if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
        const user = await getGitHubUserFromRequest(request);
        if (!user) {
          return createUnauthorizedResponse(request);
        }

        // The server, not the browser, decides which DO instance owns this user.
        const agent = await getAgentByName(env.ChatAgent, user.login);
        return agent.fetch(request);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected auth error";
      return createJsonResponse({ error: message }, { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
