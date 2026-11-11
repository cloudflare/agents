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

/**
 * A closed connection's provider once the server has a new connection. Work
 * it started may still call it: a refresh the authorization server refuses
 * invalidates the tokens.
 */
describe("a closed connection's provider after the server is registered again", () => {
  it("neither stores nor deletes the new connection's tokens", () =>
    withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      // The same OAuth client both times, as with a client id metadata
      // document or a pre-registered client.
      const options = { ...SERVER, clientId: "client-1" };
      const tokens = (access_token: string) => ({
        access_token,
        token_type: "Bearer"
      });
      const providerOf = () => {
        const provider =
          manager.mcpConnections.files.options.transport.authProvider;
        if (!provider) throw new Error("expected a provider");
        return provider;
      };

      await manager.registerServer("files", options);
      const closed = providerOf();
      await manager.closeConnection("files");
      await manager.registerServer("files", options);
      const current = providerOf();
      await current.saveTokens(tokens("new"));

      await closed.saveTokens(tokens("late"));
      expect(await current.tokens()).toMatchObject({ access_token: "new" });
      await closed.invalidateCredentials?.("tokens");
      expect(await current.tokens()).toMatchObject({ access_token: "new" });
    }));
});

/**
 * Replay of a path the lifecycle model found (rule NewServerKeepsConnection):
 * two closes of one connection overlap, the quicker one finishes, the server
 * is registered again, and then the slower close finishes.
 */
describe("closeConnection overlapping another close", () => {
  it("does not drop the connection of the server registered again", () =>
    withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      await manager.registerServer("files", SERVER);
      const first = manager.mcpConnections.files;

      // The first close waits on the network, as terminating a session does.
      let finishClose!: () => void;
      const closing = new Promise<void>((resolve) => {
        finishClose = resolve;
      });
      const close = first.close.bind(first);
      let calls = 0;
      first.close = async () => {
        if (calls++ === 0) await closing;
        return close();
      };

      const slow = manager.closeConnection("files");
      await manager.closeConnection("files");
      await manager.registerServer("files", SERVER);
      const second = manager.mcpConnections.files;
      expect(second).not.toBe(first);

      finishClose();
      await slow;

      expect(manager.mcpConnections.files).toBe(second);
    }));
});

/**
 * Replay of a path the lifecycle model found (rule RemovalLeavesNewServer):
 * a removal's close is slow, an overlapping close finishes first, the server
 * is registered again and starts a sign-in, and then the removal carries on.
 */
describe("removeServer overlapping a close", () => {
  it("leaves the row and the OAuth storage of the server registered again", () =>
    withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      await manager.registerServer("files", SERVER);
      const first = manager.mcpConnections.files;

      let finishClose!: () => void;
      const closing = new Promise<void>((resolve) => {
        finishClose = resolve;
      });
      const close = first.close.bind(first);
      let calls = 0;
      first.close = async () => {
        if (calls++ === 0) await closing;
        return close();
      };

      const removing = manager.removeServer("files");
      await manager.closeConnection("files");
      await manager.registerServer("files", SERVER);
      const provider =
        manager.mcpConnections.files.options.transport.authProvider;
      if (!provider) throw new Error("expected a provider");
      // The new server's sign-in is under way: its state is stored.
      const state = await provider.state();

      finishClose();
      await removing;

      expect(harness.serverRows().map((row) => row.id)).toEqual(["files"]);
      expect(manager.mcpConnections.files).toBeDefined();
      expect((await provider.checkState(state)).valid).toBe(true);
    }));
});
