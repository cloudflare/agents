/**
 * TypeScript client for the Agent System control plane HTTP API.
 *
 * Usage:
 * ```ts
 * const client = new AgentSystemClient({ baseUrl: "https://my-agent.workers.dev" });
 *
 * // List agencies
 * const agencies = await client.listAgencies();
 *
 * // Create an agency
 * const agency = await client.createAgency({ name: "My Agency" });
 *
 * // Work with a specific agency
 * const agencyClient = client.agency(agency.id);
 *
 * // List/create blueprints
 * const blueprints = await agencyClient.listBlueprints();
 * await agencyClient.createBlueprint({ name: "assistant", prompt: "...", tags: ["default"] });
 *
 * // Spawn an agent
 * const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
 *
 * // Work with a specific agent
 * const agentClient = agencyClient.agent(agent.id);
 *
 * // Get state, invoke, approve, cancel
 * const state = await agentClient.getState();
 * await agentClient.invoke({ messages: [{ role: "user", content: "Hello" }] });
 * await agentClient.approve({ approved: true });
 * await agentClient.cancel();
 *
 * // Real-time events via WebSocket
 * const ws = agentClient.connect({
 *   onEvent: (event) => console.log(event),
 *   onClose: () => console.log("Closed"),
 * });
 * ```
 */

import type {
  AgentBlueprint,
  AgentState,
  ApproveBody,
  ChatMessage,
  InvokeBody,
  RunState,
  SubagentLink,
  ThreadMetadata,
  ToolCall,
  ToolMeta
} from "./types";
import type { AgentEvent, AgentEventType } from "./events";

// ============================================================================
// Response Types
// ============================================================================

/** Metadata for an agency returned from the registry */
export interface AgencyMeta {
  id: string;
  name: string;
  createdAt: string;
}

/** Response from GET /agencies */
export interface ListAgenciesResponse {
  agencies: AgencyMeta[];
}

/** Response from POST /agencies */
export interface CreateAgencyResponse extends AgencyMeta {}

/** Response from GET /agency/:id/blueprints */
export interface ListBlueprintsResponse {
  blueprints: AgentBlueprint[];
}

/** Response from POST /agency/:id/blueprints */
export interface CreateBlueprintResponse {
  ok: boolean;
  name: string;
}

/** Agent summary returned from listing */
export interface AgentSummary {
  id: string;
  agentType: string;
  createdAt: string;
  request?: unknown;
  agencyId?: string;
}

/** Response from GET /agency/:id/agents */
export interface ListAgentsResponse {
  agents: AgentSummary[];
}

/** Response from POST /agency/:id/agents (spawn) */
export interface SpawnAgentResponse extends ThreadMetadata {}

/** Response from POST /invoke */
export interface InvokeResponse {
  runId: string;
  status: string;
}

/** Response from GET /state */
export interface GetStateResponse {
  state: AgentState & {
    subagents?: SubagentLink[];
  };
  run: RunState;
}

/** Response from GET /events */
export interface GetEventsResponse {
  events: AgentEvent[];
}

/** Response from POST /approve or /cancel */
export interface OkResponse {
  ok: boolean;
}

// ============================================================================
// Request Types
// ============================================================================

export interface CreateAgencyRequest {
  name?: string;
}

export interface CreateBlueprintRequest {
  name: string;
  description?: string;
  prompt: string;
  tags: string[];
  model?: string;
  config?: Record<string, unknown>;
  status?: "active" | "draft" | "disabled";
}

export interface SpawnAgentRequest {
  agentType: string;
}

export interface InvokeRequest {
  messages?: ChatMessage[];
  files?: Record<string, string>;
  idempotencyKey?: string;
}

export type ApproveRequest = ApproveBody;

// ============================================================================
// WebSocket Types
// ============================================================================

export type WebSocketEvent = AgentEvent & {
  seq: number;
};

export interface WebSocketOptions {
  /** Called when an event is received */
  onEvent?: (event: WebSocketEvent) => void;
  /** Called when the connection is opened */
  onOpen?: () => void;
  /** Called when the connection is closed */
  onClose?: (event: CloseEvent) => void;
  /** Called on error */
  onError?: (error: Event) => void;
  /** Custom protocols */
  protocols?: string | string[];
}

export interface AgentWebSocket {
  /** The underlying WebSocket */
  ws: WebSocket;
  /** Send a message to the agent */
  send: (message: unknown) => void;
  /** Close the connection */
  close: () => void;
}

// ============================================================================
// Client Options
// ============================================================================

export interface AgentSystemClientOptions {
  /** Base URL of the agent system (e.g., "https://my-agent.workers.dev") */
  baseUrl: string;
  /** Optional secret for authentication (sent as X-SECRET header) */
  secret?: string;
  /** Custom fetch implementation (defaults to global fetch) */
  fetch?: typeof fetch;
}

// ============================================================================
// Error Types
// ============================================================================

export class AgentSystemError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown
  ) {
    super(message);
    this.name = "AgentSystemError";
  }
}

// ============================================================================
// Agent Client
// ============================================================================

/**
 * Client for interacting with a specific agent instance.
 */
export class AgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly agencyId: string,
    private readonly agentId: string,
    private readonly headers: HeadersInit,
    private readonly fetchFn: typeof fetch
  ) {}

  private get path(): string {
    return `${this.baseUrl}/agency/${this.agencyId}/agent/${this.agentId}`;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.path}${endpoint}`;
    const res = await this.fetchFn(url, {
      method,
      headers: {
        ...this.headers,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentSystemError(
        `Request failed: ${res.status} ${res.statusText}`,
        res.status,
        text
      );
    }

    return res.json();
  }

  /**
   * Get the current state of the agent including messages, tools, and run status.
   */
  async getState(): Promise<GetStateResponse> {
    return this.request<GetStateResponse>("GET", "/state");
  }

  /**
   * Get all events emitted by this agent.
   */
  async getEvents(): Promise<GetEventsResponse> {
    return this.request<GetEventsResponse>("GET", "/events");
  }

  /**
   * Invoke the agent with optional messages and files.
   * This starts or continues an agent run.
   */
  async invoke(request: InvokeRequest = {}): Promise<InvokeResponse> {
    return this.request<InvokeResponse>("POST", "/invoke", request);
  }

  /**
   * Approve or reject pending tool calls (Human-in-the-Loop).
   */
  async approve(request: ApproveRequest): Promise<OkResponse> {
    return this.request<OkResponse>("POST", "/approve", request);
  }

  /**
   * Cancel the current agent run.
   */
  async cancel(): Promise<OkResponse> {
    return this.request<OkResponse>("POST", "/cancel");
  }

  /**
   * Establish a WebSocket connection for real-time events.
   *
   * @example
   * ```ts
   * const { ws, close } = agentClient.connect({
   *   onEvent: (event) => {
   *     console.log(`[${event.type}]`, event.data);
   *   },
   *   onClose: () => console.log("Connection closed"),
   * });
   *
   * // Later...
   * close();
   * ```
   */
  connect(options: WebSocketOptions = {}): AgentWebSocket {
    const wsUrl = this.path.replace(/^http/, "ws");
    const ws = new WebSocket(wsUrl, options.protocols);

    ws.onopen = () => options.onOpen?.();

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as WebSocketEvent;
        options.onEvent?.(data);
      } catch {
        // Non-JSON message, ignore or handle differently
      }
    };

    ws.onclose = (event) => options.onClose?.(event);
    ws.onerror = (event) => options.onError?.(event);

    return {
      ws,
      send: (message: unknown) => ws.send(JSON.stringify(message)),
      close: () => ws.close()
    };
  }

  /** The agent ID */
  get id(): string {
    return this.agentId;
  }
}

// ============================================================================
// Agency Client
// ============================================================================

/**
 * Client for interacting with a specific agency.
 */
export class AgencyClient {
  constructor(
    private readonly baseUrl: string,
    private readonly agencyId: string,
    private readonly headers: HeadersInit,
    private readonly fetchFn: typeof fetch
  ) {}

  private get path(): string {
    return `${this.baseUrl}/agency/${this.agencyId}`;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.path}${endpoint}`;
    const res = await this.fetchFn(url, {
      method,
      headers: {
        ...this.headers,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentSystemError(
        `Request failed: ${res.status} ${res.statusText}`,
        res.status,
        text
      );
    }

    return res.json();
  }

  /**
   * List all blueprints available in this agency.
   * This includes both static defaults and agency-specific overrides.
   */
  async listBlueprints(): Promise<ListBlueprintsResponse> {
    return this.request<ListBlueprintsResponse>("GET", "/blueprints");
  }

  /**
   * Create or update a blueprint in this agency.
   */
  async createBlueprint(
    blueprint: CreateBlueprintRequest
  ): Promise<CreateBlueprintResponse> {
    return this.request<CreateBlueprintResponse>(
      "POST",
      "/blueprints",
      blueprint
    );
  }

  /**
   * List all agents in this agency.
   */
  async listAgents(): Promise<ListAgentsResponse> {
    return this.request<ListAgentsResponse>("GET", "/agents");
  }

  /**
   * Spawn a new agent instance of the given type.
   */
  async spawnAgent(request: SpawnAgentRequest): Promise<SpawnAgentResponse> {
    return this.request<SpawnAgentResponse>("POST", "/agents", request);
  }

  /**
   * Get a client for interacting with a specific agent.
   */
  agent(agentId: string): AgentClient {
    return new AgentClient(
      this.baseUrl,
      this.agencyId,
      agentId,
      this.headers,
      this.fetchFn
    );
  }

  /** The agency ID */
  get id(): string {
    return this.agencyId;
  }
}

// ============================================================================
// Main Client
// ============================================================================

/**
 * TypeScript client for the Agent System control plane.
 *
 * @example
 * ```ts
 * const client = new AgentSystemClient({
 *   baseUrl: "https://my-agent.workers.dev",
 *   secret: "optional-auth-secret"
 * });
 *
 * // Create an agency and spawn an agent
 * const agency = await client.createAgency({ name: "My Agency" });
 * const agencyClient = client.agency(agency.id);
 * const agent = await agencyClient.spawnAgent({ agentType: "assistant" });
 *
 * // Interact with the agent
 * const agentClient = agencyClient.agent(agent.id);
 * await agentClient.invoke({
 *   messages: [{ role: "user", content: "Hello!" }]
 * });
 *
 * // Poll for state or use WebSocket
 * const { state, run } = await agentClient.getState();
 * console.log("Status:", run.status);
 * console.log("Messages:", state.messages);
 * ```
 */
export class AgentSystemClient {
  private readonly baseUrl: string;
  private readonly headers: HeadersInit;
  private readonly fetchFn: typeof fetch;

  constructor(options: AgentSystemClientOptions) {
    // Normalize base URL (remove trailing slash)
    this.baseUrl = options.baseUrl.replace(/\/$/, "");

    // Build headers
    this.headers = {};
    if (options.secret) {
      (this.headers as Record<string, string>)["X-SECRET"] = options.secret;
    }

    // Use provided fetch or global
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const res = await this.fetchFn(url, {
      method,
      headers: {
        ...this.headers,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentSystemError(
        `Request failed: ${res.status} ${res.statusText}`,
        res.status,
        text
      );
    }

    return res.json();
  }

  /**
   * List all agencies in the system.
   */
  async listAgencies(): Promise<ListAgenciesResponse> {
    return this.request<ListAgenciesResponse>("GET", "/agencies");
  }

  /**
   * Create a new agency.
   */
  async createAgency(
    request: CreateAgencyRequest = {}
  ): Promise<CreateAgencyResponse> {
    return this.request<CreateAgencyResponse>("POST", "/agencies", request);
  }

  /**
   * Get a client for interacting with a specific agency.
   */
  agency(agencyId: string): AgencyClient {
    return new AgencyClient(this.baseUrl, agencyId, this.headers, this.fetchFn);
  }
}

// ============================================================================
// Re-export relevant types for convenience
// ============================================================================

export type {
  AgentBlueprint,
  AgentState,
  ApproveBody,
  ChatMessage,
  InvokeBody,
  RunState,
  SubagentLink,
  ThreadMetadata,
  ToolCall,
  ToolMeta,
  AgentEvent,
  AgentEventType
};
const client = new AgentSystemClient({
  baseUrl: "https://my-agent.workers.dev",
  secret: "optional-auth-secret"
});
