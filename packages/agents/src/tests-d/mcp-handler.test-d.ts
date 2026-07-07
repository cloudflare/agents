import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer, Server } from "@modelcontextprotocol/server";
// @ts-expect-error v2 constructors are imported directly from @modelcontextprotocol/server.
import { McpServer as AgentsMcpServer } from "agents/mcp";
import {
  createMcpHandler,
  type CreateMcpHandlerOptions,
  type CreateStatelessMcpHandlerOptions,
  type StatelessMcpHandler
} from "agents/mcp";

const highLevel = new McpServer({ name: "modern", version: "1.0.0" });
const lowLevel = new Server({ name: "modern-low", version: "1.0.0" });
const modernOptions: CreateStatelessMcpHandlerOptions = {
  legacy: "stateless",
  route: "/mcp"
};

const highLevelHandler: StatelessMcpHandler = createMcpHandler(
  highLevel,
  modernOptions
);
const lowLevelHandler: StatelessMcpHandler = createMcpHandler(lowLevel);
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
createMcpHandler(
  new LegacyMcpServer({ name: "legacy", version: "1.0.0" }),
  legacyOptions
);

createMcpHandler(
  // @ts-expect-error v1 factories are not a supported compatibility input.
  () => new LegacyMcpServer({ name: "legacy", version: "1.0.0" })
);

// @ts-expect-error v1 transport options are not valid for a v2 server.
createMcpHandler(highLevel, { transport: {} });
