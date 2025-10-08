/**
 * Lazy loading utilities that work in both bundled and test environments
 */

let mcpClientModule: any;
let oauthProviderModule: any;

export function getMCPClientManager() {
  if (!mcpClientModule) {
    // Try multiple paths to support both test and production environments
    try {
      mcpClientModule = require("./mcp/client");
    } catch {
      try {
        mcpClientModule = require("./mcp/client.js");
      } catch {
        // Last resort: try absolute path (for tests)
        const path = __dirname + "/mcp/client";
        mcpClientModule = require(path);
      }
    }
  }
  return mcpClientModule.MCPClientManager;
}

export function getDurableObjectOAuthClientProvider() {
  if (!oauthProviderModule) {
    try {
      oauthProviderModule = require("./mcp/do-oauth-client-provider");
    } catch {
      try {
        oauthProviderModule = require("./mcp/do-oauth-client-provider.js");
      } catch {
        const path = __dirname + "/mcp/do-oauth-client-provider";
        oauthProviderModule = require(path);
      }
    }
  }
  return oauthProviderModule.DurableObjectOAuthClientProvider;
}
