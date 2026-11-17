import { describe, expect, it, vi } from "vitest";
import { withMcpHarness } from "../shared/mcp-harness";

const SERVER = {
  url: "https://files.example.com/mcp",
  name: "files",
  callbackUrl: "https://client.example.com/callback",
  clientId: "client-1"
};

/**
 * migrateServerId moves the row and the OAuth keys in one transaction. A
 * TLA+ model of the rename (rule StoredUnderOneId) found that an object
 * dying between separate writes woke with its row under the new id and its
 * tokens under the old one. A failed write stands in for the crash here.
 */
describe("migrateServerId", () => {
  it("moves the row and the OAuth keys together", () =>
    withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      await manager.registerServer("generated", SERVER);
      const provider =
        manager.mcpConnections.generated.options.transport.authProvider;
      await provider?.saveTokens({ access_token: "a", token_type: "Bearer" });

      await manager.migrateServerId("generated", "files", "test-client");

      expect(harness.serverRows().map((row) => row.id)).toEqual(["files"]);
      expect([
        ...(await harness.storage.list({ prefix: "/test-client/" })).keys()
      ]).toEqual(["/test-client/files/client-1/token"]);
      expect(await provider?.tokens()).toMatchObject({ access_token: "a" });
    }));

  it("leaves the server whole under the old id when a key cannot be moved", () =>
    withMcpHarness(async (harness) => {
      const manager = harness.createManager();
      await manager.registerServer("generated", SERVER);
      const provider =
        manager.mcpConnections.generated.options.transport.authProvider;
      await provider?.saveTokens({ access_token: "a", token_type: "Bearer" });

      // Whichever way the keys are written, the write fails.
      const failure = new Error("storage is full");
      const puts = [
        vi.spyOn(harness.storage.kv, "put").mockImplementation(() => {
          throw failure;
        }),
        vi.spyOn(harness.storage, "put").mockRejectedValue(failure)
      ];
      await expect(
        manager.migrateServerId("generated", "files", "test-client")
      ).rejects.toThrow("storage is full");
      for (const put of puts) put.mockRestore();

      expect(harness.serverRows().map((row) => row.id)).toEqual(["generated"]);
      expect(Object.keys(manager.mcpConnections)).toEqual(["generated"]);
      expect(await provider?.tokens()).toMatchObject({ access_token: "a" });
    }));
});
