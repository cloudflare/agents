import { describe, expect, it } from "vitest";
import { newAgent, useOAuthMcpServers } from "./harness";
import { CLIENT_ORIGIN } from "./oauth-mcp-server";

// A public MCP server whose OAuth metadata names an authorization server on
// a private address.
const [, server] = useOAuthMcpServers({
  origin: "https://private-auth.example.com",
  authOrigin: "http://10.0.0.7"
});

describe("MCP client URL policy in an Agent", () => {
  it("refuses an authorization server on a private address that a public server names", async () => {
    const agent = await newAgent();
    const added = await agent.connectServer(server.url, {
      callbackHost: CLIENT_ORIGIN
    });

    expect(added.state).toBe("error");
    if (added.state !== "error") throw new Error("unreachable");
    expect(added.message).toContain("Blocked URL");
    expect(server.authorizationRequests()).toBe(0);
  });
});
