import type { Server } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";

/**
 * Inject the Cloudflare Worker-compatible JSON Schema validator into an MCP
 * server instance. The default Ajv validator uses `new Function()` which is
 * blocked in Workers. This replaces it with `@cfworker/json-schema` which
 * validates without code generation.
 *
 * Works with both `McpServer` (high-level) and `Server` (low-level).
 */
export function injectCfWorkerValidator(server: McpServer | Server): void {
  // McpServer wraps Server as .server; raw Server is the object itself
  const innerServer: Server =
    "server" in server && typeof (server as McpServer).server === "object"
      ? (server as McpServer).server
      : (server as Server);

  // _jsonSchemaValidator is private, but we need to override it to avoid
  // the Ajv "Code generation from strings disallowed" error in Workers.
  Object.defineProperty(innerServer, "_jsonSchemaValidator", {
    value: new CfWorkerJsonSchemaValidator(),
    writable: true,
    configurable: true
  });
}
