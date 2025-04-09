import { SSEEdgeClientTransport } from "./sse-edge";

import {
  ToolListChangedNotificationSchema,
  type ClientCapabilities,
  type Resource,
  type Tool,
  type Prompt,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  type ListToolsResult,
  type ListResourcesResult,
  type ListPromptsResult,
  type ServerCapabilities,
  type ResourceTemplate,
  type ListResourceTemplatesResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";

export class MCPClientConnection {
  client: Client;
  connectionState:
    | "authenticating"
    | "connecting"
    | "ready"
    | "discovering"
    | "failed" = "connecting";
  instructions?: string;
  tools: Tool[] = [];
  prompts: Prompt[] = [];
  resources: Resource[] = [];
  resourceTemplates: ResourceTemplate[] = [];
  serverCapabilities: ServerCapabilities | undefined;

  constructor(
    public url: URL,
    private info: ConstructorParameters<typeof Client>[0],
    private options: {
      transport: SSEClientTransportOptions;
      client: ConstructorParameters<typeof Client>[1];
      capabilities: ClientCapabilities;
    } = { transport: {}, client: {}, capabilities: {} }
  ) {
    this.client = new Client(info, options.client);
    this.client.registerCapabilities(options.capabilities);
  }

  /**
   * Initialize a client connection
   *
   * @param code Optional OAuth code to initialize the connection with if auth hasn't been initialized
   * @returns
   */
  async init(code?: string, clientId?: string) {
    try {
      const transport = new SSEEdgeClientTransport(
        this.url,
        this.options.transport
      );
      if (code) {
        await transport.finishAuth(code);
      }
      await this.client.connect(transport);
      // biome-ignore lint/suspicious/noExplicitAny: allow for the error check here
    } catch (e: any) {
      if (e.toString().includes("Unauthorized")) {
        // unauthorized, we should wait for the user to authenticate
        this.connectionState = "authenticating";
        return;
      }
      this.connectionState = "failed";
      throw e;
    }

    this.connectionState = "discovering";

    this.serverCapabilities = await this.client.getServerCapabilities();
    if (!this.serverCapabilities) {
      throw new Error("The MCP Server failed to return server capabilities");
    }

    const [instructions, tools, resources, prompts, resourceTemplates] =
      await Promise.all([
        this.client.getInstructions(),
        this.registerTools(),
        this.registerResources(),
        this.registerPrompts(),
        this.registerResourceTemplates(),
      ]);

    this.instructions = instructions;
    this.tools = tools;
    this.resources = resources;
    this.prompts = prompts;
    this.resourceTemplates = resourceTemplates;

    this.connectionState = "ready";
  }

  /**
   * Notification handler registration
   */
  async registerTools(): Promise<Tool[]> {
    if (!this.serverCapabilities || !this.serverCapabilities.tools) {
      return [];
    }

    if (this.serverCapabilities.tools.listChanged) {
      this.client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async (_notification) => {
          this.tools = await this.fetchTools();
        }
      );
    }

    return this.fetchTools();
  }

  async registerResources(): Promise<Resource[]> {
    if (!this.serverCapabilities || !this.serverCapabilities.resources) {
      return [];
    }

    if (this.serverCapabilities.resources.listChanged) {
      this.client.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        async (_notification) => {
          this.resources = await this.fetchResources();
        }
      );
    }

    return this.fetchResources();
  }

  async registerPrompts(): Promise<Prompt[]> {
    if (!this.serverCapabilities || !this.serverCapabilities.prompts) {
      return [];
    }

    if (this.serverCapabilities.prompts.listChanged) {
      this.client.setNotificationHandler(
        PromptListChangedNotificationSchema,
        async (_notification) => {
          this.prompts = await this.fetchPrompts();
        }
      );
    }

    return this.fetchPrompts();
  }

  async registerResourceTemplates(): Promise<ResourceTemplate[]> {
    if (!this.serverCapabilities || !this.serverCapabilities.resources) {
      return [];
    }

    return this.fetchResourceTemplates();
  }

  async fetchTools() {
    let toolsAgg: Tool[] = [];
    let toolsResult: ListToolsResult = { tools: [] };
    do {
      toolsResult = await this.client.listTools({
        cursor: toolsResult.nextCursor,
      });
      toolsAgg = toolsAgg.concat(toolsResult.tools);
    } while (toolsResult.nextCursor);
    return toolsAgg;
  }

  async fetchResources() {
    let resourcesAgg: Resource[] = [];
    let resourcesResult: ListResourcesResult = { resources: [] };
    do {
      resourcesResult = await this.client.listResources({
        cursor: resourcesResult.nextCursor,
      });
      resourcesAgg = resourcesAgg.concat(resourcesResult.resources);
    } while (resourcesResult.nextCursor);
    return resourcesAgg;
  }

  async fetchPrompts() {
    let promptsAgg: Prompt[] = [];
    let promptsResult: ListPromptsResult = { prompts: [] };
    do {
      promptsResult = await this.client.listPrompts({
        cursor: promptsResult.nextCursor,
      });
      promptsAgg = promptsAgg.concat(promptsResult.prompts);
    } while (promptsResult.nextCursor);
    return promptsAgg;
  }

  async fetchResourceTemplates() {
    let templatesAgg: ResourceTemplate[] = [];
    let templatesResult: ListResourceTemplatesResult = {
      resourceTemplates: [],
    };
    do {
      templatesResult = await this.client.listResourceTemplates({
        cursor: templatesResult.nextCursor,
      });
      templatesAgg = templatesAgg.concat(templatesResult.resourceTemplates);
    } while (templatesResult.nextCursor);
    return templatesAgg;
  }
}
