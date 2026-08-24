import { DurableObject } from "cloudflare:workers";
import { routeAgentRequest } from "../index";
import {
  Lifecycle,
  type Connection,
  type DurableObjectCapability,
  type WSMessage
} from "../lifecycle";
import { MCPClientManager } from "../mcp/client";
import { MCPConnectionState } from "../mcp/client-connection";

export type Env = {
  PlainLifecycleObject: DurableObjectNamespace<PlainLifecycleObject>;
  PlainMcpClientObject: DurableObjectNamespace<PlainMcpClientObject>;
};

type StartupProps = { label: string };

export class PlainLifecycleObject extends DurableObject<Env> {
  readonly #events: string[] = [];

  readonly lifecycle = Lifecycle.install<Env, StartupProps>(this, {
    runCapabilityPhase: async ({ phase }, operation) => {
      this.#events.push(`phase:${phase}:before`);
      try {
        return await operation();
      } finally {
        this.#events.push(`phase:${phase}:after`);
      }
    }
  }).use({
    onStart: ({ props }) => {
      this.#events.push(`capability:start:${props?.label ?? "none"}`);
    },
    onRequest: ({ request }) => {
      this.#events.push("capability:request");
      if (new URL(request.url).searchParams.has("capability")) {
        return Response.json(this.#events);
      }
    },
    onAlarm: () => {
      this.#events.push("capability:alarm");
    }
  } satisfies DurableObjectCapability<StartupProps>);

  onStart(props?: StartupProps): void {
    this.#events.push(`host:start:${props?.label ?? "none"}`);
  }

  onRequest(request: Request): Response {
    this.#events.push("host:request");
    return Response.json({
      name: this.lifecycle.name,
      events: this.#events,
      hasInternalPropsHeader: request.headers.has("x-agents-lifecycle-props")
    });
  }

  onAlarm(): void {
    this.#events.push("host:alarm");
  }

  onConnect(connection: Connection): void {
    connection.send(`connected:${this.lifecycle.name}`);
  }

  onMessage(connection: Connection, message: WSMessage): void {
    connection.send(`echo:${String(message)}`);
  }

  installHandlersAgainForTest(): string {
    try {
      this.lifecycle.installHandlers();
      return "installed";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async seedLegacyNameForTest(name: string): Promise<void> {
    await this.ctx.storage.put("__ps_name", name);
  }

  async scheduleAlarm(): Promise<void> {
    await this.lifecycle.start();
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async getEvents(): Promise<readonly string[]> {
    await this.lifecycle.start();
    return this.#events;
  }

  async startFromRpc(props: StartupProps): Promise<readonly string[]> {
    await this.lifecycle.start(props);
    return this.#events;
  }
}

export class PlainMcpClientObject extends DurableObject<Env> {
  readonly mcp = new MCPClientManager("plain-lifecycle-object", "1.0.0", {
    storage: this.ctx.storage
  });

  readonly lifecycle = Lifecycle.install(this).use(this.mcp);

  onRequest(): Response {
    return Response.json({
      connectionIds: Object.keys(this.mcp.mcpConnections),
      states: Object.fromEntries(
        Object.entries(this.mcp.mcpConnections).map(([id, connection]) => [
          id,
          connection.connectionState
        ])
      ),
      storedServerCount: this.mcp.listServers().length
    });
  }

  async prepareRestorableServer(): Promise<void> {
    await this.lifecycle.start();
    await this.mcp.registerServer("server", {
      name: "Test server",
      url: "https://mcp.example.com",
      callbackUrl: "https://example.com/callback",
      transport: { type: "auto" }
    });
    this.ctx.storage.sql.exec(
      "UPDATE cf_agents_mcp_servers SET auth_url = ? WHERE id = ?",
      "https://auth.example.com/authorize",
      "server"
    );
  }

  async prepareOAuthCallback(): Promise<string> {
    await this.lifecycle.start();
    this.mcp.configureOAuthCallback({
      customHandler: (result) => Response.json(result)
    });
    await this.mcp.registerServer("callback-server", {
      name: "Test server",
      url: "https://mcp.example.com",
      callbackUrl: "https://example.com/callback",
      transport: { type: "auto" }
    });

    const connection = this.mcp.mcpConnections["callback-server"];
    const authProvider = connection.options.transport.authProvider;
    if (!authProvider?.state) {
      throw new Error("Expected a stateful default OAuth provider");
    }
    connection.connectionState = MCPConnectionState.AUTHENTICATING;
    return authProvider.state();
  }

  async startFreshOAuthFlow(): Promise<unknown> {
    await this.lifecycle.start();
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authorizationServerUrl = "https://auth.example.com";

    const oauthFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (request.url === serverUrl) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`
          }
        });
      }

      if (request.url === resourceMetadataUrl) {
        return Response.json({
          resource: serverUrl,
          authorization_servers: [authorizationServerUrl]
        });
      }

      if (
        url.origin === authorizationServerUrl &&
        url.pathname.includes(".well-known")
      ) {
        return Response.json({
          issuer: authorizationServerUrl,
          authorization_endpoint: `${authorizationServerUrl}/authorize`,
          token_endpoint: `${authorizationServerUrl}/token`,
          registration_endpoint: `${authorizationServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"]
        });
      }

      if (
        url.origin === authorizationServerUrl &&
        url.pathname === "/register" &&
        request.method === "POST"
      ) {
        return Response.json({
          client_id: "test-client-id",
          redirect_uris: ["https://example.com/callback"]
        });
      }

      return new Response(`Unexpected OAuth test request: ${request.url}`, {
        status: 500
      });
    };

    await this.mcp.registerServer("fresh-oauth-server", {
      name: "Fresh OAuth server",
      url: serverUrl,
      callbackUrl: "https://example.com/callback",
      transport: { type: "streamable-http", fetch: oauthFetch }
    });

    return this.mcp.connectToServer("fresh-oauth-server");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env, {
        props: { label: "routed" }
      })) ?? new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
