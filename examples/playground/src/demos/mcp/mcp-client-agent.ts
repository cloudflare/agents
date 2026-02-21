import { callable } from "agents";
import { PlaygroundAgent as Agent } from "../../shared/playground-agent";

export interface McpClientState {
  connectedServer: string | null;
  serverId: string | null;
}

export class McpClientAgent extends Agent<Env, McpClientState> {
  initialState: McpClientState = {
    connectedServer: null,
    serverId: null
  };

  @callable({ description: "Connect to an MCP server" })
  async connectToServer(url: string): Promise<{
    state: string;
    serverId?: string;
    authUrl?: string;
  }> {
    const result = await this.addMcpServer("playground", url);
    this.setState({
      connectedServer: url,
      serverId: result.id ?? null
    });
    return result;
  }

  @callable({ description: "Disconnect from the MCP server" })
  async disconnectServer(): Promise<boolean> {
    const sid = this.state.serverId;
    if (!sid) return false;
    try {
      await this.removeMcpServer(sid);
      this.setState({ connectedServer: null, serverId: null });
      return true;
    } catch {
      return false;
    }
  }

  @callable({ description: "Call a tool on the connected server" })
  async callTool(
    name: string,
    serverId: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    return await this.mcp.callTool({
      name,
      serverId,
      arguments: args
    });
  }
}
