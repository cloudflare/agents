import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { resolveRpcTransport } from "../../mcp/client/rpc";
import type { MCPServerRow } from "../../mcp/client/storage";

const server: MCPServerRow = {
  id: "rpc-server",
  name: "RPC server",
  server_url: "rpc:server",
  client_id: null,
  auth_url: null,
  callback_url: "",
  server_options: JSON.stringify({
    bindingName: "MCP_OBJECT",
    props: { userId: "u1" }
  })
};

describe("RPC MCP transport resolution", () => {
  it("explains that restoring needs env", () => {
    expect(resolveRpcTransport(undefined, server)).toEqual({
      _tag: "unresolved",
      reason:
        "no env was provided; pass { env } when constructing MCPClientManager"
    });
  });

  it("explains a missing binding", () => {
    expect(
      resolveRpcTransport(env, {
        ...server,
        server_options: JSON.stringify({ bindingName: "NOT_BOUND" })
      })
    ).toEqual({
      _tag: "unresolved",
      reason: 'binding "NOT_BOUND" not found in env'
    });
  });

  it("builds the transport from the persisted binding name and props", () => {
    const resolved = resolveRpcTransport(env, server);
    expect(resolved._tag).toBe("resolved");
    if (resolved._tag !== "resolved") return;
    expect(resolved.transport.type).toBe("rpc");
    expect(resolved.transport.name).toBe("server");
    expect(resolved.transport.props).toEqual({ userId: "u1" });
  });
});
