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
  getAgentByName,
  routeAgentRequest,
  type Connection,
  type WSMessage
} from "../index.ts";
import type { StreamingResponse } from "../index.ts";
import type { AgentEmail } from "../email.ts";
import type { WorkflowStatus, WorkflowInfo } from "../workflows.ts";
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
  TestAddMcpServerAgent: DurableObjectNamespace<TestAddMcpServerAgent>;
  TestStateAgent: DurableObjectNamespace<TestStateAgent>;
  TestStateAgentNoInitial: DurableObjectNamespace<TestStateAgentNoInitial>;
  TestThrowingStateAgent: DurableObjectNamespace<TestThrowingStateAgent>;
  TestNoIdentityAgent: DurableObjectNamespace<TestNoIdentityAgent>;
  TestCallableAgent: DurableObjectNamespace<TestCallableAgent>;
  TestChildAgent: DurableObjectNamespace<TestChildAgent>;
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

  // Callback that tracks execution count
  intervalCallbackCount = 0;

  intervalCallback() {
    this.intervalCallbackCount++;
  }

  // Callback that throws an error (for testing error resilience)
  throwingCallback() {
    throw new Error("Intentional test error");
  }

  // Track slow callback execution for concurrent execution testing
  slowCallbackExecutionCount = 0;
  slowCallbackStartTimes: number[] = [];
  slowCallbackEndTimes: number[] = [];

  async slowCallback() {
    this.slowCallbackExecutionCount++;
    this.slowCallbackStartTimes.push(Date.now());
    // Simulate a slow operation (500ms)
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.slowCallbackEndTimes.push(Date.now());
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

  @callable()
  async createIntervalSchedule(intervalSeconds: number): Promise<string> {
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "intervalCallback"
    );
    return schedule.id;
  }

  @callable()
  async createThrowingIntervalSchedule(
    intervalSeconds: number
  ): Promise<string> {
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "throwingCallback"
    );
    return schedule.id;
  }

  @callable()
  async getIntervalCallbackCount(): Promise<number> {
    return this.intervalCallbackCount;
  }

  @callable()
  async resetIntervalCallbackCount(): Promise<void> {
    this.intervalCallbackCount = 0;
  }

  @callable()
  async getSchedulesByType(
    type: "scheduled" | "delayed" | "cron" | "interval"
  ) {
    return this.getSchedules({ type });
  }

  @callable()
  async createSlowIntervalSchedule(intervalSeconds: number): Promise<string> {
    const schedule = await this.scheduleEvery(intervalSeconds, "slowCallback");
    return schedule.id;
  }

  @callable()
  async getSlowCallbackStats(): Promise<{
    executionCount: number;
    startTimes: number[];
    endTimes: number[];
  }> {
    return {
      executionCount: this.slowCallbackExecutionCount,
      startTimes: this.slowCallbackStartTimes,
      endTimes: this.slowCallbackEndTimes
    };
  }

  @callable()
  async resetSlowCallbackStats(): Promise<void> {
    this.slowCallbackExecutionCount = 0;
    this.slowCallbackStartTimes = [];
    this.slowCallbackEndTimes = [];
  }

  @callable()
  async getScheduleRunningState(id: string): Promise<{
    running: number;
    execution_started_at: number | null;
  } | null> {
    const result = this.sql<{
      running: number;
      execution_started_at: number | null;
    }>`
      SELECT running, execution_started_at FROM cf_agents_schedules WHERE id = ${id}
    `;
    return result[0] ?? null;
  }

  @callable()
  async simulateHungSchedule(intervalSeconds: number): Promise<string> {
    // Create an interval schedule
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "intervalCallback"
    );

    // Manually set running=1 and execution_started_at to 60 seconds ago
    // to simulate a hung callback
    const hungStartTime = Math.floor(Date.now() / 1000) - 60;
    this
      .sql`UPDATE cf_agents_schedules SET running = 1, execution_started_at = ${hungStartTime} WHERE id = ${schedule.id}`;

    return schedule.id;
  }

  @callable()
  async simulateLegacyHungSchedule(intervalSeconds: number): Promise<string> {
    // Create an interval schedule
    const schedule = await this.scheduleEvery(
      intervalSeconds,
      "intervalCallback"
    );

    // Manually set running=1 but leave execution_started_at as NULL
    // to simulate a legacy schedule that was running before the migration
    this
      .sql`UPDATE cf_agents_schedules SET running = 1, execution_started_at = NULL WHERE id = ${schedule.id}`;

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

  // Expose getWorkflows for testing (returns just workflows array for backward compat)
  async getWorkflowsForTest(criteria?: {
    status?: WorkflowStatus | WorkflowStatus[];
    workflowName?: string;
    metadata?: Record<string, string | number | boolean>;
    limit?: number;
    orderBy?: "asc" | "desc";
    cursor?: string;
  }): Promise<WorkflowInfo[]> {
    return this.getWorkflows(criteria).workflows;
  }

  // Expose getWorkflows with full pagination info for testing
  getWorkflowsPageForTest(criteria?: {
    status?: WorkflowStatus | WorkflowStatus[];
    workflowName?: string;
    metadata?: Record<string, string | number | boolean>;
    limit?: number;
    orderBy?: "asc" | "desc";
    cursor?: string;
  }): { workflows: WorkflowInfo[]; total: number; nextCursor: string | null } {
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

  // Restart workflow with options (for testing resetTracking)
  async restartWorkflowWithOptions(
    workflowId: string,
    options?: { resetTracking?: boolean }
  ): Promise<void> {
    return this.restartWorkflow(workflowId, options);
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

// Test Agent for addMcpServer overload verification
export class TestAddMcpServerAgent extends Agent<Env> {
  observability = undefined;

  // Track resolved arguments from addMcpServer calls
  lastResolvedArgs: {
    serverName: string;
    url: string;
    callbackHost?: string;
    agentsPrefix: string;
    transport?: { headers?: HeadersInit; type?: string };
    client?: unknown;
  } | null = null;

  // Override to capture resolved arguments without actually connecting
  async addMcpServer(
    serverName: string,
    url: string,
    callbackHostOrOptions?:
      | string
      | {
          callbackHost?: string;
          agentsPrefix?: string;
          client?: unknown;
          transport?: { headers?: HeadersInit; type?: string };
        },
    agentsPrefix?: string,
    options?: {
      client?: unknown;
      transport?: { headers?: HeadersInit; type?: string };
    }
  ): Promise<{ id: string; state: "ready" }> {
    // Normalize arguments - same logic as Agent.addMcpServer
    let resolvedCallbackHost: string | undefined;
    let resolvedAgentsPrefix: string;
    let resolvedOptions: typeof options;

    if (
      typeof callbackHostOrOptions === "object" &&
      callbackHostOrOptions !== null
    ) {
      // New API: options object as third parameter
      resolvedCallbackHost = callbackHostOrOptions.callbackHost;
      resolvedAgentsPrefix = callbackHostOrOptions.agentsPrefix ?? "agents";
      resolvedOptions = {
        client: callbackHostOrOptions.client,
        transport: callbackHostOrOptions.transport
      };
    } else {
      // Legacy API: positional parameters
      resolvedCallbackHost = callbackHostOrOptions;
      resolvedAgentsPrefix = agentsPrefix ?? "agents";
      resolvedOptions = options;
    }

    // Store resolved arguments for test verification
    this.lastResolvedArgs = {
      serverName,
      url,
      callbackHost: resolvedCallbackHost,
      agentsPrefix: resolvedAgentsPrefix,
      transport: resolvedOptions?.transport,
      client: resolvedOptions?.client
    };

    // Return mock result without actually connecting
    return { id: "test-id", state: "ready" };
  }

  async testNewApiWithOptions(name: string, url: string, callbackHost: string) {
    await this.addMcpServer(name, url, {
      callbackHost,
      agentsPrefix: "custom-agents",
      transport: { type: "sse", headers: { Authorization: "Bearer test" } }
    });
    // Non-null assertion safe because addMcpServer always sets lastResolvedArgs
    return this.lastResolvedArgs!;
  }

  async testNewApiMinimal(name: string, url: string) {
    await this.addMcpServer(name, url, {});
    return this.lastResolvedArgs!;
  }

  async testLegacyApiWithOptions(
    name: string,
    url: string,
    callbackHost: string
  ) {
    await this.addMcpServer(name, url, callbackHost, "legacy-prefix", {
      transport: { type: "streamable-http", headers: { "X-Custom": "value" } }
    });
    return this.lastResolvedArgs!;
  }

  async testLegacyApiMinimal(name: string, url: string, callbackHost: string) {
    await this.addMcpServer(name, url, callbackHost);
    return this.lastResolvedArgs!;
  }

  getLastResolvedArgs() {
    return this.lastResolvedArgs;
  }
}

// Test Agent for state management tests
type TestState = {
  count: number;
  items: string[];
  lastUpdated: string | null;
};

export class TestStateAgent extends Agent<Env, TestState> {
  observability = undefined;

  initialState: TestState = {
    count: 0,
    items: [],
    lastUpdated: null
  };

  // Track onStateUpdate calls for testing
  stateUpdateCalls: Array<{ state: TestState; source: string }> = [];

  onStateUpdate(state: TestState, source: Connection | "server") {
    this.stateUpdateCalls.push({
      state,
      source: source === "server" ? "server" : source.id
    });
  }

  // HTTP handler for testing agentFetch and path routing
  // Only handles specific test paths - returns 404 for others to preserve routing test behavior
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split("/").pop() || "";

    // Handle specific paths for browser integration tests
    if (path === "state") {
      return Response.json({ state: this.state });
    }
    if (path === "state-updates") {
      return Response.json({ updates: this.stateUpdateCalls });
    }
    if (path === "echo") {
      const body = await request.text();
      return Response.json({ method: request.method, body, path });
    }
    if (path === "connections") {
      // Count active connections using PartyServer's getConnections()
      let count = 0;
      for (const _ of this.getConnections()) {
        count++;
      }
      return Response.json({ count });
    }

    // Return 404 for unhandled paths - preserves expected routing behavior
    return new Response("Not found", { status: 404 });
  }

  // Test helper methods (no @callable needed for DO RPC)
  getState() {
    return this.state;
  }

  updateState(state: TestState) {
    this.setState(state);
  }

  getStateUpdateCalls() {
    return this.stateUpdateCalls;
  }

  clearStateUpdateCalls() {
    this.stateUpdateCalls = [];
  }

  // Test helper to insert corrupted state directly into DB (without caching)
  insertCorruptedState() {
    // Insert invalid JSON directly, also set wasChanged to trigger the read path
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('STATE', 'invalid{json')`
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES ('STATE_WAS_CHANGED', 'true')`
    );
  }

  // Access state and check if it recovered to initialState
  getStateAfterCorruption(): TestState {
    // This should trigger the try-catch and fallback to initialState
    return this.state;
  }
}

// Test Agent without initialState to test undefined behavior
export class TestStateAgentNoInitial extends Agent<Env> {
  observability = undefined;

  // No initialState defined - should return undefined

  getState() {
    return this.state;
  }

  updateState(state: unknown) {
    this.setState(state);
  }
}

// Test Agent with throwing onStateUpdate - for testing broadcast order
export class TestThrowingStateAgent extends Agent<Env, TestState> {
  observability = undefined;

  initialState: TestState = {
    count: 0,
    items: [],
    lastUpdated: null
  };

  // Track if onStateUpdate was called
  onStateUpdateCalled = false;

  // Track errors routed through onError (should not affect broadcasts)
  onErrorCalls: string[] = [];

  // Validation hook: throw to reject the update (gates persist+broadcast)
  validateStateChange(nextState: TestState, _source: Connection | "server") {
    if (nextState.count === -1) {
      throw new Error("Invalid state: count cannot be -1");
    }
  }

  // Notification hook: should not gate broadcasts; errors go to onError
  onStateUpdate(state: TestState, _source: Connection | "server") {
    this.onStateUpdateCalled = true;
    if (state.count === -2) {
      throw new Error("onStateUpdate failed: count cannot be -2");
    }
  }

  override onError(error: unknown): void {
    this.onErrorCalls.push(
      error instanceof Error ? error.message : String(error)
    );
    // Do not throw - this is a test agent
  }

  // Test helper to update state via RPC
  updateState(state: TestState) {
    this.setState(state);
  }

  // Check if onStateUpdate was called
  wasOnStateUpdateCalled(): boolean {
    return this.onStateUpdateCalled;
  }

  // Reset the flag
  resetOnStateUpdateCalled() {
    this.onStateUpdateCalled = false;
  }

  getOnErrorCalls() {
    return this.onErrorCalls;
  }

  clearOnErrorCalls() {
    this.onErrorCalls = [];
  }
}

// Test Agent with sendIdentityOnConnect disabled
export class TestNoIdentityAgent extends Agent<Env, TestState> {
  observability = undefined;

  // Opt out of sending identity to clients (for security-sensitive instance names)
  static options = { sendIdentityOnConnect: false };

  initialState: TestState = {
    count: 0,
    items: [],
    lastUpdated: null
  };

  getState() {
    return this.state;
  }

  updateState(state: TestState) {
    this.setState(state);
  }
}

// Test Agent for @callable decorator tests
export class TestCallableAgent extends Agent<Env, { value: number }> {
  observability = undefined;
  initialState = { value: 0 };

  // Basic sync method
  @callable()
  add(a: number, b: number): number {
    return a + b;
  }

  // Async method
  @callable()
  async asyncMethod(delayMs: number): Promise<string> {
    await new Promise((r) => setTimeout(r, delayMs));
    return "done";
  }

  // Method that throws an error
  @callable()
  throwError(message: string): never {
    throw new Error(message);
  }

  // Void return type
  @callable()
  voidMethod(): void {
    // does nothing, returns undefined
  }

  // Returns null
  @callable()
  returnNull(): null {
    return null;
  }

  // Returns undefined
  @callable()
  returnUndefined(): undefined {
    return undefined;
  }

  // Streaming method - sync
  @callable({ streaming: true })
  streamNumbers(stream: StreamingResponse, count: number) {
    for (let i = 0; i < count; i++) {
      stream.send(i);
    }
    stream.end(count);
  }

  // Streaming method - async with delays
  @callable({ streaming: true })
  async streamWithDelay(
    stream: StreamingResponse,
    chunks: string[],
    delayMs: number
  ) {
    for (const chunk of chunks) {
      await new Promise((r) => setTimeout(r, delayMs));
      stream.send(chunk);
    }
    stream.end("complete");
  }

  // Streaming method that throws after sending a chunk
  @callable({ streaming: true })
  streamError(stream: StreamingResponse) {
    stream.send("chunk1");
    throw new Error("Stream failed");
  }

  // Streaming method that uses stream.error() to send error
  @callable({ streaming: true, description: "Sends chunk then graceful error" })
  streamGracefulError(stream: StreamingResponse) {
    stream.send("chunk1");
    stream.error("Graceful error");
  }

  // Streaming method that double-closes (error then end) - should not throw
  @callable({
    streaming: true,
    description: "Tests double-close no-op behavior"
  })
  streamDoubleClose(stream: StreamingResponse) {
    stream.send("chunk1");
    stream.error("First close");
    // These should be no-ops, not throw
    stream.end("ignored");
    stream.send("also ignored");
    stream.error("also ignored");
  }

  // Streaming method that throws before sending any response
  @callable({ streaming: true })
  streamThrowsImmediately(_stream: StreamingResponse) {
    throw new Error("Immediate failure");
  }

  // NOT decorated with @callable - should fail when called via RPC
  privateMethod(): string {
    return "secret";
  }
}

// Base class with @callable methods for testing prototype chain traversal
export class TestParentAgent extends Agent<Env> {
  observability = undefined;

  @callable({ description: "Parent method from base class" })
  parentMethod(): string {
    return "from parent";
  }

  @callable()
  sharedMethod(): string {
    return "parent implementation";
  }
}

// Child agent that extends TestParentAgent - tests getCallableMethods prototype chain
export class TestChildAgent extends TestParentAgent {
  @callable({ description: "Child method from derived class" })
  childMethod(): string {
    return "from child";
  }

  // Override parent method - child version should be found first
  @callable()
  sharedMethod(): string {
    return "child implementation";
  }

  // Non-callable method for testing introspection
  nonCallableMethod(): string {
    return "not callable";
  }

  // Helper to test getCallableMethods returns parent methods
  getCallableMethodNames(): string[] {
    const methods = this.getCallableMethods();
    return Array.from(methods.keys()).sort();
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

    // Custom basePath routing for testing - routes /custom-state/{name} to TestStateAgent
    if (url.pathname.startsWith("/custom-state/")) {
      const instanceName = url.pathname.replace("/custom-state/", "");
      const agent = await getAgentByName(env.TestStateAgent, instanceName);
      return agent.fetch(request);
    }

    // Custom basePath routing with simulated auth - routes /user to TestStateAgent with "auth-user" instance
    if (url.pathname === "/user" || url.pathname.startsWith("/user?")) {
      // Simulate server-side auth that determines the instance name
      const simulatedUserId = "auth-user";
      const agent = await getAgentByName(env.TestStateAgent, simulatedUserId);
      return agent.fetch(request);
    }

    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
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
