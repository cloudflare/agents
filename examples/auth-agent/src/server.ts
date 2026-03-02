/**
 * Worker entry point — routes requests to:
 * 1. /api/token  →  issue a JWT (simulates your existing auth system)
 * 2. /agents/*   →  routeAgentRequest() with JWT middleware
 * 3. /*          →  Vite SPA (via wrangler assets config)
 */

import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, convertToModelMessages } from "ai";
import { routeAgentRequest } from "agents";
import { SignJWT, jwtVerify } from "jose";

// ── JWT helpers ──────────────────────────────────────────────────────────────

function getSecret(env: Env) {
  if (!env.AUTH_SECRET) {
    throw new Error(
      'AUTH_SECRET is not set. Run: echo "AUTH_SECRET=$(openssl rand -base64 32)" > .env'
    );
  }
  return new TextEncoder().encode(env.AUTH_SECRET);
}

/** Issue a short-lived JWT containing the user's name. */
async function issueToken(env: Env, name: string) {
  return new SignJWT({ sub: name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("auth-agent")
    .setAudience("auth-agent")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(getSecret(env));
}

/** Verify a JWT and return its payload, or null if invalid/expired. */
async function verifyToken(env: Env, token: string) {
  try {
    const { payload } = await jwtVerify(token, getSecret(env), {
      issuer: "auth-agent",
      audience: "auth-agent"
    });
    return payload;
  } catch {
    return null;
  }
}

// ── Agent ────────────────────────────────────────────────────────────────────

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    // this.name comes from the Durable Object name, which is set to the user's
    // name from the JWT sub claim. Note: in production, sanitise user-controlled
    // values before interpolating into prompts to mitigate prompt injection.
    const userName = this.name;

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: `You are a helpful assistant. The user's name is ${userName}. Address them by name occasionally.`,
      messages: await convertToModelMessages(this.messages)
    });

    return result.toUIMessageStreamResponse();
  }
}

// ── Worker fetch handler ─────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ⚠️  DEMO ONLY — this endpoint issues JWTs to anyone without authentication.
    // In production, replace this with your own auth service / identity provider.
    if (url.pathname === "/api/token") {
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      let body: { name?: string };
      try {
        body = (await request.json()) as { name?: string };
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
      const name = body.name?.trim();
      if (!name) {
        return Response.json({ error: "Name is required" }, { status: 400 });
      }
      const token = await issueToken(env, name);
      return Response.json({ token });
    }

    // Agent routes — protected by JWT
    if (url.pathname.startsWith("/agents")) {
      const response = await routeAgentRequest(request, env, {
        // WebSocket: JWT passed as ?token= query param
        onBeforeConnect: async (req) => {
          const token = new URL(req.url).searchParams.get("token");
          if (!token)
            return Response.json({ error: "Missing token" }, { status: 401 });

          const payload = await verifyToken(env, token);
          if (!payload)
            return Response.json({ error: "Unauthorized" }, { status: 401 });
          return req;
        },
        // HTTP: JWT from Authorization header or ?token= query param
        onBeforeRequest: async (req) => {
          const authHeader = req.headers.get("Authorization");
          const token = authHeader?.startsWith("Bearer ")
            ? authHeader.slice(7)
            : new URL(req.url).searchParams.get("token");
          if (!token)
            return Response.json({ error: "Missing token" }, { status: 401 });

          const payload = await verifyToken(env, token);
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
