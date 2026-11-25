import { McpConnector, type McpConnectionLike } from "@cloudflare/codemode";
import { streamText, type LanguageModel } from "ai";
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

/** The tool definitions each model request carried, in order. */
type RequestTools = { name?: string }[] | undefined;

type PromptMessage = { role: string; content?: unknown };

/**
 * A model that answers "done", or, while `call` is set and the request has
 * no tool result yet, asks for that one tool call. Every request's messages
 * go to `prompts`.
 */
function createTextModel(
  requests: RequestTools[] = [],
  call?: () => { toolName: string; input: unknown } | undefined,
  prompts: PromptMessage[][] = []
): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "mcp-materialization-model",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate not implemented in mock");
    },
    doStream(options: {
      tools?: { name?: string }[];
      prompt?: PromptMessage[];
    }) {
      requests.push(options.tools);
      prompts.push(options.prompt ?? []);
      const wanted = call?.();
      const answered = options.prompt?.some((m) => m.role === "tool");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (wanted && !answered) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: "mcp-1",
              toolName: wanted.toolName,
              input: JSON.stringify(wanted.input)
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls" as const, raw: undefined },
              usage
            });
            controller.close();
            return;
          }
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

  readonly #requests: RequestTools[] = [];
  readonly #prompts: PromptMessage[][] = [];
  #call: { toolName: string; input: unknown } | undefined;
  #offerAll = false;
  /** Whether each `getTools()` call came after the MCP wait. */
  #getToolsAfterWait: boolean[] = [];

  override getModel(): LanguageModel {
    return createTextModel(this.#requests, () => this.#call, this.#prompts);
  }

  override getTools() {
    this.#getToolsAfterWait.push(this._waitForConnectionsCalls > 0);
    return {};
  }

  /**
   * Run a turn: whether every `getTools()` call in it came after the turn
   * waited for the MCP connections, so tools built from the MCP catalog see
   * servers that came up during the wait.
   */
  async getToolsFollowsWait(): Promise<boolean[]> {
    await this._ensureBulkConnection();
    this._waitForConnectionsCalls = 0;
    this.#getToolsAfterWait = [];
    await this.runTurn({ mode: "wait", input: "hello" });
    return this.#getToolsAfterWait;
  }

  /**
   * Have the model call the first MCP tool in a turn: the tool result the
   * next model request carries, as JSON.
   */
  async callThroughModel(): Promise<string> {
    await this._ensureBulkConnection();
    const [toolName] = Object.keys(this.mcp.getAITools());
    this.#offerAll = true;
    this.maxSteps = 2;
    this.#call = { toolName, input: { value: "from the model" } };
    await this.runTurn({ mode: "wait", input: "call it" });
    this.#call = undefined;
    this.#offerAll = false;
    this.maxSteps = 1;
    const next = this.#prompts.at(-1) ?? [];
    return JSON.stringify(next.filter((message) => message.role === "tool"));
  }

  override beforeTurn(ctx: TurnContext): TurnConfig | void {
    this._mcpToolCountBeforeTurn = Object.keys(ctx.tools).filter((name) =>
      name.startsWith("tool_bulkserver_")
    ).length;
    if (this.#offerAll) return;
    return { activeTools: [] };
  }

  /**
   * The MCP tools' definitions as one turn sent them to the model, and as
   * `streamText` sends `getAITools()` given directly: both as JSON, and the
   * turn's tool names in order.
   */
  async mcpToolRequests(): Promise<{
    turn: string;
    direct: string;
    order: (string | undefined)[];
  }> {
    await this._ensureBulkConnection();
    this.#offerAll = true;
    await this.runTurn({ mode: "wait", input: "hello" });
    this.#offerAll = false;
    const turn = this.#requests.at(-1) ?? [];
    const directRequests: RequestTools[] = [];
    await streamText({
      model: createTextModel(directRequests),
      tools: this.mcp.getAITools(),
      prompt: "hello"
    }).consumeStream();
    const direct = directRequests[0] ?? [];
    const names = new Set(direct.map((entry) => entry.name));
    return {
      turn: JSON.stringify(turn.filter((entry) => names.has(entry.name))),
      direct: JSON.stringify(direct),
      order: turn.map((entry) => entry.name)
    };
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

  async runWithoutDirectMcpTools(): Promise<MaterializationTurnResult> {
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
      input: "Use MCP through the connector"
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
