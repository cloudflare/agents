import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server as LegacyServer } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import {
  createLegacyMcpHandler,
  type CreateLegacyMcpHandlerOptions,
  type CreateMcpHandlerOptions,
  type LegacyMcpHandler
} from "./handler-legacy";
import {
  createStatelessMcpHandler,
  type CreateStatelessMcpHandlerOptions,
  type StatelessMcpHandler
} from "./handler-stateless";
import { warnLegacyCreateMcpHandlerOverload } from "./handler-warning";

/**
 * @deprecated Passing an SDK v1 server to createMcpHandler is deprecated and
 * removed in the next major version. Use createLegacyMcpHandler for an
 * explicit WorkerTransport handler, or pass an SDK v2 factory to
 * createMcpHandler.
 */
export function createMcpHandler(
  server: LegacyMcpServer | LegacyServer,
  options?: CreateMcpHandlerOptions
): LegacyMcpHandler;

export function createMcpHandler(
  factory: McpServerFactory,
  options?: CreateStatelessMcpHandlerOptions
): StatelessMcpHandler;

export function createMcpHandler(
  serverOrFactory: LegacyMcpServer | LegacyServer | McpServerFactory,
  options: CreateMcpHandlerOptions | CreateStatelessMcpHandlerOptions = {}
): LegacyMcpHandler | StatelessMcpHandler {
  if (typeof serverOrFactory === "function") {
    return createStatelessMcpHandler(
      serverOrFactory,
      options as CreateStatelessMcpHandlerOptions
    );
  }

  if (
    serverOrFactory instanceof LegacyMcpServer ||
    serverOrFactory instanceof LegacyServer
  ) {
    warnLegacyCreateMcpHandlerOverload();
    return createLegacyMcpHandler(
      serverOrFactory,
      options as CreateMcpHandlerOptions
    );
  }

  throw new TypeError(
    'createMcpHandler received an unsupported server. Pass a factory returning McpServer or Server from "@modelcontextprotocol/server", or use createLegacyMcpHandler with an MCP SDK v1 server.'
  );
}

let didWarnAboutExperimentalCreateMcpHandler = false;

/**
 * @deprecated Use createLegacyMcpHandler for an SDK v1 server.
 * experimental_createMcpHandler will be removed in the next major version.
 */
export function experimental_createMcpHandler(
  server: LegacyMcpServer | LegacyServer,
  options: CreateMcpHandlerOptions = {}
): LegacyMcpHandler {
  if (!didWarnAboutExperimentalCreateMcpHandler) {
    didWarnAboutExperimentalCreateMcpHandler = true;
    console.warn(
      "experimental_createMcpHandler is deprecated and will be removed in " +
        "the next major version. Use createLegacyMcpHandler for an MCP SDK " +
        "v1 server."
    );
  }
  return createLegacyMcpHandler(server, options);
}

export { createLegacyMcpHandler, type CreateLegacyMcpHandlerOptions };
export type {
  CreateMcpHandlerOptions,
  CreateStatelessMcpHandlerOptions,
  LegacyMcpHandler,
  StatelessMcpHandler
};
