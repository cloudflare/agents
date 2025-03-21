import { env } from "hono/adapter";
import { createMiddleware } from "hono/factory";
import { routeAgentRequest } from "agents";

import type { Context, Env } from "hono";
import type { AgentOptions } from "agents";

/**
 * Configuration options for the Cloudflare Agents middleware
 */
type AgentMiddlewareContext<E extends Env> = {
  /** Cloudflare Agents-specific configuration options */
  options?: AgentOptions<E>;
  /** Optional error handler for caught errors */
  onError?: (error: Error) => void;
};

/**
 * Creates a middleware for handling Cloudflare Agents WebSocket and HTTP requests
 * Processes both WebSocket upgrades and standard HTTP requests, delegating them to Cloudflare Agents
 */
export function agentsMiddleware<E extends Env = Env>(
  ctx?: AgentMiddlewareContext<E>
) {
  return createMiddleware<Env>(async (c, next) => {
    try {
      const handler = isWebSocketUpgrade(c)
        ? handleWebSocketUpgrade
        : handleHttpRequest;

      const response = await handler(c, ctx?.options);

      return response === null ? await next() : response;
    } catch (error) {
      if (ctx?.onError) {
        ctx.onError(error as Error);
        return next();
      }
      throw error;
    }
  });
}

/**
 * Checks if the incoming request is a WebSocket upgrade request
 * Looks for the 'upgrade' header with a value of 'websocket' (case-insensitive)
 */
function isWebSocketUpgrade(c: Context): boolean {
  return c.req.header("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Creates a new Request object from the Hono context
 * Preserves the original request's URL, method, headers, and body
 */
function createRequestFromContext(c: Context) {
  return new Request(c.req.url, {
    method: c.req.method,
    headers: c.req.header(),
    body: c.req.raw.body,
  });
}

/**
 * Handles WebSocket upgrade requests
 * Returns a WebSocket upgrade response if successful, null otherwise
 */
async function handleWebSocketUpgrade<E extends Env>(
  c: Context<E>,
  options?: AgentOptions<E>
) {
  const req = createRequestFromContext(c);
  const response = await routeAgentRequest(req, env(c) satisfies Env, options);

  if (!response?.webSocket) {
    return null;
  }

  return new Response(null, {
    status: 101,
    webSocket: response.webSocket,
  });
}

/**
 * Handles standard HTTP requests
 * Forwards the request to Cloudflare Agents and returns the response
 */
async function handleHttpRequest<E extends Env>(
  c: Context<E>,
  options?: AgentOptions<E>
) {
  const req = createRequestFromContext(c);

  return routeAgentRequest(req, env(c) satisfies Env, options);
}
