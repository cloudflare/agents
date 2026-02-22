import { useAgent } from "agents/react";
import { useState } from "react";
import { Button, Input, InputArea, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  ConnectionStatus,
  CodeExplanation,
  HighlightedJson,
  type CodeSection
} from "../../components";
import { useLogs, useUserId, useToast } from "../../hooks";
import type { McpClientAgent, McpClientState } from "./mcp-client-agent";

const codeSections: CodeSection[] = [
  {
    title: "Connect to external MCP servers",
    description:
      "Use this.addMcpServer() to connect your agent to any MCP server. The connection persists across restarts — the agent automatically reconnects.",
    code: `import { Agent, callable } from "agents";

class McpClientAgent extends Agent<Env> {
  @callable()
  async connectToServer(url: string) {
    const result = await this.addMcpServer("my-server", url);
    return result; // { id: "...", state: "ready" }
  }
}`
  },
  {
    title: "Reactive MCP updates with onMcpUpdate",
    description:
      "On the client, useAgent provides an onMcpUpdate callback that fires whenever the agent's MCP state changes — tools, resources, and server status arrive automatically after connecting. No need to poll.",
    code: `const agent = useAgent({
  agent: "mcp-client-agent",
  name: "demo",
  onMcpUpdate: (mcpState) => {
    // Fires automatically when MCP servers connect/disconnect
    console.log("Tools:", mcpState.tools);
    console.log("Resources:", mcpState.resources);
    console.log("Servers:", mcpState.servers);
  },
});

// Call tools via @callable on the agent
await agent.call("callTool", [toolName, serverId, args]);`
  }
];

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  serverId?: string;
}

export function McpClientDemo() {
  const userId = useUserId();
  const { logs, addLog, clearLogs } = useLogs();
  const { toast } = useToast();
  const [mcpUrl, setMcpUrl] = useState(`${window.location.origin}/mcp-server`);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [resources, setResources] = useState<unknown[]>([]);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);
  const [argsText, setArgsText] = useState("{}");
  const [toolResult, setToolResult] = useState<unknown>(null);
  const [isCallingTool, setIsCallingTool] = useState(false);

  const agent = useAgent<McpClientAgent, McpClientState>({
    agent: "mcp-client-agent",
    name: `mcp-client-${userId}`,
    onOpen: () => addLog("info", "connected"),
    onClose: () => addLog("info", "disconnected"),
    onError: () => addLog("error", "error", "Connection error"),
    onStateUpdate: (newState) => {
      if (newState?.connectedServer) {
        setIsConnected(true);
      } else {
        setIsConnected(false);
        setTools([]);
        setResources([]);
      }
    },
    onMcpUpdate: (mcpState) => {
      const discoveredTools = (mcpState.tools ?? []) as ToolInfo[];
      setTools(discoveredTools);
      setResources(mcpState.resources ?? []);
      addLog("in", "mcp_update", {
        tools: discoveredTools.length,
        resources: (mcpState.resources ?? []).length,
        servers: Object.keys(mcpState.servers ?? {}).length
      });
    }
  });

  const handleConnect = async () => {
    if (!mcpUrl.trim()) return;
    setIsConnecting(true);
    addLog("out", "connectToServer", { url: mcpUrl });

    try {
      const result = await agent.call("connectToServer", [mcpUrl]);
      addLog("in", "connected", result);
      setIsConnected(true);
      toast("Connected to MCP server", "success");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    addLog("out", "disconnectServer");
    try {
      await agent.call("disconnectServer");
      setIsConnected(false);
      setTools([]);
      setResources([]);
      setSelectedTool(null);
      setToolResult(null);
      addLog("in", "disconnected");
      toast("Disconnected", "info");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    }
  };

  const handleCallTool = async () => {
    if (!selectedTool) return;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsText);
    } catch {
      addLog("error", "error", "Invalid JSON in arguments");
      return;
    }

    const tool = tools.find((t) => t.name === selectedTool);
    const serverId = tool?.serverId ?? "";

    setIsCallingTool(true);
    setToolResult(null);
    addLog("out", "callTool", { name: selectedTool, serverId, args });

    try {
      const result = await agent.call("callTool", [
        selectedTool,
        serverId,
        args
      ]);
      addLog("in", "tool_result", result);
      setToolResult(result);
      toast(selectedTool + " called", "success");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
    } finally {
      setIsCallingTool(false);
    }
  };

  const handleSelectTool = (name: string) => {
    setSelectedTool(name);
    setToolResult(null);
    setArgsText("{}");
  };

  return (
    <DemoWrapper
      title="MCP Client"
      description={
        <>
          This agent connects to external MCP servers using{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            this.addMcpServer()
          </code>
          . Tools and resources are discovered automatically via the{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            onMcpUpdate
          </code>{" "}
          callback — no polling needed. Try connecting to the playground's own
          MCP server.
        </>
      }
      statusIndicator={
        <ConnectionStatus
          status={
            agent.readyState === WebSocket.OPEN ? "connected" : "connecting"
          }
        />
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          {/* Connect */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Connect to MCP Server</Text>
            </div>
            <div className="flex gap-2 mb-3">
              <Input
                aria-label="MCP server URL"
                type="text"
                value={mcpUrl}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setMcpUrl(e.target.value)
                }
                className="flex-1 font-mono text-xs"
                placeholder="https://..."
                disabled={isConnected}
              />
            </div>
            {isConnected ? (
              <Button
                variant="destructive"
                onClick={handleDisconnect}
                className="w-full"
              >
                Disconnect
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={handleConnect}
                disabled={isConnecting || !mcpUrl.trim()}
                className="w-full"
              >
                {isConnecting ? "Connecting..." : "Connect"}
              </Button>
            )}
          </Surface>

          {/* Discovered Tools */}
          {tools.length > 0 && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-4">
                <Text variant="heading3">
                  Discovered Tools ({tools.length})
                </Text>
              </div>
              <div className="space-y-2">
                {tools.map((tool) => (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => handleSelectTool(tool.name)}
                    className={`w-full text-left p-3 rounded border transition-colors ${
                      selectedTool === tool.name
                        ? "border-kumo-brand bg-kumo-elevated"
                        : "border-kumo-line hover:border-kumo-interact"
                    }`}
                  >
                    <code className="text-sm font-semibold text-kumo-default">
                      {tool.name}
                    </code>
                    {tool.description && (
                      <div className="mt-1">
                        <Text variant="secondary" size="xs">
                          {tool.description}
                        </Text>
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </Surface>
          )}

          {/* Discovered Resources */}
          {resources.length > 0 ? (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-2">
                <Text variant="heading3">Resources ({resources.length})</Text>
              </div>
              <HighlightedJson data={resources} />
            </Surface>
          ) : null}

          {/* Call Tool */}
          {selectedTool && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-4">
                <Text variant="heading3">Call: {selectedTool}</Text>
              </div>
              <InputArea
                aria-label="Tool arguments (JSON)"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                className="w-full h-20 font-mono text-sm mb-3"
              />
              <Button
                variant="primary"
                onClick={handleCallTool}
                disabled={isCallingTool}
                className="w-full"
              >
                {isCallingTool ? "Calling..." : `Call ${selectedTool}`}
              </Button>
            </Surface>
          )}

          {/* Tool Result */}
          {toolResult !== null && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-2">
                <Text variant="heading3">Result</Text>
              </div>
              <HighlightedJson data={toolResult} />
            </Surface>
          )}
        </div>

        {/* Logs */}
        <div className="space-y-6">
          <LogPanel logs={logs} onClear={clearLogs} maxHeight="600px" />
        </div>
      </div>

      <CodeExplanation sections={codeSections} />
    </DemoWrapper>
  );
}
