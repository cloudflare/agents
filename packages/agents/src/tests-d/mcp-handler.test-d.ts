import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer, Server } from "@modelcontextprotocol/server";
// @ts-expect-error v2 constructors are available from agents/mcp/server, not the compatibility barrel.
import { McpServer as AgentsMcpServer } from "agents/mcp";
import type {
  ElicitRequest as ClientElicitRequest,
  ElicitResult as ClientElicitResult
} from "agents/mcp/client";
import {
  createMcpHandler as createServerMcpHandler,
  type CreateMcpHandlerOptions as CreateServerMcpHandlerOptions,
  type StatelessMcpHandler as IsolatedStatelessMcpHandler
} from "agents/mcp/server";
// @ts-expect-error SDK v2 constructors remain owned by @modelcontextprotocol/server.
import { McpServer as ReexportedMcpServer } from "agents/mcp/server";
import {
  createLegacyMcpHandler,
  createMcpHandler,
  type CreateLegacyMcpHandlerOptions,
  type CreateMcpHandlerOptions,
  type CreateStatelessMcpHandlerOptions,
  type StatelessMcpHandler
} from "agents/mcp";

const highLevel = new McpServer({ name: "stateless", version: "1.0.0" });
const lowLevel = new Server({ name: "stateless-low", version: "1.0.0" });
const statelessOptions: CreateStatelessMcpHandlerOptions = {
  legacy: "stateless",
  route: "/mcp",
  allowedHostnames: ["mcp.example.com"],
  allowedOriginHostnames: ["client.example"]
};
const wildcardOriginOptions: CreateServerMcpHandlerOptions = {
  allowedOriginHostnames: "*"
};

const highLevelHandler: StatelessMcpHandler = createMcpHandler(
  () => highLevel,
  statelessOptions
);
const lowLevelHandler: StatelessMcpHandler = createMcpHandler(() => lowLevel);
const factoryHandler: StatelessMcpHandler = createMcpHandler(
  () => new McpServer({ name: "factory", version: "1.0.0" })
);
void highLevelHandler;
void lowLevelHandler;
void factoryHandler;
void AgentsMcpServer;

const isolatedHighLevel = new McpServer({
  name: "isolated-stateless",
  version: "1.0.0"
});
const isolatedLowLevel = new Server({
  name: "isolated-stateless-low",
  version: "1.0.0"
});
const isolatedHighLevelHandler: IsolatedStatelessMcpHandler =
  createServerMcpHandler(() => isolatedHighLevel, wildcardOriginOptions);
const isolatedLowLevelHandler: IsolatedStatelessMcpHandler =
  createServerMcpHandler(() => isolatedLowLevel);
void isolatedHighLevelHandler;
void isolatedLowLevelHandler;
void ReexportedMcpServer;
declare const clientElicitRequest: ClientElicitRequest;
declare const clientElicitResult: ClientElicitResult;
void clientElicitRequest;
void clientElicitResult;

const legacyOptions: CreateMcpHandlerOptions = {
  sessionIdGenerator: () => "session"
};
const explicitLegacyOptions: CreateLegacyMcpHandlerOptions = legacyOptions;
const legacyServer = new LegacyMcpServer({
  name: "legacy",
  version: "1.0.0"
});
createLegacyMcpHandler(legacyServer, explicitLegacyOptions);
createMcpHandler(legacyServer, legacyOptions);

// @ts-expect-error v1 factories are not a supported compatibility input.
createMcpHandler(() => new LegacyMcpServer({ name: "legacy", version: "1" }));

// @ts-expect-error SDK v2 inputs must be factories.
createMcpHandler(highLevel);

// @ts-expect-error v1 transport options are not valid for a v2 factory.
createMcpHandler(() => highLevel, { transport: {} });
