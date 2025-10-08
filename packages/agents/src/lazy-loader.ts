import type { MCPClientManager } from "./mcp/client";
import type { DurableObjectOAuthClientProvider } from "./mcp/do-oauth-client-provider";

let mcpClientModule: { MCPClientManager: typeof MCPClientManager } | undefined;
let oauthProviderModule:
  | {
      DurableObjectOAuthClientProvider: typeof DurableObjectOAuthClientProvider;
    }
  | undefined;

export function getMCPClientManager() {
  if (!mcpClientModule) {
    try {
      mcpClientModule = require("./mcp/client");
    } catch {
      try {
        mcpClientModule = require("./mcp/client.js");
      } catch {
        const path = `${__dirname}/mcp/client`;
        mcpClientModule = require(path);
      }
    }
  }
  return mcpClientModule!.MCPClientManager;
}

export function getDurableObjectOAuthClientProvider() {
  if (!oauthProviderModule) {
    try {
      oauthProviderModule = require("./mcp/do-oauth-client-provider");
    } catch {
      try {
        oauthProviderModule = require("./mcp/do-oauth-client-provider.js");
      } catch {
        const path = `${__dirname}/mcp/do-oauth-client-provider`;
        oauthProviderModule = require(path);
      }
    }
  }
  return oauthProviderModule!.DurableObjectOAuthClientProvider;
}
