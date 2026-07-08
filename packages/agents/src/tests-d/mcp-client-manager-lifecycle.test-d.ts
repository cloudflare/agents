import { Agent } from "..";
import { MCPClientManager } from "../mcp/client";

class HostConfiguredMcpAgent extends Agent {
  override mcp = new MCPClientManager(this, {
    name: "my-agent",
    version: "1.0.0"
  });
}

new HostConfiguredMcpAgent({} as DurableObjectState, {});

// @ts-expect-error the standalone storage-only constructor was removed
new MCPClientManager("my-agent", { name: "my-agent", version: "1.0.0" });
