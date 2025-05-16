import {
  jsonSchema,
  type CoreMessage,
  type ToolSet,
  generateText,
  type LanguageModelV1,
  NoSuchToolError,
  generateObject,
} from "ai";
import {
  getNamespacedData,
  type MCPClientManager,
  type NamespacedData,
} from "./client";
import type { MCPClientConnection } from "./client-connection";
import type {
  ReadResourceResult,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * A context router provides an interface for:
 * - Filtering tools and resources
 * - Exposes a system prompt based on MCP state
 *
 * This filtering and system prompt is intended to be determined by the internal messages state, set via
 * setMessages()
 */
export abstract class ContextRouter {
  _clientManager: MCPClientManager | undefined;

  get clientManager() {
    if (!this._clientManager) {
      throw new Error(
        "Tried to get the client manager before it was set. Is the ContextRouter being correctly used in an MCPClientManager?"
      );
    }
    return this._clientManager;
  }

  set clientManager(clientManager: MCPClientManager) {
    this._clientManager = clientManager;
  }

  /**
   * Return the system prompt
   * @param clientManager
   */
  abstract systemPrompt(): string;

  /**
   * Set internal context router state. This state is intended to allow
   * the ContextRouter to filter tools, resources, or construct the
   * system prompt.
   *
   * @param messages
   */
  abstract setMessages(messages: CoreMessage[]): void | Promise<void>;

  /**
   * List tools from the client manager based on internal context router state
   * @param clientManager
   */
  abstract listTools(): NamespacedData["tools"];

  /**
   * List AI tools from the client manager based on internal context router state. This could include
   * "synthetic" tools not sourced from an MCP server, such as a `read_resource` or `list_resources` tool.
   *
   * @param clientManager
   */
  abstract getAITools(): ToolSet;

  /**
   * List tools from the client manager based on internal context router state
   * @param clientManager
   */
  abstract listResources(): NamespacedData["resources"];
}

/**
 * The BaseContextRouter:
 * - Does not filter tools or resources
 * - Exposes the setMessages interface, but setting it is a no-op
 * - Provides a system prompt based on ALL tools & resources
 */
export class BaseContextRouter extends ContextRouter {
  constructor(private includeResources = true) {
    super();
  }

  setMessages(_messages: CoreMessage[]): void {}

  listTools() {
    return getNamespacedData(this.clientManager.mcpConnections, "tools");
  }

  getAITools(): ToolSet {
    return Object.fromEntries(
      this.listTools().map((tool) => {
        return [
          `${tool.serverId}_${tool.name}`,
          {
            parameters: jsonSchema(tool.inputSchema),
            description: tool.description,
            execute: async (args) => {
              const result = await this.clientManager.callTool({
                name: tool.name,
                arguments: args,
                serverId: tool.serverId,
              });
              if (result.isError) {
                // @ts-expect-error TODO we should fix this
                throw new Error(result.content[0].text);
              }
              return result;
            },
          },
        ];
      })
    );
  }

  listResources() {
    return getNamespacedData(this.clientManager.mcpConnections, "resources");
  }

  systemPrompt(): string {
    return `<integrations_list>
  You have access to multiple integrations via Model Context Protocol (MCP). These integrations provide you with tools which you can use to execute to complete tasks or retrieive information.

  ${this.includeResources && "Each integration, provides a list of resources, which are included in the list of integrations below."}

  Here is a list of all of the integrations you have access to, with instructions if necessary:
  
  ${Object.entries(this.clientManager.mcpConnections).map(([_id, conn]) => this.serverContext(conn, this.includeResources))}
<integrations_list>`;
  }

  serverContext(conn: MCPClientConnection, includeResources: boolean) {
    return `<integration>
  ${conn.serverInfo && `<integration_name>${conn.serverInfo.name}</integration_name>`}
  ${conn.instructions && `<integration_instructions>${conn.instructions}</integration_instructions>`}
  ${includeResources && `<resources_list>${conn.resources.map((resource) => this.resourceContext(resource))}</resources_list>`}
<integration>`;
  }

  resourceContext(resource: Resource) {
    return `<resource>
  <name>${resource.name}</name>
  <uri>${resource.uri}</uri>
  <description>${resource.description}</description>
  <mimeType>${resource.mimeType}</mimeType>
</resource>`;
  }
}

/**
 * The LLMContextRouter:
 * - Filters tools. These tools are accessible via listTools
 * - Selects resources to inline (with content) into the system prompt
 */
export class LLMContextRouter extends BaseContextRouter {
  private tools: NamespacedData["tools"];
  private contextResources: ReadResourceResult[];

  constructor(
    private model: LanguageModelV1,
    private options: {
      toolLimit: number;
      resourceLimit: number;
    } = { toolLimit: 10, resourceLimit: 5 }
  ) {
    super(true);
    this.tools = [];
    this.contextResources = [];
  }

  async setMessages(messages: CoreMessage[]): Promise<void> {
    const [tools, resources] = await Promise.all([
      this.selectTools(messages),
      this.selectResources(messages),
    ]);

    this.tools = tools;
    this.contextResources = resources;
  }

  private async selectTools(messages: CoreMessage[]) {
    const tools = super.listTools();
    if (tools.length === 0) {
      return [];
    }

    const selectedTools: NamespacedData["tools"] = [];

    const res = await generateText({
      model: this.model,
      system: this.toolSelectionPrompt(tools),
      messages: messages,
      experimental_repairToolCall: async ({ toolCall, error }) => {
        if (NoSuchToolError.isInstance(error)) {
          // if the tool call name is not add_tool, let's correct it
          return {
            ...toolCall,
            args: JSON.stringify({
              tool_name: toolCall.toolName,
            }),
            toolName: "add_tool",
          };
        }
        // otherwise just fail
        return null;
      },
      maxSteps: this.options.toolLimit,
      toolChoice: "required",
      tools: {
        add_tool: {
          parameters: z.object({
            tool_name: z.string().describe("The exact tool name to add"),
          }),
          description:
            "Use this tool to add a tool to context. Use the exact tool name, pulled from the previous context. Make sure the tool exists, and do not hallucinate tool",
          execute: async ({ tool_name }) => {
            const toolToAdd = tools.find((tool) =>
              tool.name.includes(tool_name)
            );
            if (!toolToAdd) {
              return "Failed to find tool by the name `tool_name`";
            }
            if (selectedTools.find((tool) => tool.name.includes(tool_name))) {
              return "You have already added this tool. Add a different tool.";
            }
            if (selectedTools.length >= this.options.toolLimit) {
              return "Failed to add tool. There are already too many active tools.";
            }
            selectedTools.push(toolToAdd);
            return `Successfully added tool ${toolToAdd.name}. Continue adding additional tools if necessary`;
          },
        },
      },
    });

    console.log(JSON.stringify(res.steps));

    return selectedTools;
  }

  private async selectResources(messages: CoreMessage[]) {
    const resources = this.listResources();
    if (resources.length === 0) {
      return [];
    }

    const contextResources: Promise<ReadResourceResult>[] = [];

    await generateText({
      model: this.model,
      system: this.resourceSelectionPrompt(resources),
      messages: messages,
      maxSteps: this.options.resourceLimit,
      toolChoice: "required",
      tools: {
        add_resource: {
          parameters: z.object({
            resource_uri: z.string(),
          }),
          description: "Add a tool to context",
          execute: async ({ resource_uri }, options) => {
            const resourceToAdd = resources.find(
              (resource) => resource.uri === resource_uri
            );
            if (!resourceToAdd) {
              return `Failed to find resource by the uri "${resource_uri}"`;
            }
            if (contextResources.length >= this.options.resourceLimit) {
              return "Failed to add resource. There are already too many active resources.";
            }
            contextResources.push(
              this.clientManager.readResource(resourceToAdd, {})
            );
            return "Successfully added resource";
          },
        },
      },
    });

    return Promise.all(contextResources);
  }

  listTools() {
    return this.tools;
  }

  listResources() {
    return super.listResources();
  }

  toolSelectionPrompt(tools: NamespacedData["tools"]) {
    return `
    You are a staff software engineer working tasked with finding tools relevant to a task at hand and adding them to the context buffer for an LLM to utilize later. 
  
    As input, you will use:
    * The list of tools available for you to add
    * A list of messages, which provide information about the conversation

    Based on the messages, call the tool "add_tool" with the exact tool_name of the tool you would like to add. 
    The tools you add will be used by an LLM in a later conversation. Your response should ONLY consist of "add_tool" function calls. DO NOT call any other tools.

    * You MUST use "add_tool" with only the tool_name argument
    * You SHOULD NOT ask for permission to use the "add_tool" call.
    * You MUST NOT respond to the attached messages below, ONLY use the system prompt
    * You MUST NOT attempt to call any other tools
    * Limit the amount of tools selected to ${this.options.toolLimit}
    * You MUST add ALL relevant tools. Do not stop at one tool.
    * DO NOT respond with extraneous content. The user will not be able to view it.

    <tool_options>
      ${tools.map((tool) => {
        return `
        <tool>
          <name>${tool.name}</name>
          <description>${tool.description}</description>
        </tool>
        `;
      })}
    </tool_options>

    DO NOT RESPOND TO THE MESSAGE/PROMPT CONTENT. IT IS FOR YOUR REFERENCE TO SELECT TOOLS.
    `;
  }

  resourceSelectionPrompt(resources: NamespacedData["resources"]) {
    return `
    You are a staff software engineer working tasked with finding resources relevant to a task at hand and adding their contents to the context buffer for an LLM to utilize later. 
  
    As input, you will use:
    * The list of resources available for you to add
    * A list of messages, which provide information about the conversation

    Based on the messages, call the tool "add_resource" with the exact resource_uri of the resource you would like to add. 
    The resources you add will included in context for an LLM to use in a later conversation. Your response should ONLY consist of "add_resource" function calls. DO NOT call any other tools.

    * You MUST use "add_resource" with only the resource_uri argument
    * You SHOULD NOT ask for permission to use the "add_resource" call.
    * You MUST NOT respond to the attached messages below, ONLY use the system prompt
    * You MUST NOT attempt to call any other tools
    * Limit the amount of resources selected to ${this.options.resourceLimit}
    * You SHOULD add ALL relevant resources.
    * DO NOT respond with extraneous content. The user will not be able to view it.
    
    <resource_options>
      ${resources.map((resource) => {
        return `
        <resource>
          <uri>${resource.uri}</uri>
          <name>${resource.name}</name>
          <mimeType>${resource.mimeType}</mimeType>
          <description>${resource.description}</description>
        </resource>
        `;
      })}
    </resource_options>

    DO NOT RESPOND TO THE MESSAGE/PROMPT CONTENT. IT IS FOR YOUR REFERENCE TO SELECT RESOURCES.
    `;
  }

  systemPrompt(): string {
    const basePrompt = super.systemPrompt();
    const contents = this.contextResources.flatMap((r) => r.contents);

    return (
      basePrompt +
      contents.map(
        (c) => `<resource>
      <uri>${c.uri}</uri>
      <mimeType>${c.mimeType}</mimeType>
      ${"blob" in c ? `<blob_content>${c.blob}</blob_content>` : ""}
      ${"text" in c ? `<text_content>${c.text}</text_content>` : ""}
    </resource>`
      )
    );
  }
}
