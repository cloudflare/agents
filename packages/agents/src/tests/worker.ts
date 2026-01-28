import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  IsomorphicHeaders,
  ServerNotification,
  ServerRequest
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpAgent } from "../mcp/index.ts";
import {
  Agent,
  callable,
  routeAgentRequest,
  type AgentEmail,
  type Connection,
  type WSMessage,
  type WorkflowStatus,
  type WorkflowInfo
} from "../index.ts";
import type { MCPClientConnection } from "../mcp/client-connection";

// Re-export test workflows for wrangler
export { TestProcessingWorkflow, SimpleTestWorkflow } from "./test-workflow";

export type Env = {
  MCP_OBJECT: DurableObjectNamespace<McpAgent>;
  EmailAgent: DurableObjectNamespace<TestEmailAgent>;
  CaseSensitiveAgent: DurableObjectNamespace<TestCaseSensitiveAgent>;
  UserNotificationAgent: DurableObjectNamespace<TestUserNotificationAgent>;
  TestOAuthAgent: DurableObjectNamespace<TestOAuthAgent>;
  TEST_MCP_JURISDICTION: DurableObjectNamespace<TestMcpJurisdiction>;
  TestDestroyScheduleAgent: DurableObjectNamespace<TestDestroyScheduleAgent>;
  TestScheduleAgent: DurableObjectNamespace<TestScheduleAgent>;
  TestWorkflowAgent: DurableObjectNamespace<TestWorkflowAgent>;
  // Workflow bindings for integration testing
  TEST_WORKFLOW: Workflow;
  SIMPLE_WORKFLOW: Workflow;
};

type State = unknown;

type Props = {
  testValue: string;
};

type ToolExtraInfo = RequestHandlerExtra<ServerRequest, ServerNotification>;

type EchoResponseData = {
  headers: IsomorphicHeaders;
  authInfo: ToolExtraInfo["authInfo"] | null;
  hasRequestInfo: boolean;
  hasAuthInfo: boolean;
  requestId: ToolExtraInfo["requestId"];
  sessionId: string | null;
  availableExtraKeys: string[];
  [key: string]: unknown;
};

export class TestMcpAgent extends McpAgent<Env, State, Props> {
  observability = undefined;
  private tempToolHandle?: { remove: () => void };

  server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true }
        // disable because types started failing in 1.22.0
        // elicitation: { form: {}, url: {} }
      }
    }
  );

  async init() {
    this.server.registerTool(
      "greet",
      {
        description: "A simple greeting tool",
        inputSchema: { name: z.string().describe("Name to greet") }
      },
      async ({ name }) => {
        return { content: [{ text: `Hello, ${name}!`, type: "text" }] };
      }
    );

    this.server.registerTool(
      "getPropsTestValue",
      {
        description: "Get the test value"
      },
      async () => {
        return {
          content: [
            { text: this.props?.testValue ?? "unknown", type: "text" as const }
          ]
        };
      }
    );

    this.server.registerTool(
      "emitLog",
      {
        description: "Emit a logging/message notification",
        inputSchema: {
          level: z.enum(["debug", "info", "warning", "error"]),
          message: z.string()
        }
      },
      async ({ level, message }) => {
        // Force a logging message to be sent when the tool is called
        await this.server.server.sendLoggingMessage({
          level,
          data: message
        });
        return {
          content: [{ type: "text", text: `logged:${level}` }]
        };
      }
    );

    this.server.tool(
      "elicitName",
      "Test tool that elicits user input for a name",
      {},
      async () => {
        const result = await this.server.server.elicitInput({
          message: "What is your name?",
          requestedSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Your name"
              }
            },
            required: ["name"]
          }
        });

        if (result.action === "accept" && result.content?.name) {
          return {
            content: [
              {
                type: "text",
                text: `You said your name is: ${result.content.name}`
              }
            ]
          };
        }

        return {
          content: [{ type: "text", text: "Elicitation cancelled" }]
        };
      }
    );

    // Use `registerTool` so we can later remove it.
    // Triggers notifications/tools/list_changed
    this.server.registerTool(
      "installTempTool",
      {
        description: "Register a temp tool",
        inputSchema: {}
      },
      async () => {
        if (!this.tempToolHandle) {
          this.tempToolHandle = this.server.registerTool(
            "temp-echo",
            {
              description: "Echo text (temporary tool)",
              inputSchema: { what: z.string().describe("Text to echo") }
            },
            async ({ what }) => {
              return { content: [{ type: "text", text: `echo:${what}` }] };
            }
          );
        }
        return { content: [{ type: "text", text: "temp tool installed" }] };
      }
    );

    // Remove the dynamically added tool.
    this.server.registerTool(
      "uninstallTempTool",
      {
        description: "Remove the temporary tool if present"
      },
      async () => {
        if (this.tempToolHandle?.remove) {
          this.tempToolHandle.remove();
          this.tempToolHandle = undefined;
          return {
            content: [{ type: "text" as const, text: "temp tool removed" }]
          };
        }
        return {
          content: [{ type: "text" as const, text: "nothing to remove" }]
        };
      }
    );

    // Echo request info for testing header and auth passthrough
    this.server.tool(
      "echoRequestInfo",
      "Echo back request headers and auth info",
      {},
      async (_args, extra: ToolExtraInfo): Promise<CallToolResult> => {
        // Extract headers from requestInfo, auth from authInfo
        const headers: IsomorphicHeaders = extra.requestInfo?.headers ?? {};
        const authInfo = extra.authInfo ?? null;

        // Track non-function properties available in extra
        const extraRecord = extra as Record<string, unknown>;
        const extraKeys = Object.keys(extraRecord).filter(
          (key) => typeof extraRecord[key] !== "function"
        );

        // Build response object with all available data
        const responseData: EchoResponseData = {
          headers,
          authInfo,
          hasRequestInfo: !!extra.requestInfo,
          hasAuthInfo: !!extra.authInfo,
          requestId: extra.requestId,
          // Include any sessionId if it exists
          sessionId: extra.sessionId ?? null,
          // List all available properties in extra
          availableExtraKeys: extraKeys
        };

        // Add any other properties from extra that aren't already included
        extraKeys.forEach((key) => {
          if (
            !["requestInfo", "authInfo", "requestId", "sessionId"].includes(key)
          ) {
            responseData[`extra_${key}`] = extraRecord[key];
          }
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(responseData, null, 2)
            }
          ]
        };
      }
    );
  }
}

// Test email agents
export class TestEmailAgent extends Agent<Env> {
  observability = undefined;
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  // Override onError to avoid console.error which triggers queueMicrotask issues
  override onError(error: unknown): void {
    // Silently handle errors in tests
    throw error;
  }
}

export class TestCaseSensitiveAgent extends Agent<Env> {
  observability = undefined;
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  override onError(error: unknown): void {
    throw error;
  }
}

export class TestUserNotificationAgent extends Agent<Env> {
  observability = undefined;
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  override onError(error: unknown): void {
    throw error;
  }
}

export class TestDestroyScheduleAgent extends Agent<Env, { status: string }> {
  observability = undefined;
  initialState = {
    status: "unscheduled"
  };

  async scheduleSelfDestructingAlarm() {
    this.setState({ status: "scheduled" });
    await this.schedule(0, "destroy");
  }

  getStatus() {
    return this.state.status;
  }
}

export class TestScheduleAgent extends Agent<Env> {
  observability = undefined;

  // A no-op callback method for testing schedules
  testCallback() {
    // Intentionally empty - used for testing schedule creation
  }

  @callable()
  async cancelScheduleById(id: string): Promise<boolean> {
    return this.cancelSchedule(id);
  }

  @callable()
  async getScheduleById(id: string) {
    return this.getSchedule(id);
  }

  @callable()
  async createSchedule(delaySeconds: number): Promise<string> {
    const schedule = await this.schedule(delaySeconds, "testCallback");
    return schedule.id;
  }
}

// Test Agent for Workflow integration
export class TestWorkflowAgent extends Agent<Env> {
  observability = undefined;

  // Track callbacks received for testing
  private _callbacksReceived: Array<{
    type: string;
    workflowName: string;
    workflowId: string;
    data: unknown;
  }> = [];

  getCallbacksReceived(): Array<{
    type: string;
    workflowName: string;
    workflowId: string;
    data: unknown;
  }> {
    return this._callbacksReceived;
  }

  clearCallbacks(): void {
    this._callbacksReceived = [];
  }

  // Helper to insert workflow tracking directly (for testing duplicate ID handling)
  insertWorkflowTracking(workflowId: string, workflowName: string): void {
    const id = `test-${workflowId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      this.sql`
        INSERT INTO cf_agents_workflows (id, workflow_id, workflow_name, status)
        VALUES (${id}, ${workflowId}, ${workflowName}, 'queued')
      `;
    } catch (e) {
      if (
        e instanceof Error &&
        e.message.includes("UNIQUE constraint failed")
      ) {
        throw new Error(
          `Workflow with ID "${workflowId}" is already being tracked`
        );
      }
      throw e;
    }
  }

  // Override lifecycle callbacks to track them
  async onWorkflowProgress(
    workflowName: string,
    workflowId: string,
    progress: unknown
  ): Promise<void> {
    this._callbacksReceived.push({
      type: "progress",
      workflowName,
      workflowId,
      data: { progress }
    });
  }

  async onWorkflowComplete(
    workflowName: string,
    workflowId: string,
    result?: unknown
  ): Promise<void> {
    this._callbacksReceived.push({
      type: "complete",
      workflowName,
      workflowId,
      data: { result }
    });
  }

  async onWorkflowError(
    workflowName: string,
    workflowId: string,
    error: string
  ): Promise<void> {
    this._callbacksReceived.push({
      type: "error",
      workflowName,
      workflowId,
      data: { error }
    });
  }

  async onWorkflowEvent(
    workflowName: string,
    workflowId: string,
    event: unknown
  ): Promise<void> {
    this._callbacksReceived.push({
      type: "event",
      workflowName,
      workflowId,
      data: { event }
    });
  }

  // Test helper to insert a workflow tracking record directly
  async insertTestWorkflow(
    workflowId: string,
    workflowName: string,
    status: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const id = crypto.randomUUID();
    this.sql`
      INSERT INTO cf_agents_workflows (id, workflow_id, workflow_name, status, metadata)
      VALUES (${id}, ${workflowId}, ${workflowName}, ${status}, ${metadata ? JSON.stringify(metadata) : null})
    `;
    return id;
  }

  // Expose getWorkflow for testing
  async getWorkflowById(workflowId: string): Promise<WorkflowInfo | null> {
    return this.getWorkflow(workflowId) ?? null;
  }

  // Expose getWorkflows for testing
  async queryWorkflows(criteria?: {
    status?: WorkflowStatus | WorkflowStatus[];
    workflowName?: string;
    metadata?: Record<string, string | number | boolean>;
    limit?: number;
    orderBy?: "asc" | "desc";
  }): Promise<WorkflowInfo[]> {
    return this.getWorkflows(criteria);
  }

  // Expose deleteWorkflow for testing
  async deleteWorkflowById(workflowId: string): Promise<boolean> {
    return this.deleteWorkflow(workflowId);
  }

  // Expose deleteWorkflows for testing
  async deleteWorkflowsByCriteria(criteria?: {
    status?: WorkflowStatus | WorkflowStatus[];
    workflowName?: string;
    metadata?: Record<string, string | number | boolean>;
    olderThan?: Date;
  }): Promise<number> {
    return this.deleteWorkflows(criteria);
  }

  // Expose migrateWorkflowBinding for testing
  migrateWorkflowBindingTest(oldName: string, newName: string): number {
    return this.migrateWorkflowBinding(oldName, newName);
  }

  // Test helper to update workflow status directly
  async updateWorkflowStatus(
    workflowId: string,
    status: string
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.sql`
      UPDATE cf_agents_workflows
      SET status = ${status}, updated_at = ${now}
      WHERE workflow_id = ${workflowId}
    `;
  }

  // Track workflow results for testing RPC calls from workflows
  private _workflowResults: Array<{ taskId: string; result: unknown }> = [];

  getWorkflowResults(): Array<{ taskId: string; result: unknown }> {
    return this._workflowResults;
  }

  clearWorkflowResults(): void {
    this._workflowResults = [];
  }

  // Called by workflows via RPC to record results
  async recordWorkflowResult(taskId: string, result: unknown): Promise<void> {
    this._workflowResults.push({ taskId, result });
  }

  // Start a workflow using the Agent's runWorkflow method
  async runWorkflowTest(
    workflowId: string,
    params: { taskId: string; shouldFail?: boolean; waitForApproval?: boolean }
  ): Promise<string> {
    return this.runWorkflow("TEST_WORKFLOW", params, { id: workflowId });
  }

  // Start a simple workflow
  async runSimpleWorkflowTest(
    workflowId: string,
    params: { value: string }
  ): Promise<string> {
    return this.runWorkflow("SIMPLE_WORKFLOW", params, {
      id: workflowId
    });
  }

  // Send an event to a workflow
  async sendApprovalEvent(
    workflowId: string,
    approved: boolean,
    reason?: string
  ): Promise<void> {
    await this.sendWorkflowEvent("TEST_WORKFLOW", workflowId, {
      type: "approval",
      payload: { approved, reason }
    });
  }

  // Get workflow status from Cloudflare
  async getCloudflareWorkflowStatus(workflowId: string) {
    return this.getWorkflowStatus("TEST_WORKFLOW", workflowId);
  }
}

// An Agent that tags connections in onConnect,
// then echoes whether the tag was observed in onMessage
export class TestRaceAgent extends Agent<Env> {
  initialState = { hello: "world" };
  static options = { hibernate: true };

  observability = undefined;

  async onConnect(conn: Connection<{ tagged: boolean }>) {
    // Simulate real async setup to widen the window a bit
    conn.setState({ tagged: true });
  }

  async onMessage(conn: Connection<{ tagged: boolean }>, _: WSMessage) {
    const tagged = !!conn.state?.tagged;
    // Echo a single JSON frame so the test can assert ordering
    conn.send(JSON.stringify({ type: "echo", tagged }));
  }
}

// Test Agent for OAuth client side flows
export class TestOAuthAgent extends Agent<Env> {
  observability = undefined;

  async onRequest(_request: Request): Promise<Response> {
    return new Response("Test OAuth Agent");
  }

  // Allow tests to configure OAuth callback behavior
  configureOAuthForTest(config: {
    successRedirect?: string;
    errorRedirect?: string;
    useJsonHandler?: boolean; // Use built-in JSON response handler for testing
  }): void {
    if (config.useJsonHandler) {
      this.mcp.configureOAuthCallback({
        customHandler: (result: {
          serverId: string;
          authSuccess: boolean;
          authError?: string;
        }) => {
          return new Response(
            JSON.stringify({
              custom: true,
              serverId: result.serverId,
              success: result.authSuccess,
              error: result.authError
            }),
            {
              status: result.authSuccess ? 200 : 401,
              headers: { "content-type": "application/json" }
            }
          );
        }
      });
    } else {
      this.mcp.configureOAuthCallback(config);
    }
  }

  private mockStateStorage: Map<
    string,
    { serverId: string; createdAt: number }
  > = new Map();

  private createMockMcpConnection(
    serverId: string,
    serverUrl: string,
    connectionState: "ready" | "authenticating" | "connecting" = "ready"
  ): MCPClientConnection {
    const self = this;
    return {
      url: new URL(serverUrl),
      connectionState,
      tools: [],
      resources: [],
      prompts: [],
      resourceTemplates: [],
      serverCapabilities: undefined,
      lastConnectedTransport: undefined,
      options: {
        transport: {
          authProvider: {
            clientId: "test-client-id",
            serverId: serverId,
            authUrl: "http://example.com/oauth/authorize",
            async checkState(
              state: string
            ): Promise<{ valid: boolean; serverId?: string; error?: string }> {
              const parts = state.split(".");
              if (parts.length !== 2) {
                return { valid: false, error: "Invalid state format" };
              }
              const [nonce, stateServerId] = parts;
              const stored = self.mockStateStorage.get(nonce);
              if (!stored) {
                return {
                  valid: false,
                  error: "State not found or already used"
                };
              }
              // Note: checkState does NOT consume the state
              if (stored.serverId !== stateServerId) {
                return { valid: false, error: "State serverId mismatch" };
              }
              const age = Date.now() - stored.createdAt;
              if (age > 10 * 60 * 1000) {
                return { valid: false, error: "State expired" };
              }
              return { valid: true, serverId: stateServerId };
            },
            async consumeState(state: string): Promise<void> {
              const parts = state.split(".");
              if (parts.length !== 2) {
                return;
              }
              const [nonce] = parts;
              self.mockStateStorage.delete(nonce);
            },
            async deleteCodeVerifier(): Promise<void> {
              // No-op for tests
            }
          }
        }
      },
      completeAuthorization: async (_code: string) => {
        this.mcp.mcpConnections[serverId].connectionState = "ready";
      },
      establishConnection: async () => {
        this.mcp.mcpConnections[serverId].connectionState = "ready";
      }
    } as unknown as MCPClientConnection;
  }

  saveStateForTest(nonce: string, serverId: string): void {
    this.mockStateStorage.set(nonce, { serverId, createdAt: Date.now() });
  }

  setupMockMcpConnection(
    serverId: string,
    serverName: string,
    serverUrl: string,
    callbackUrl: string,
    clientId?: string | null
  ): void {
    this.sql`
      INSERT OR REPLACE INTO cf_agents_mcp_servers (
        id, name, server_url, client_id, auth_url, callback_url, server_options
      ) VALUES (
        ${serverId},
        ${serverName},
        ${serverUrl},
        ${clientId ?? null},
        ${null},
        ${callbackUrl},
        ${null}
      )
    `;
    this.mcp.mcpConnections[serverId] = this.createMockMcpConnection(
      serverId,
      serverUrl,
      "ready"
    );
  }

  async setupMockOAuthState(
    serverId: string,
    _code: string,
    _state: string,
    options?: { createConnection?: boolean }
  ): Promise<void> {
    if (options?.createConnection) {
      const server = this.getMcpServerFromDb(serverId);
      if (!server) {
        throw new Error(
          `Test error: Server ${serverId} not found in DB. Set up DB record before calling setupMockOAuthState.`
        );
      }

      this.mcp.mcpConnections[serverId] = this.createMockMcpConnection(
        serverId,
        server.server_url,
        "authenticating"
      );
    } else if (this.mcp.mcpConnections[serverId]) {
      const conn = this.mcp.mcpConnections[serverId];
      conn.connectionState = "authenticating";
      conn.completeAuthorization = async (_code: string) => {
        this.mcp.mcpConnections[serverId].connectionState = "ready";
      };
    }
  }

  getMcpServerFromDb(serverId: string) {
    const servers = this.sql<{
      id: string;
      name: string;
      server_url: string;
      client_id: string | null;
      auth_url: string | null;
      callback_url: string;
      server_options: string | null;
    }>`
      SELECT id, name, server_url, client_id, auth_url, callback_url, server_options
      FROM cf_agents_mcp_servers
      WHERE id = ${serverId}
    `;
    return servers.length > 0 ? servers[0] : null;
  }

  isCallbackUrlRegistered(callbackUrl: string): boolean {
    return this.mcp.isCallbackRequest(new Request(callbackUrl));
  }

  testIsCallbackRequest(request: Request): boolean {
    return this.mcp.isCallbackRequest(request);
  }

  removeMcpConnection(serverId: string): void {
    delete this.mcp.mcpConnections[serverId];
  }

  hasMcpConnection(serverId: string): boolean {
    return !!this.mcp.mcpConnections[serverId];
  }

  resetMcpStateRestoredFlag(): void {
    // @ts-expect-error - accessing private property for testing
    this._mcpConnectionsInitialized = false;
  }
}

// Test MCP Agent for jurisdiction feature
export class TestMcpJurisdiction extends McpAgent<Env> {
  observability = undefined;

  server = new McpServer(
    { name: "test-jurisdiction-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  async init() {
    this.server.registerTool(
      "test-tool",
      {
        description: "A test tool",
        inputSchema: { message: z.string().describe("Test message") }
      },
      async ({ message }) => {
        return { content: [{ text: `Echo: ${message}`, type: "text" }] };
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // set some props that should be passed init
    // @ts-expect-error - this is fine for now
    ctx.props = {
      testValue: "123"
    };

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return TestMcpAgent.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return TestMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    if (url.pathname === "/500") {
      return new Response("Internal Server Error", { status: 500 });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },

  async email(
    _message: ForwardableEmailMessage,
    _env: Env,
    _ctx: ExecutionContext
  ) {
    // Bring this in when we write tests for the complete email handler flow
  }
};
