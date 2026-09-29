import { MCPClientManager, normalizeServerId } from "agents/mcp/client";

/** JSON catalog rendered by the MCP capability demo UI. */
export type McpCatalog = {
  readonly servers: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly url: string;
    readonly state: string;
    readonly authUrl?: string;
  }>;
  readonly tools: ReturnType<MCPClientManager["listTools"]>;
};

type ConnectInput = {
  readonly name: string;
  readonly url: string;
};

type ToolCallInput = {
  readonly serverId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConnectInput(value: unknown): ConnectInput | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    return undefined;
  }

  const name = value.name.trim();
  const rawUrl = value.url.trim();
  if (!name || !rawUrl) return undefined;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return { name, url: url.href };
  } catch {
    return undefined;
  }
}

function parseToolCallInput(value: unknown): ToolCallInput | undefined {
  if (
    !isRecord(value) ||
    typeof value.serverId !== "string" ||
    !value.serverId ||
    typeof value.name !== "string" ||
    !value.name ||
    !isRecord(value.arguments)
  ) {
    return undefined;
  }
  return {
    serverId: value.serverId,
    name: value.name,
    arguments: value.arguments
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Configure the popup-closing OAuth response used only by the demo UI. */
export function configureOAuthPopup(mcp: MCPClientManager): void {
  mcp.configureOAuthCallback({
    customHandler: () => {
      return new Response(
        "<!doctype html><title>MCP authorization complete</title><p>You can close this window.</p><script>window.close();</script>",
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'none'"
          }
        }
      );
    }
  });
}

/** Project manager state into the serializable catalog consumed by the UI. */
export function getMcpCatalog(mcp: MCPClientManager): McpCatalog {
  return {
    servers: mcp.listServers().map((server) => ({
      id: server.id,
      name: server.name,
      url: server.server_url,
      state: mcp.mcpConnections[server.id]?.connectionState ?? "not-connected",
      authUrl: server.auth_url ?? undefined
    })),
    tools: mcp.listTools()
  };
}

/** Handle the small HTTP API used by the React demo. */
export async function handleDemoRequest(
  mcp: MCPClientManager,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname.endsWith("/connect")) {
    const input = parseConnectInput(await readJson(request));
    if (!input) {
      return Response.json(
        { error: "Expected a non-empty name and an HTTP(S) URL" },
        { status: 400 }
      );
    }

    const id = normalizeServerId(input.name);
    if (mcp.listServers().some((server) => server.id === id)) {
      await mcp.removeServer(id);
    }

    const callbackUrl = new URL(request.url);
    callbackUrl.pathname = callbackUrl.pathname.replace(
      /\/connect\/?$/,
      "/callback"
    );
    callbackUrl.search = "";

    await mcp.registerServer(id, {
      name: input.name,
      url: input.url,
      callbackUrl: callbackUrl.href,
      transport: { type: "auto" }
    });

    const connection = await mcp.connectToServer(id);
    if (connection.state === "connected") {
      const discovery = await mcp.discoverIfConnected(id);
      return Response.json({ id, connection, discovery });
    }
    return Response.json({ id, connection });
  }

  if (request.method === "POST" && url.pathname.endsWith("/tools/call")) {
    const input = parseToolCallInput(await readJson(request));
    if (!input) {
      return Response.json(
        { error: "Expected serverId, tool name, and an arguments object" },
        { status: 400 }
      );
    }
    const connection = mcp.mcpConnections[input.serverId];
    if (!connection) {
      return Response.json(
        { error: "MCP server is not connected" },
        { status: 404 }
      );
    }
    if (connection.connectionState !== "ready") {
      return Response.json(
        {
          error: `MCP server is not ready (${connection.connectionState})`
        },
        { status: 409 }
      );
    }

    try {
      const result = await mcp.callTool({
        serverId: input.serverId,
        name: input.name,
        arguments: input.arguments
      });
      return Response.json({ result });
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 502 }
      );
    }
  }

  const marker = "/servers/";
  const markerIndex = url.pathname.lastIndexOf(marker);
  if (request.method === "DELETE" && markerIndex !== -1) {
    const id = decodeURIComponent(
      url.pathname.slice(markerIndex + marker.length)
    );
    await mcp.removeServer(id);
    return new Response(null, { status: 204 });
  }

  return Response.json(getMcpCatalog(mcp));
}
