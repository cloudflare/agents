import { McpConnector, type McpConnectionLike } from "@cloudflare/codemode";
import type { LanguageModel } from "ai";
import { Think } from "../../think";
import type { TurnConfig, TurnContext } from "../../think";

const SERVER_ID = "bulk-server";
const TOOL_COUNT = 313;

type MaterializationTurnResult = {
  status: string;
  getAIToolsCalls: number;
  waitForConnectionsCalls: number;
  mcpToolCountBeforeTurn: number;
  rawConnectorResult: {
    name: string;
    arguments: { value: string };
  };
};

const finishReason = { unified: "stop" as const, raw: undefined };
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
};

function createTextModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mcp-materialization-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({
            type: "text-delta",
            id: "text",
            delta: "done"
          });
          controller.enqueue({ type: "text-end", id: "text" });
          controller.enqueue({ type: "finish", finishReason, usage });
          controller.close();
        }
      });
      return Promise.resolve({ stream });
    }
  } as LanguageModel;
}

class BulkMcpConnector extends McpConnector<Cloudflare.Env> {
  constructor(
    ctx: DurableObjectState,
    env: Cloudflare.Env,
    private readonly connection: McpConnectionLike
  ) {
    super(ctx, env);
  }

  name(): string {
    return "bulk";
  }

  protected createConnection(): McpConnectionLike {
    return this.connection;
  }
}

export class ThinkMcpToolMaterializationAgent extends Think {
  private _getAIToolsCalls = 0;
  private _waitForConnectionsCalls = 0;
  private _mcpToolCountBeforeTurn = 0;
  private _connector?: BulkMcpConnector;

  override maxSteps = 1;
  override waitForMcpConnections = true;

  override getModel(): LanguageModel {
    return createTextModel();
  }

  override beforeTurn(ctx: TurnContext): TurnConfig {
    this._mcpToolCountBeforeTurn = Object.keys(ctx.tools).filter((name) =>
      name.startsWith("tool_bulkserver_")
    ).length;
    return { activeTools: [] };
  }

  private async _ensureBulkConnection(): Promise<void> {
    if (this._connector) return;

    await this.mcp.registerServer(SERVER_ID, {
      url: "http://localhost/mcp",
      name: "Bulk test server"
    });
    const connection = this.mcp.mcpConnections[SERVER_ID];
    connection.connectionState = "ready";
    connection.tools = Array.from({ length: TOOL_COUNT }, (_, index) => ({
      name: `bulk_tool_${index}`,
      description: `Bulk tool ${index}`,
      inputSchema: {
        type: "object" as const,
        properties: { value: { type: "string" as const } }
      },
      outputSchema: {
        type: "object" as const,
        properties: { echoed: { type: "string" as const } }
      }
    }));
    connection.client.callTool = (async (request: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            name: request.name,
            arguments: request.arguments
          })
        }
      ]
    })) as typeof connection.client.callTool;

    const originalGetAITools = this.mcp.getAITools.bind(this.mcp);
    this.mcp.getAITools = (filter) => {
      this._getAIToolsCalls++;
      return originalGetAITools(filter);
    };
    const originalWaitForConnections = this.mcp.waitForConnections.bind(
      this.mcp
    );
    this.mcp.waitForConnections = async (options) => {
      this._waitForConnectionsCalls++;
      return originalWaitForConnections(options);
    };

    this._connector = new BulkMcpConnector(this.ctx, this.env, connection);
  }

  async runTransportOnlyMaterializationTurn(): Promise<MaterializationTurnResult> {
    return this._runMaterializationTurn(false);
  }

  async runDefaultMaterializationTurn(): Promise<MaterializationTurnResult> {
    return this._runMaterializationTurn();
  }

  private async _runMaterializationTurn(
    includeMcpTools?: boolean
  ): Promise<MaterializationTurnResult> {
    await this._ensureBulkConnection();
    if (includeMcpTools !== undefined) {
      (
        this as Think & {
          includeMcpTools: boolean;
        }
      ).includeMcpTools = includeMcpTools;
    }
    this._getAIToolsCalls = 0;
    this._waitForConnectionsCalls = 0;
    this._mcpToolCountBeforeTurn = 0;

    const result = await this.runTurn({
      mode: "wait",
      input: "Use transport-only MCP access"
    });
    if (!this._connector) throw new Error("MCP connector was not initialized");
    const rawConnectorResult = (await this._connector.executeTool(
      "bulk_tool_0",
      { value: "raw" }
    )) as MaterializationTurnResult["rawConnectorResult"];

    return {
      status: result.status,
      getAIToolsCalls: this._getAIToolsCalls,
      waitForConnectionsCalls: this._waitForConnectionsCalls,
      mcpToolCountBeforeTurn: this._mcpToolCountBeforeTurn,
      rawConnectorResult
    };
  }
}
