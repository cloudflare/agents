import { useState } from "react";
import { Button, Input, InputArea, Surface, Text } from "@cloudflare/kumo";
import { DemoWrapper } from "../../layout";
import {
  LogPanel,
  CodeExplanation,
  HighlightedJson,
  type CodeSection
} from "../../components";
import { useLogs, useToast } from "../../hooks";

const codeSections: CodeSection[] = [
  {
    title: "Create an MCP server agent",
    description:
      'Extend McpAgent instead of Agent. Create an McpServer instance and register tools, resources, and prompts in the init() method. Deploy with McpAgent.serve("/mcp") to expose the MCP protocol endpoint.',
    code: `import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

class PlaygroundMcpServer extends McpAgent<Env> {
  server = new McpServer({ name: "playground", version: "1.0.0" });

  async init() {
    this.server.registerTool(
      "roll_dice",
      {
        description: "Roll dice with N sides",
        inputSchema: { sides: z.number().default(6) },
      },
      async ({ sides }) => ({
        content: [{ type: "text", text: String(Math.floor(Math.random() * sides) + 1) }],
      })
    );

    this.server.resource("info", "playground://info", async (uri) => ({
      contents: [{ uri: uri.href, text: "Server info..." }],
    }));
  }
}

// Expose the MCP server at /mcp
export default PlaygroundMcpServer.serve("/mcp", {
  binding: "PlaygroundMcpServer",
});`
  },
  {
    title: "Connect from any MCP client",
    description:
      "Once deployed, any MCP-compatible client (Claude, Cursor, custom apps) can connect to your agent's URL and use its tools and resources.",
    code: `// In Claude Desktop or Cursor settings:
{
  "mcpServers": {
    "playground": {
      "url": "https://your-app.workers.dev/mcp"
    }
  }
}`
  }
];

const TOOLS = [
  {
    name: "roll_dice",
    description: "Roll one or more dice with a given number of sides",
    defaultArgs: { sides: 6, count: 2 }
  },
  {
    name: "generate_uuid",
    description: "Generate one or more random UUIDs",
    defaultArgs: { count: 3 }
  },
  {
    name: "word_count",
    description: "Count words, characters, and lines in text",
    defaultArgs: { text: "The quick brown fox jumps over the lazy dog" }
  },
  {
    name: "hash_text",
    description: "Compute SHA-256 hash of text",
    defaultArgs: { text: "hello world" }
  }
];

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream"
};

async function mcpRequest(
  url: string,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
): Promise<{ data: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params
    })
  });

  const newSessionId = response.headers.get("Mcp-Session-Id");
  const contentType = response.headers.get("Content-Type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const lines = text.split("\n");
    let lastData: unknown = null;
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          lastData = JSON.parse(line.slice(6));
        } catch {
          // skip non-JSON data lines
        }
      }
    }
    return { data: lastData, sessionId: newSessionId };
  }

  const data = await response.json();
  return { data, sessionId: newSessionId };
}

async function ensureSession(
  url: string,
  currentSessionId: string | null
): Promise<string> {
  if (currentSessionId) return currentSessionId;

  const { sessionId } = await mcpRequest(url, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "playground", version: "1.0.0" }
  });

  if (sessionId) {
    await mcpRequest(url, "notifications/initialized", {}, sessionId);
  }

  return sessionId ?? "";
}

export function McpServerDemo() {
  const { logs, addLog, clearLogs } = useLogs();
  const { toast } = useToast();
  const [selectedTool, setSelectedTool] = useState(0);
  const [argsText, setArgsText] = useState(
    JSON.stringify(TOOLS[0].defaultArgs, null, 2)
  );
  const [result, setResult] = useState<unknown>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const mcpUrl = `${window.location.origin}/mcp-server`;

  const handleSelectTool = (index: number) => {
    setSelectedTool(index);
    setArgsText(JSON.stringify(TOOLS[index].defaultArgs, null, 2));
    setResult(null);
  };

  const handleCallTool = async () => {
    const tool = TOOLS[selectedTool];
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsText);
    } catch {
      addLog("error", "error", "Invalid JSON in arguments");
      return;
    }

    setIsRunning(true);
    setResult(null);

    try {
      const sid = await ensureSession(mcpUrl, sessionId);
      if (!sessionId && sid) {
        setSessionId(sid);
        addLog("info", "session", { id: sid });
      }

      addLog("out", "call_tool", { name: tool.name, args });
      const { data } = await mcpRequest(
        mcpUrl,
        "tools/call",
        { name: tool.name, arguments: args },
        sid
      );
      addLog("in", "result", data);
      setResult(data);
      toast(tool.name + " called", "success");
    } catch (e) {
      addLog("error", "error", e instanceof Error ? e.message : String(e));
      toast(e instanceof Error ? e.message : String(e), "error");
      setSessionId(null);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <DemoWrapper
      title="MCP Server"
      description={
        <>
          This playground exposes a real MCP server at{" "}
          <code className="text-xs bg-kumo-fill px-1 py-0.5 rounded">
            /mcp-server
          </code>
          . It registers tools (roll_dice, generate_uuid, word_count, hash_text)
          and a resource. Any MCP-compatible client — Claude, Cursor, or the MCP
          Client demo on the next page — can connect and use them. Test the
          tools below.
        </>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Controls */}
        <div className="space-y-6">
          {/* Server URL */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-2">
              <Text variant="heading3">MCP Server URL</Text>
            </div>
            <div className="flex gap-2">
              <Input
                aria-label="MCP server URL"
                type="text"
                value={mcpUrl}
                readOnly
                className="flex-1 font-mono text-xs"
              />
              <Button
                variant="secondary"
                onClick={() => navigator.clipboard.writeText(mcpUrl)}
              >
                Copy
              </Button>
            </div>
            <p className="text-xs text-kumo-subtle mt-2">
              Add this URL to Claude Desktop, Cursor, or any MCP client
            </p>
          </Surface>

          {/* Available Tools */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Available Tools</Text>
            </div>
            <div className="space-y-2">
              {TOOLS.map((tool, i) => (
                <button
                  key={tool.name}
                  type="button"
                  onClick={() => handleSelectTool(i)}
                  className={`w-full text-left p-3 rounded border transition-colors ${
                    selectedTool === i
                      ? "border-kumo-brand bg-kumo-elevated"
                      : "border-kumo-line hover:border-kumo-interact"
                  }`}
                >
                  <code className="text-sm font-semibold text-kumo-default">
                    {tool.name}
                  </code>
                  <div className="mt-1">
                    <Text variant="secondary" size="xs">
                      {tool.description}
                    </Text>
                  </div>
                </button>
              ))}
            </div>
          </Surface>

          {/* Test Tool */}
          <Surface className="p-4 rounded-lg ring ring-kumo-line">
            <div className="mb-4">
              <Text variant="heading3">Test: {TOOLS[selectedTool].name}</Text>
            </div>
            <InputArea
              aria-label="Tool arguments (JSON)"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              className="w-full h-24 font-mono text-sm mb-3"
            />
            <Button
              variant="primary"
              onClick={handleCallTool}
              disabled={isRunning}
              className="w-full"
            >
              {isRunning ? "Calling..." : `Call ${TOOLS[selectedTool].name}`}
            </Button>
          </Surface>

          {/* Result */}
          {result !== null && (
            <Surface className="p-4 rounded-lg ring ring-kumo-line">
              <div className="mb-2">
                <Text variant="heading3">Result</Text>
              </div>
              <HighlightedJson data={result} />
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
