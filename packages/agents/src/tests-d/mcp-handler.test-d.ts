import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer, Server } from "@modelcontextprotocol/server";
// @ts-expect-error v2 constructors are imported directly from @modelcontextprotocol/server.
import { McpServer as AgentsMcpServer } from "agents/mcp";
import {
  createLegacyMcpHandler,
  createMcpHandler,
  type CreateLegacyMcpHandlerOptions,
  type CreateMcpHandlerOptions,
  type CreateStatelessMcpHandlerOptions,
  type StatelessMcpHandler
} from "agents/mcp";

const highLevel = new McpServer({ name: "modern", version: "1.0.0" });
const lowLevel = new Server({ name: "modern-low", version: "1.0.0" });
const modernOptions: CreateStatelessMcpHandlerOptions = {
  legacy: "stateless",
  route: "/mcp",
  allowedOriginHostnames: ["client.example"]
};

const highLevelHandler: StatelessMcpHandler = createMcpHandler(
  () => highLevel,
  modernOptions
);
const lowLevelHandler: StatelessMcpHandler = createMcpHandler(() => lowLevel);
const factoryHandler: StatelessMcpHandler = createMcpHandler(
  () => new McpServer({ name: "factory", version: "1.0.0" })
);
void highLevelHandler;
void lowLevelHandler;
void factoryHandler;
void AgentsMcpServer;

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
