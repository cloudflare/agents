import { describe, expect, it } from "vitest";
import {
  type AgentMcpOAuthProvider,
  DurableObjectOAuthClientProvider
} from "../../mcp/client/do-oauth-client-provider";
import { withMcpHarness } from "../shared/mcp-harness";

const SERVER = {
  url: "https://files.example.com/mcp",
  name: "files",
  callbackUrl: "https://client.example.com/callback"
};

/**
 * Replay of a bug path a TLA+ model of the server lifecycle found, step for
 * step.
 */
describe("removeServer with a custom OAuth provider", () => {
  // Rule ConnectionIsStored. Path: removeServer forgets the connection, then
  // waits for the provider to clear its credentials; the server is
  // registered again meanwhile. removeServer must not then delete the row by
  // id, which is now the new server's row, or the new server is gone after
  // the next wake.
  it("keeps a server registered again while the old one's credentials were being cleared", () =>
    withMcpHarness(async (harness) => {
      let clearingStarted!: () => void;
      const clearing = new Promise<void>((resolve) => {
        clearingStarted = resolve;
      });
      let finishClearing!: () => void;
      const cleared = new Promise<void>((resolve) => {
        finishClearing = resolve;
      });
      const manager = harness.createManager({
        createAuthProvider: () =>
          ({
            serverId: undefined,
            clientId: undefined,
            authUrl: undefined,
            redirectUrl: SERVER.callbackUrl,
            // A provider that keeps credentials elsewhere, so clearing them
            // waits on I/O and other requests run meanwhile.
            async invalidateCredentials() {
              clearingStarted();
              await cleared;
            }
          }) as unknown as AgentMcpOAuthProvider
      });

      await manager.registerServer("files", SERVER);
      const removing = manager.removeServer("files");
      await clearing;
      await manager.registerServer("files", SERVER);
      finishClearing();
      await removing;

      expect(Object.keys(manager.mcpConnections)).toEqual(["files"]);
      expect(manager.listServers().map((server) => server.id)).toEqual([
        "files"
      ]);
    }));
});

/**
 * A caller that hands registerServer its own DurableObjectOAuthClientProvider
 * and registers the server again with that same provider.
 */
describe("registerServer with a provider used before", () => {
  async function storesState(provider: DurableObjectOAuthClientProvider) {
    const state = await provider.state();
    return (await provider.checkState(state)).valid;
  }

  it("keeps storing after the connection was closed", () =>
    withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const provider = new DurableObjectOAuthClientProvider(
        harness.storage,
        "test-client",
        SERVER.callbackUrl
      );
      const options = { ...SERVER, transport: { authProvider: provider } };
      await manager.registerServer("files", options);
      await manager.closeConnection("files");
      await manager.registerServer("files", options);

      expect(await storesState(provider)).toBe(true);
    }));

  it("keeps storing after the server was removed", () =>
    withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      const provider = new DurableObjectOAuthClientProvider(
        harness.storage,
        "test-client",
        SERVER.callbackUrl
      );
      const options = { ...SERVER, transport: { authProvider: provider } };
      await manager.registerServer("files", options);
      await manager.removeServer("files");
      await manager.registerServer("files", options);

      expect(await storesState(provider)).toBe(true);
    }));
});
