import { describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "../../mcp/client";
import { restoreRpcConnections } from "../../mcp/client/rpc";
import type { MCPServerRow } from "../../mcp/client/storage";

const server: MCPServerRow = {
  id: "rpc-server",
  name: "RPC server",
  server_url: "rpc://server",
  client_id: null,
  auth_url: null,
  callback_url: "",
  server_options: JSON.stringify({ bindingName: "MCP_OBJECT" })
};

function manager(): Pick<
  MCPClientManager,
  "connect" | "discoverIfConnected" | "mcpConnections"
> {
  return {
    connect: vi.fn(),
    discoverIfConnected: vi.fn(),
    mcpConnections: {}
  };
}

describe("RPC MCP connection restoration", () => {
  it("warns when persisted RPC servers cannot be restored without env", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await restoreRpcConnections(manager(), undefined, [server]);

      expect(warn).toHaveBeenCalledWith(
        '[MCPClientManager] Cannot restore RPC MCP server "RPC server": ' +
          "no env was provided; pass { env } when constructing MCPClientManager"
      );
    } finally {
      warn.mockRestore();
    }
  });
});
