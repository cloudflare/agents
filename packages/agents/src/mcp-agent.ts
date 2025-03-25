import {
  Server,
  type ServerOptions,
} from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { Agent } from "./index.ts";
import { HTTPServerTransport } from "./lib/http";

type MCPState = {
  config: [Implementation, ServerOptions];
};

export default abstract class MCPAgent<Env, State = unknown> extends Agent<
  Env,
  State & MCPState
> {
  messages!: WeakMap<Request, Response>;
  server!: Server;

  async onStart(): Promise<void> {
    this.messages = new WeakMap<Request, Response>();
    await this.initMCPServer();
  }

  /**
   * Initializes the MCP server instance using stored or newly created configuration.
   * This method is called during object construction and blocks concurrent access.
   */
  async initMCPServer() {
    const [impl, opts] =
      this.state?.config ?? (await this.createServerParams());

    this.server = new Server(impl, opts);
    this.configureServer(this.server);
  }

  /**
   * Creates a new HTTP transport instance for handling server communications.
   * @returns A promise that resolves to a new HTTPServerTransport instance
   */
  async createTransport(request: Request): Promise<Transport> {
    return new HTTPServerTransport({
      receive: () => request,
      transmit: (response: Response) => {
        this.messages.set(request, response);
      },
    });
  }

  /**
   * Abstract method that must be implemented by subclasses to provide server configuration.
   * @returns A tuple containing the server implementation and options, or a Promise of such
   */
  abstract createServerParams():
    | [Implementation, ServerOptions]
    | Promise<[Implementation, ServerOptions]>;

  /**
   * Abstract method that must be implemented by subclasses to configure the server instance.
   * Called after server initialization to set up any additional server configuration, e.g., handlers of incoming RPC calls.
   * @param server - The MCP server instance to configure
   */
  abstract configureServer(server: Server): void;

  async onMCPRequest(request: Request) {
    const transport = await this.createTransport(request);
    this.server.connect(transport);
    return await this.#transport(request);
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/mcp")) {
      return this.onMCPRequest(request);
    }
    return super.onRequest(request);
  }

  async #transport(request: Request, max = 100) {
    let tries = 0;
    while (!this.messages.has(request) && tries < max) {
      await new Promise((resolve) =>
        setTimeout(() => {
          ++tries;
          resolve(undefined);
        }, 0)
      );
    }
    const response = this.messages.get(request);
    if (!response) {
      return new Response("Server didn't respond in time", { status: 503 });
    }
    return response;
  }
}
