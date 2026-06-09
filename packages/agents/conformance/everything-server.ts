import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  RequestId
} from "@modelcontextprotocol/sdk/types.js";
import {
  CompleteRequestSchema,
  CreateMessageResultSchema,
  ElicitResultSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import * as z from "zod";

/**
 * "Everything server" for MCP server conformance testing — implements the
 * full feature surface the @modelcontextprotocol/conformance server suite
 * exercises. Ported from the MCP TypeScript SDK's conformance server
 * (test/conformance/src/everythingServer.ts) to run on Workers.
 *
 * Used by both server variants under test (see worker.ts):
 *  - McpAgent
 *  - createMcpHandler + WorkerTransport inside an Agent
 */

// 1x1 red PNG pixel
const TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

// Minimal WAV file
const TEST_AUDIO_BASE64 =
  "UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAAB9AAACABAAZGF0YQIAAAA=";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type EverythingServerOptions = {
  /**
   * Closes the SSE stream for an in-flight request, when the hosting
   * transport supports it (WorkerTransport does, McpAgent's internal
   * transport does not). Used by test_reconnection (SEP-1699).
   */
  closeSSEStream?: (requestId: RequestId) => void;
};

export function createEverythingServer(
  options: EverythingServerOptions = {}
): McpServer {
  const mcpServer = new McpServer(
    {
      name: "agents-conformance-test-server",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {},
        completions: {}
      },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
    }
  );

  const resourceSubscriptions = new Set<string>();

  function sendLog(level: "info", message: string) {
    mcpServer.server
      .notification({
        method: "notifications/message",
        params: {
          level,
          logger: "agents-conformance-test-server",
          data: message
        }
      })
      .catch(() => {
        // Ignore error if no client is connected
      });
  }

  // ===== TOOLS =====

  mcpServer.registerTool(
    "test_simple_text",
    { description: "Tests simple text content response" },
    async (): Promise<CallToolResult> => {
      return {
        content: [
          { type: "text", text: "This is a simple text response for testing." }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "test_image_content",
    { description: "Tests image content response" },
    async (): Promise<CallToolResult> => {
      return {
        content: [
          { type: "image", data: TEST_IMAGE_BASE64, mimeType: "image/png" }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "test_audio_content",
    { description: "Tests audio content response" },
    async (): Promise<CallToolResult> => {
      return {
        content: [
          { type: "audio", data: TEST_AUDIO_BASE64, mimeType: "audio/wav" }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "test_embedded_resource",
    { description: "Tests embedded resource content response" },
    async (): Promise<CallToolResult> => {
      return {
        content: [
          {
            type: "resource",
            resource: {
              uri: "test://embedded-resource",
              mimeType: "text/plain",
              text: "This is an embedded resource content."
            }
          }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "test_multiple_content_types",
    {
      description:
        "Tests response with multiple content types (text, image, resource)"
    },
    async (): Promise<CallToolResult> => {
      return {
        content: [
          { type: "text", text: "Multiple content types test:" },
          { type: "image", data: TEST_IMAGE_BASE64, mimeType: "image/png" },
          {
            type: "resource",
            resource: {
              uri: "test://mixed-content-resource",
              mimeType: "application/json",
              text: JSON.stringify({ test: "data", value: 123 })
            }
          }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "test_tool_with_logging",
    {
      description: "Tests tool that emits log messages during execution",
      inputSchema: {}
    },
    async (_args, extra): Promise<CallToolResult> => {
      for (const message of [
        "Tool execution started",
        "Tool processing data",
        "Tool execution completed"
      ]) {
        await extra.sendNotification({
          method: "notifications/message",
          params: { level: "info", data: message }
        });
        await sleep(50);
      }
      return {
        content: [
          { type: "text", text: "Tool with logging executed successfully" }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "test_tool_with_progress",
    {
      description: "Tests tool that reports progress notifications",
      inputSchema: {}
    },
    async (_args, extra): Promise<CallToolResult> => {
      const progressToken = extra._meta?.progressToken ?? 0;
      for (const progress of [0, 50, 100]) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            total: 100,
            message: `Completed step ${progress} of ${100}`
          }
        });
        await sleep(50);
      }
      return {
        content: [{ type: "text", text: String(progressToken) }]
      };
    }
  );

  mcpServer.registerTool(
    "test_error_handling",
    { description: "Tests error response handling" },
    async (): Promise<CallToolResult> => {
      throw new Error("This tool intentionally returns an error for testing");
    }
  );

  // SEP-1699: closes the SSE stream mid-call so the client has to reconnect
  // to receive the result.
  mcpServer.registerTool(
    "test_reconnection",
    {
      description:
        "Tests SSE stream disconnection and client reconnection (SEP-1699). Server closes the stream mid-call and sends the result after the client reconnects.",
      inputSchema: {}
    },
    async (_args, extra): Promise<CallToolResult> => {
      if (options.closeSSEStream && extra.requestId !== undefined) {
        options.closeSSEStream(extra.requestId);
      }
      await sleep(100);
      return {
        content: [
          {
            type: "text",
            text: "Reconnection test completed successfully. If you received this, the client properly reconnected after stream closure."
          }
        ]
      };
    }
  );

  mcpServer.registerTool(
    "test_sampling",
    {
      description: "Tests server-initiated sampling (LLM completion request)",
      inputSchema: { prompt: z.string() }
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const result = (await extra.sendRequest(
          {
            method: "sampling/createMessage",
            params: {
              messages: [
                {
                  role: "user",
                  content: { type: "text", text: args.prompt }
                }
              ],
              maxTokens: 100
            }
          },
          CreateMessageResultSchema
        )) as {
          content?: { text?: string };
          message?: { content?: { text?: string } };
        };

        const modelResponse =
          result.content?.text ||
          result.message?.content?.text ||
          "No response";

        return {
          content: [{ type: "text", text: `LLM response: ${modelResponse}` }]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Sampling not supported or error: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );

  mcpServer.registerTool(
    "test_elicitation",
    {
      description: "Tests server-initiated elicitation (user input request)",
      inputSchema: {
        message: z.string().describe("The message to show the user")
      }
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const result = await extra.sendRequest(
          {
            method: "elicitation/create",
            params: {
              message: args.message,
              requestedSchema: {
                type: "object",
                properties: {
                  response: {
                    type: "string",
                    description: "User's response"
                  }
                },
                required: ["response"]
              }
            }
          },
          ElicitResultSchema
        );

        return {
          content: [
            {
              type: "text",
              text: `User response: action=${result.action}, content=${JSON.stringify(result.content || {})}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Elicitation not supported or error: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );

  // SEP-1034: elicitation with default values for all primitive types
  mcpServer.registerTool(
    "test_elicitation_sep1034_defaults",
    {
      description: "Tests elicitation with default values per SEP-1034",
      inputSchema: {}
    },
    async (_args, extra): Promise<CallToolResult> => {
      try {
        const result = await extra.sendRequest(
          {
            method: "elicitation/create",
            params: {
              message: "Please review and update the form fields with defaults",
              requestedSchema: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "User name",
                    default: "John Doe"
                  },
                  age: {
                    type: "integer",
                    description: "User age",
                    default: 30
                  },
                  score: {
                    type: "number",
                    description: "User score",
                    default: 95.5
                  },
                  status: {
                    type: "string",
                    description: "User status",
                    enum: ["active", "inactive", "pending"],
                    default: "active"
                  },
                  verified: {
                    type: "boolean",
                    description: "Verification status",
                    default: true
                  }
                },
                required: []
              }
            }
          },
          ElicitResultSchema
        );

        return {
          content: [
            {
              type: "text",
              text: `Elicitation completed: action=${result.action}, content=${JSON.stringify(result.content || {})}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Elicitation not supported or error: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );

  // SEP-1330: elicitation with enum schema improvements
  mcpServer.registerTool(
    "test_elicitation_sep1330_enums",
    {
      description:
        "Tests elicitation with enum schema improvements per SEP-1330",
      inputSchema: {}
    },
    async (_args, extra): Promise<CallToolResult> => {
      try {
        const result = await extra.sendRequest(
          {
            method: "elicitation/create",
            params: {
              message: "Please select options from the enum fields",
              requestedSchema: {
                type: "object",
                properties: {
                  untitledSingle: {
                    type: "string",
                    description: "Select one option",
                    enum: ["option1", "option2", "option3"]
                  },
                  titledSingle: {
                    type: "string",
                    description: "Select one option with titles",
                    oneOf: [
                      { const: "value1", title: "First Option" },
                      { const: "value2", title: "Second Option" },
                      { const: "value3", title: "Third Option" }
                    ]
                  },
                  legacyEnum: {
                    type: "string",
                    description: "Select one option (legacy)",
                    enum: ["opt1", "opt2", "opt3"],
                    enumNames: ["Option One", "Option Two", "Option Three"]
                  },
                  untitledMulti: {
                    type: "array",
                    description: "Select multiple options",
                    minItems: 1,
                    maxItems: 3,
                    items: {
                      type: "string",
                      enum: ["option1", "option2", "option3"]
                    }
                  },
                  titledMulti: {
                    type: "array",
                    description: "Select multiple options with titles",
                    minItems: 1,
                    maxItems: 3,
                    items: {
                      anyOf: [
                        { const: "value1", title: "First Choice" },
                        { const: "value2", title: "Second Choice" },
                        { const: "value3", title: "Third Choice" }
                      ]
                    }
                  }
                },
                required: []
              }
            }
          },
          ElicitResultSchema
        );

        return {
          content: [
            {
              type: "text",
              text: `Elicitation completed: action=${result.action}, content=${JSON.stringify(result.content || {})}`
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Elicitation not supported or error: ${error instanceof Error ? error.message : String(error)}`
            }
          ]
        };
      }
    }
  );

  // SEP-1613: JSON Schema 2020-12 conformance test tool
  mcpServer.registerTool(
    "json_schema_2020_12_tool",
    {
      description:
        "Tool with JSON Schema 2020-12 features for conformance testing (SEP-1613)",
      inputSchema: {
        name: z.string().optional(),
        address: z
          .object({
            street: z.string().optional(),
            city: z.string().optional()
          })
          .optional()
      }
    },
    async (args): Promise<CallToolResult> => {
      return {
        content: [
          {
            type: "text",
            text: `JSON Schema 2020-12 tool called with: ${JSON.stringify(args)}`
          }
        ]
      };
    }
  );

  // ===== RESOURCES =====

  mcpServer.registerResource(
    "static-text",
    "test://static-text",
    {
      title: "Static Text Resource",
      description: "A static text resource for testing",
      mimeType: "text/plain"
    },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: "test://static-text",
            mimeType: "text/plain",
            text: "This is the content of the static text resource."
          }
        ]
      };
    }
  );

  mcpServer.registerResource(
    "static-binary",
    "test://static-binary",
    {
      title: "Static Binary Resource",
      description: "A static binary resource (image) for testing",
      mimeType: "image/png"
    },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: "test://static-binary",
            mimeType: "image/png",
            blob: TEST_IMAGE_BASE64
          }
        ]
      };
    }
  );

  mcpServer.registerResource(
    "template",
    new ResourceTemplate("test://template/{id}/data", { list: undefined }),
    {
      title: "Resource Template",
      description: "A resource template with parameter substitution",
      mimeType: "application/json"
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const id = variables.id;
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify({
              id,
              templateTest: true,
              data: `Data for ID: ${id}`
            })
          }
        ]
      };
    }
  );

  mcpServer.registerResource(
    "watched-resource",
    "test://watched-resource",
    {
      title: "Watched Resource",
      description: "A watched resource for subscription testing",
      mimeType: "text/plain"
    },
    async (): Promise<ReadResourceResult> => {
      return {
        contents: [
          {
            uri: "test://watched-resource",
            mimeType: "text/plain",
            text: "Watched resource content"
          }
        ]
      };
    }
  );

  mcpServer.server.setRequestHandler(
    SubscribeRequestSchema,
    async (request) => {
      const uri = request.params.uri;
      resourceSubscriptions.add(uri);
      sendLog("info", `Subscribed to resource: ${uri}`);
      return {};
    }
  );

  mcpServer.server.setRequestHandler(
    UnsubscribeRequestSchema,
    async (request) => {
      const uri = request.params.uri;
      resourceSubscriptions.delete(uri);
      sendLog("info", `Unsubscribed from resource: ${uri}`);
      return {};
    }
  );

  // ===== PROMPTS =====

  mcpServer.registerPrompt(
    "test_simple_prompt",
    { description: "A simple prompt without arguments" },
    async (): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "This is a simple prompt for testing."
            }
          }
        ]
      };
    }
  );

  mcpServer.registerPrompt(
    "test_prompt_with_arguments",
    {
      description: "A prompt with required arguments",
      argsSchema: {
        arg1: z.string().describe("First test argument"),
        arg2: z.string().describe("Second test argument")
      }
    },
    async (args): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Prompt with arguments: arg1='${args.arg1}', arg2='${args.arg2}'`
            }
          }
        ]
      };
    }
  );

  mcpServer.registerPrompt(
    "test_prompt_with_embedded_resource",
    {
      description: "A prompt that includes an embedded resource",
      argsSchema: {
        resourceUri: z.string().describe("URI of the resource to embed")
      }
    },
    async (args): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "resource",
              resource: {
                uri: args.resourceUri,
                mimeType: "text/plain",
                text: "Embedded resource content for testing."
              }
            }
          },
          {
            role: "user",
            content: {
              type: "text",
              text: "Please process the embedded resource above."
            }
          }
        ]
      };
    }
  );

  mcpServer.registerPrompt(
    "test_prompt_with_image",
    { description: "A prompt that includes image content" },
    async (): Promise<GetPromptResult> => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "image",
              data: TEST_IMAGE_BASE64,
              mimeType: "image/png"
            }
          },
          {
            role: "user",
            content: { type: "text", text: "Please analyze the image above." }
          }
        ]
      };
    }
  );

  // ===== LOGGING =====

  mcpServer.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    sendLog("info", `Log level set to: ${request.params.level}`);
    return {};
  });

  // ===== COMPLETION =====

  mcpServer.server.setRequestHandler(CompleteRequestSchema, async () => {
    return {
      completion: {
        values: [],
        total: 0,
        hasMore: false
      }
    };
  });

  return mcpServer;
}
