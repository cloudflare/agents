import { describe, expect, it } from "vitest";
import {
  connectAuthorized,
  followCallback,
  newAgent,
  useOAuthMcpServer
} from "./harness";
import { READ_SCOPE } from "./oauth-mcp-server";

const server = useOAuthMcpServer();

/**
 * Replays of the bug paths TLA+ models of the MCP client module found, step
 * for step. Each names the rule it checks and the model it comes from.
 */

describe("a step-up link after a token refresh", () => {
  // McpAuthorizationTurns.tla, rule PendingLinkCompletes. Path: a step-up
  // link is pending; the access token expires and a tool call refreshes
  // it; the user completes the step-up.
  it("still completes", async () => {
    const agent = await newAgent();
    const id = await connectAuthorized(agent, server, { scope: READ_SCOPE });
    const asked = await agent.callServerTool(id, "write");
    if (asked.ok || !asked.authUrl) throw new Error("expected a link");

    server.revokeAccessTokens();
    expect(await agent.callServerTool(id, "read")).toEqual({
      ok: true,
      text: "read it"
    });
    expect(await followCallback(server.authorize(asked.authUrl))).toEqual({
      authorized: true
    });
    await agent.settle();
    expect(await agent.callServerTool(id, "write")).toEqual({
      ok: true,
      text: "wrote it"
    });
  });
});
