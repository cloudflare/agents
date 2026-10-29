import { env, exports } from "cloudflare:workers";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { getAgentByName } from "../../../index";
import {
  OAUTH_ERROR_PATH,
  OAUTH_SUCCESS_PATH
} from "../../agents/mcp-integration";
import {
  CLIENT_ORIGIN,
  createOAuthMcpServer,
  type OAuthMcpServer
} from "./oauth-mcp-server";

/**
 * Serve OAuth-protected MCP servers through msw for one test file: the
 * default one, plus one per extra origin pair. Any request without a handler
 * fails the test.
 */
export function useOAuthMcpServers(
  ...extra: Array<{ origin: string; authOrigin: string }>
): OAuthMcpServer[] {
  const servers = [
    createOAuthMcpServer(),
    ...extra.map((origins) => createOAuthMcpServer(origins))
  ];
  const msw = setupServer(...servers.flatMap((server) => server.handlers));
  beforeAll(() => msw.listen({ onUnhandledRequest: "error" }));
  afterEach(() => {
    for (const server of servers) server.reset();
  });
  afterAll(() => msw.close());
  return servers;
}

/** Serve the default OAuth-protected MCP server for one test file. */
export function useOAuthMcpServer(): OAuthMcpServer {
  const [server] = useOAuthMcpServers();
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

/** The instance name of an agent from {@link newAgent}. */
export function agentName(agent: IntegrationAgent): string {
  const name = agentNames.get(agent);
  if (!name) throw new Error("Not an agent from newAgent()");
  return name;
}

/** Poll `check` until it holds, or fail after `timeoutMs`. */
export async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition never held");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Give queued work a moment to reach its queue. */
export function pause(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until `count` requests are waiting at the server's hold. */
export function waitingAtServer(server: OAuthMcpServer, count = 1) {
  return eventually(async () => server.waitingRequests() >= count);
}

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

/** Where the OAuth callback sent the browser. */
export type CallbackOutcome =
  | { authorized: true }
  | { authorized: false; error: string };

/**
 * Send the browser to an OAuth callback URL, through the worker's routing,
 * and report which page the agent redirected it to.
 */
export async function followCallback(
  callbackUrl: string
): Promise<CallbackOutcome> {
  const response = await exports.default.fetch(
    new Request(callbackUrl, { redirect: "manual" })
  );
  await response.body?.cancel();
  const location = new URL(
    response.headers.get("location") ?? "",
    CLIENT_ORIGIN
  );
  if (location.pathname === OAUTH_SUCCESS_PATH) return { authorized: true };
  if (location.pathname === OAUTH_ERROR_PATH) {
    return {
      authorized: false,
      error: location.searchParams.get("error") ?? ""
    };
  }
  throw new Error(
    `Unexpected callback response ${response.status} ${location.href}`
  );
}

/**
 * Add the server, approve the first authorization as the user, and wait for
 * the agent to be ready. Returns the server id.
 */
export async function connectAuthorized(
  agent: IntegrationAgent,
  server: OAuthMcpServer,
  grant?: { scope: string },
  options: {
    id?: string;
    name?: string;
    url?: string;
    transport?: "auto" | "streamable-http" | "sse";
    maxAttempts?: number;
  } = {}
): Promise<string> {
  const { url = server.url, ...rest } = options;
  const added = await agent.connectServer(url, {
    callbackHost: CLIENT_ORIGIN,
    ...rest
  });
  expect(added.state).toBe("authenticating");
  if (added.state !== "authenticating") throw new Error("unreachable");
  expect(await followCallback(server.authorize(added.authUrl, grant))).toEqual({
    authorized: true
  });
  await agent.settle();
  expect((await agent.server(added.id))?.state).toBe("ready");
  return added.id;
}
