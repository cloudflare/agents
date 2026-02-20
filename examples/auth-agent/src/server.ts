/**
 * Worker entry point — routes requests to:
 * 1. /api/auth/*  →  better-auth (sign-up, sign-in, token, jwks)
 * 2. /agents/*    →  routeAgentRequest() with JWT middleware
 * 3. /*           →  Vite SPA (via wrangler assets config)
 */

import { AIChatAgent } from "@cloudflare/ai-chat";
import type { StreamTextOnFinishCallback, ToolSet } from "ai";
import { routeAgentRequest } from "agents";
import { getAuth, verifyToken } from "./auth";

// Agent — the Durable Object authenticated users connect to.
// Replace onChatMessage with your own logic (e.g. streamText with an LLM).
export class SecuredChatAgent extends AIChatAgent<Env> {
  override async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>
  ): Promise<Response | undefined> {
    const latest = this.messages.at(-1);
    const text = latest?.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    return new Response(text, {
      headers: { "Content-Type": "text/plain" }
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Auth routes — handled by better-auth
    if (url.pathname.startsWith("/api/auth")) {
      return getAuth().handler(request);
    }

    // Agent routes — protected by JWT
    if (url.pathname.startsWith("/agents")) {
      const response = await routeAgentRequest(request, env, {
        // WebSocket: JWT passed as ?token= query param
        onBeforeConnect: async (req) => {
          const token = new URL(req.url).searchParams.get("token");
          if (!token)
            return Response.json(
              { error: "Missing JWT token" },
              { status: 401 }
            );

          const payload = await verifyToken(token);
          if (!payload)
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          return req;
        },
        // HTTP: JWT passed as Authorization: Bearer header
        onBeforeRequest: async (req) => {
          const authHeader = req.headers.get("Authorization");
          const token = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7)
            : null;
          if (!token)
            return Response.json({ error: "Missing token" }, { status: 401 });

          const payload = await verifyToken(token);
          if (!payload)
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          return req;
        }
      });

      if (response) return response;
      return new Response("Agent not found", { status: 404 });
    }

    // SPA fallback (handled by wrangler assets config)
    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
