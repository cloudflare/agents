import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server as LegacyServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  McpServer,
  Server,
  type McpServerFactory
} from "@modelcontextprotocol/server";
import {
  createLegacyMcpHandler,
  type CreateMcpHandlerOptions
} from "./handler-legacy";
import {
  createStatelessMcpHandler,
  type CreateStatelessMcpHandlerOptions,
  type StatelessMcpHandler
} from "./handler-stateless";
import { warnLegacyHandlerCompatibility } from "./handler-warning";

export type LegacyMcpHandler = ReturnType<typeof createLegacyMcpHandler>;

/**
 * @deprecated This server comes from MCP SDK v1 and runs in legacy handler
 * compatibility mode. Import McpServer or Server from
 * "@modelcontextprotocol/server" to receive new MCP protocol features.
 * Removed in the next major version.
 */
export function createMcpHandler(
  server: LegacyMcpServer | LegacyServer,
  options?: CreateMcpHandlerOptions
): LegacyMcpHandler;

export function createMcpHandler(
  serverOrFactory: McpServer | Server | McpServerFactory,
  options?: CreateStatelessMcpHandlerOptions
): StatelessMcpHandler;

export function createMcpHandler(
  serverOrFactory:
    | LegacyMcpServer
    | LegacyServer
    | McpServer
    | Server
    | McpServerFactory,
  options: CreateMcpHandlerOptions | CreateStatelessMcpHandlerOptions = {}
): LegacyMcpHandler | StatelessMcpHandler {
  if (typeof serverOrFactory === "function") {
    return createStatelessMcpHandler(
      serverOrFactory,
      options as CreateStatelessMcpHandlerOptions
    );
  }

  if (
    serverOrFactory instanceof McpServer ||
    serverOrFactory instanceof Server
  ) {
    return createStatelessMcpHandler(
      serverOrFactory,
      options as CreateStatelessMcpHandlerOptions
    );
  }

  if (
    serverOrFactory instanceof LegacyMcpServer ||
    serverOrFactory instanceof LegacyServer
  ) {
    warnLegacyHandlerCompatibility();
    return createLegacyMcpHandler(
      serverOrFactory,
      options as CreateMcpHandlerOptions
    );
  }

  throw new TypeError(
    'createMcpHandler received an unsupported server. Import McpServer or Server from "@modelcontextprotocol/server", or pass an existing MCP SDK v1 server while compatibility mode is available.'
  );
}

let didWarnAboutExperimentalCreateMcpHandler = false;

/**
 * @deprecated This has been renamed to createMcpHandler, and experimental_createMcpHandler will be removed in the next major version
 */
export function experimental_createMcpHandler(
  server: LegacyMcpServer | LegacyServer,
  options: CreateMcpHandlerOptions = {}
): LegacyMcpHandler {
  if (!didWarnAboutExperimentalCreateMcpHandler) {
    didWarnAboutExperimentalCreateMcpHandler = true;
    console.warn(
      "experimental_createMcpHandler is deprecated, use createMcpHandler instead. experimental_createMcpHandler will be removed in the next major version."
    );
  }
  return createMcpHandler(server, options);
}

export type {
  CreateMcpHandlerOptions,
  CreateStatelessMcpHandlerOptions,
  StatelessMcpHandler
};
