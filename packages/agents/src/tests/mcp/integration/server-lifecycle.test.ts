import { describe, expect, it } from "vitest";
import {
  connectAuthorized,
  newAgent,
  pause,
  restartAgent,
  waitingAtServer,
  useOAuthMcpServer
} from "./harness";
import { CLIENT_ORIGIN, MCP_URL } from "./oauth-mcp-server";

const server = useOAuthMcpServer();

/**
 * Replays of the bug paths a TLA+ model of the server lifecycle found, step
 * for step. Each asserts the rule the model checks.
 */
describe("a server removed and added again under the same id", () => {
  // Rule FailureIsOwn. Path: the wake's connect is in flight; the server is
  // removed and added again; the old connect returns and sees the connection
  // was replaced. On its last attempt, bringUp must not record that failure
  // on the new server.
  it("is never marked failed by its removed predecessor's connect", async () => {
    const before = await newAgent();
    await connectAuthorized(before, server, undefined, { id: "files" });

    // The wake's restore connects; its token refresh waits at the
    // authorization server, where closing the connection cannot abort it.
    server.revokeAccessTokens();
    const release = server.holdRequests("token");
    const agent = await restartAgent(before);
    await waitingAtServer(server);

    await agent.remove("files");
    const adding = agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    await pause();
    release();
    expect((await adding).state).toBe("authenticating");
    await agent.settle();

    const history = await agent.serverHistory("files");
    expect(history.filter((view) => view.state === "failed")).toEqual([]);
    expect((await agent.server("files"))?.error).toBeNull();
  });

  // Rule OldWorkLeavesNewServerAlone. Path: as above with a second quick
  // attempt. The old connect's retry must stop, not connect the new server
  // that its own add connects.
  it("is connected once, by its own add, not by the removed server's retry", async () => {
    const before = await newAgent();
    await connectAuthorized(before, server, undefined, {
      id: "files",
      maxAttempts: 2
    });

    server.revokeAccessTokens();
    const release = server.holdRequests("token");
    const agent = await restartAgent(before);
    await waitingAtServer(server);

    await agent.remove("files");
    server.unauthorizedMethods.length = 0;
    const adding = agent.connectServer(MCP_URL, {
      callbackHost: CLIENT_ORIGIN,
      id: "files"
    });
    await pause();
    release();
    expect((await adding).state).toBe("authenticating");
    await agent.settle();

    // The new server has no grant, so its one handshake gets one 401.
    expect(server.unauthorizedMethods).toEqual(["server/discover"]);
  });
});
