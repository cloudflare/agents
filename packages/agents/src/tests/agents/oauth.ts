import { Agent } from "../../index.ts";
import { DurableObjectOAuthClientProvider } from "../../mcp/do-oauth-client-provider";
import type { AgentsOAuthProvider } from "../../mcp/do-oauth-client-provider";
import type { MCPClientConnection } from "../../mcp/client-connection";

// Test Agent for OAuth client side flows
export class TestOAuthAgent extends Agent<Record<string, unknown>> {
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

  testCreateOAuthProvider(callbackUrl: string): {
    isDurableObjectProvider: boolean;
    callbackUrl: string;
  } {
    const provider = this.createOAuthProvider(callbackUrl);
    return {
      isDurableObjectProvider:
        provider instanceof DurableObjectOAuthClientProvider,
      callbackUrl: String(provider.redirectUrl ?? "")
    };
  }
}

// Test Agent that overrides createOAuthProvider with a custom implementation
export class TestCustomOAuthAgent extends Agent<Record<string, unknown>> {
  observability = undefined;

  private _customProviderCallbackUrl: string | undefined;

  createOAuthProvider(callbackUrl: string): AgentsOAuthProvider {
    this._customProviderCallbackUrl = callbackUrl;
    // Return a minimal mock that satisfies the interface
    return {
      authUrl: undefined,
      clientId: "custom-client-id",
      serverId: undefined,
      redirectUrl: callbackUrl,
      get clientMetadata() {
        return { redirect_uris: [callbackUrl] };
      },
      get clientUri() {
        return callbackUrl;
      },
      checkState: async () => ({ valid: false }),
      consumeState: async () => {},
      deleteCodeVerifier: async () => {},
      clientInformation: async () => undefined,
      saveClientInformation: async () => {},
      tokens: async () => undefined,
      saveTokens: async () => {},
      state: async () => "mock-state",
      redirectToAuthorization: async () => {},
      invalidateCredentials: async () => {},
      saveCodeVerifier: async () => {},
      codeVerifier: async () => "mock-verifier"
    } as AgentsOAuthProvider;
  }

  testCreateOAuthProvider(callbackUrl: string): {
    isDurableObjectProvider: boolean;
    clientId: string | undefined;
    callbackUrl: string | undefined;
  } {
    const provider = this.createOAuthProvider(callbackUrl);
    return {
      isDurableObjectProvider:
        provider instanceof DurableObjectOAuthClientProvider,
      clientId: provider.clientId,
      callbackUrl: this._customProviderCallbackUrl
    };
  }
}
