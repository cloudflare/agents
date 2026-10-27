import { env, exports } from "cloudflare:workers";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { getAgentByName } from "../../../index";
import {
  CLIENT_ORIGIN,
  MCP_URL,
  createOAuthMcpServer,
  type OAuthMcpServer
} from "./oauth-mcp-server";

/**
 * Serve the OAuth-protected MCP server through msw for one test file. Any
 * request without a handler fails the test.
 */
export function useOAuthMcpServer(): OAuthMcpServer {
  const server = createOAuthMcpServer();
  const msw = setupServer(...server.handlers);
  beforeAll(() => msw.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.reset());
  afterAll(() => msw.close());
  return server;
}

const agentNames = new WeakMap<object, string>();

/** A fresh agent instance. */
export async function newAgent() {
  const name = crypto.randomUUID();
  const agent = await getAgentByName(env.McpIntegrationAgent, name);
  agentNames.set(agent, name);
  return agent;
}

export type IntegrationAgent = Awaited<ReturnType<typeof newAgent>>;

/**
 * Restart an agent's Durable Object, as after an eviction, and return a stub
 * for the new instance. Graceful eviction can't be used here: it waits for
 * in-flight requests, and a ready MCP connection keeps a listen stream open.
 */
export async function restartAgent(
  agent: IntegrationAgent
): Promise<IntegrationAgent> {
  const name = agentNames.get(agent);
  if (!name) throw new Error("Not an agent from newAgent()");
  await agent.restart().catch(() => {});
  const restarted = await getAgentByName(env.McpIntegrationAgent, name);
  agentNames.set(restarted, name);
  return restarted;
}

/** Send the browser to an OAuth callback URL, through the worker's routing. */
export async function followCallback(callbackUrl: string): Promise<Response> {
  const response = await exports.default.fetch(
    new Request(callbackUrl, { redirect: "manual" })
  );
  await response.body?.cancel();
  return response;
}

/**
 * Add the server, approve the first authorization as the user, and wait for
 * the agent to be ready. Returns the server id.
 */
export async function connectAuthorized(
  agent: IntegrationAgent,
  server: OAuthMcpServer,
  grant?: { scope: string },
  options: { id?: string } = {}
): Promise<string> {
  const added = await agent.connectServer(MCP_URL, {
    callbackHost: CLIENT_ORIGIN,
    ...options
  });
  expect(added.state).toBe("authenticating");
  if (added.state !== "authenticating") throw new Error("unreachable");
  await followCallback(server.authorize(added.authUrl, grant));
  await agent.settle();
  expect((await agent.server(added.id))?.state).toBe("ready");
  return added.id;
}
